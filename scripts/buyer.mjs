import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "dotenv";
import { createAccount, createClient, encodeInternalMessageFeeParams, isSuccessful, MessageType } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { TransactionHashVariant, transactionsStatusNumberToName } from "genlayer-js/types";
import JSONbig from "json-bigint";
import { getAddress } from "viem";
import { createPublicFetcher } from "../api/http-safety.mjs";
import { createBuyerWorkflow, validateBuyerPlan } from "../sdk/buyer.mjs";
import { createFileJournal } from "../sdk/file-journal.mjs";
import { deploymentScope } from "../sdk/protocol.mjs";

const root = resolve(import.meta.dirname, "..");
config({ path: resolve(root, ".env"), quiet: true });
const args = process.argv.slice(2);
const inputPath = args.shift();
if (!inputPath || args.some((arg) => !["--run", "--once"].includes(arg))) throw new Error("Usage: npm run buyer -- plan.json [--run] [--once]. Without --run this only validates the plan.");
if ((await stat(resolve(inputPath))).size > 100_000) throw new Error("Buyer plan exceeds size limit");
const plan = validateBuyerPlan(JSON.parse(await readFile(resolve(inputPath), "utf8")));
if (plan.chainId !== 61997) throw new Error("This CLI supports only the configured Studio Dev chain 61997");
console.log(JSON.stringify({ mode: args.includes("--run") ? "execute" : "dry-run", runId: plan.runId, chainId: plan.chainId,
  contractAddress: plan.contractAddress, buyer: plan.buyer, capabilityIds: plan.capabilityIds,
  maxSpendWei: plan.maxSpendWei, maxFeeWei: plan.maxFeeWei, maxTransactions: plan.maxTransactions,
  disclosure: "Full request and output become public. Budgets are per journal, not wallet-wide." }));

if (args.includes("--run")) {
  const key = process.env.BUYER_PRIVATE_KEY?.trim();
  if (!/^0x[0-9a-f]{64}$/i.test(key ?? "")) throw new Error("BUYER_PRIVATE_KEY must be configured locally before execution");
  const account = createAccount(key);
  if (account.address.toLowerCase() !== plan.buyer) throw new Error("BUYER_PRIVATE_KEY does not match the authorized buyer");
  const endpoint = process.env.STUDIO_DEV_RPC?.trim() || "https://studio-dev.genlayer.com/api";
  const client = createClient({ chain: studioDevnet, endpoint, account });
  const contractAddress = getAddress(plan.contractAddress);
  if (Number(await client.getChainId()) !== plan.chainId) throw new Error("RPC chain does not match the authorized plan");
  const schema = await client.getContractSchema(contractAddress);
  if (!["accept_job", "recover_job", "get_jobs_page"].every((method) => Object.hasOwn(schema.methods ?? {}, method))) throw new Error("The selected contract is not compatible with protocol v2");
  const directory = resolve(root, ".runtime/buyer");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const keyPath = resolve(directory, "journal.key");
  try { await writeFile(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  if ((await stat(keyPath)).mode & 0o077) throw new Error("Journal key permissions must exclude group/other access");
  const scope = `${deploymentScope(plan.chainId, plan.contractAddress)}-${plan.buyer}-${plan.runId}`;
  const journal = createFileJournal(resolve(directory, `${scope}.json`), await readFile(keyPath), scope);
  const parser = JSONbig({ storeAsString: true });
  const publicPost = createPublicFetcher({ allowPost: true });
  const transport = {
    read: async (functionName, callArgs) => {
      const value = await client.readContract({ address: contractAddress, functionName, args: callArgs, jsonSafeReturn: true,
        transactionHashVariant: TransactionHashVariant.LATEST_FINAL });
      return typeof value === "string" ? parser.parse(value) : value;
    },
    estimate: async ({ method, args: callArgs, value, recipients }) => {
      const unique = [...new Set(recipients.map((recipient) => recipient.toLowerCase()))];
      const messageAllocations = unique.map((recipient) => ({ messageType: MessageType.Internal, onAcceptance: false, recipient,
        callKey: `0x${"00".repeat(32)}`, budget: 150000000000000000n,
        feeParams: encodeInternalMessageFeeParams({ leaderTimeunitsAllocation: 100n, validatorTimeunitsAllocation: 200n,
          appealRounds: 0n, executionBudgetPerRound: 25000000000000000n, rotations: [3n], maxPriceGenPerTimeUnit: 2n,
          storageFeeMaxGasPrice: 300000000n, receiptFeeMaxGasPrice: 300000000n }) }));
      const options = unique.length ? { messageAllocations, totalMessageFees: 150000000000000000n * BigInt(unique.length) } : {};
      const fees = await client.estimateTransactionFeesForWrite({ address: contractAddress, functionName: method,
        args: callArgs, value: BigInt(value), leaderOnly: false, ...options });
      return { feeWei: String(fees.feeValue), fees };
    },
    send: async ({ method, args: callArgs, value, estimate }) => String(await client.writeContract({
      address: contractAddress, functionName: method, args: callArgs, value: BigInt(value),
      fees: { distribution: estimate.fees.distribution, messageAllocations: estimate.fees.messageAllocations, feeValue: estimate.fees.feeValue },
    })),
    transaction: async (hash) => {
      const transaction = await client.getTransaction({ hash });
      return { hash: transaction.hash ?? transaction.txId ?? hash,
        sender: transaction.sender ?? transaction.from_address, recipient: transaction.recipient ?? transaction.to_address,
        status: transaction.statusName ?? transactionsStatusNumberToName[String(transaction.status)] ?? String(transaction.status),
        successful: isSuccessful(transaction) };
    },
    execute: async ({ capability, job, request, nonce }) => {
      const response = await publicPost(capability.endpoint, { method: "POST", headers: {
        "Content-Type": "application/json", "x-recourse-job-id": job.job_id, "x-recourse-request-hash": job.request_hash,
        "x-recourse-request-label": job.request_label, "x-recourse-capability-id": job.capability_id, "x-recourse-request-nonce": nonce,
      }, body: JSON.stringify({ capability_id: job.capability_id, request_label: job.request_label, nonce, request }) }, 30_000);
      if (!response.ok) throw new Error("Provider execution did not acknowledge the job; waiting for onchain recovery");
    },
  };
  const workflow = createBuyerWorkflow({ plan, journal, transport });
  const deadline = Date.now() + 3_600_000;
  let report;
  do {
    report = await workflow.step();
    const { result, ...summary } = report;
    console.log(JSON.stringify({ ...summary, resultAvailable: result !== null }));
    if (report.status !== "running" || args.includes("--once")) break;
    if (Date.now() >= deadline) { console.log("Run time limit reached; resume this same plan/journal. No pending write is replayed."); break; }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 15_000));
  } while (Date.now() < deadline);
  if (report.status !== "completed" && !args.includes("--once")) process.exitCode = 2;
}
