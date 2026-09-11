#!/usr/bin/env node

import dns from "node:dns";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { config } from "dotenv";
import {
  createAccount,
  createClient,
  encodeInternalMessageFeeParams,
  generatePrivateKey,
  isSuccessful,
  MessageType,
} from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
config({ path: resolve(root, ".env"), quiet: true });

const EXPECTED_CHAIN_ID = 61997;
const RPC = process.env.STUDIO_DEV_RPC?.trim() || "https://studio-dev.genlayer.com/api";
const DEPLOYER_KEY = process.env.DEPLOYER_KEY?.trim();
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY?.trim() || "dotmantissa/recourse";
const PUBLIC_EVIDENCE_BASE =
  process.env.PUBLIC_EVIDENCE_BASE?.trim() ||
  `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/main/evidence`;
const DEMO_PRICE = BigInt(process.env.DEMO_PRICE_WEI?.trim() || "10000000000000000");
const DEMO_FUNDING_RESERVE = 10000000000000000n;
const INTERNAL_TRANSFER_BUDGET = 150000000000000000n;
const DEMO_DIR = resolve(root, ".demo");
const BUYER_KEY_PATH = resolve(DEMO_DIR, "buyer-key");
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

const originalLookup = dns.lookup.bind(dns);
dns.lookup = (hostname, options, callback) => {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  return originalLookup(hostname, { ...options, family: 4 }, callback);
};

function requireKey(name, value) {
  if (!value || !KEY_RE.test(value)) {
    throw new Error(`${name} must be a 32-byte private key`);
  }
  return value;
}

function parseJson(value, label) {
  try {
    return JSON.parse(String(value));
  } catch {
    throw new Error(`${label} was not valid JSON: ${String(value)}`);
  }
}

function canonicalJson(value) {
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key]]),
    ),
  );
}

async function loadBuyerKey() {
  const configured = process.env.DEMO_BUYER_KEY?.trim();
  if (configured) return requireKey("DEMO_BUYER_KEY", configured);
  try {
    return requireKey("stored demo buyer key", (await readFile(BUYER_KEY_PATH, "utf8")).trim());
  } catch {}
  const generated = generatePrivateKey();
  await mkdir(DEMO_DIR, { recursive: true });
  await writeFile(BUYER_KEY_PATH, `${generated}\n`, { mode: 0o600 });
  await chmod(BUYER_KEY_PATH, 0o600);
  return generated;
}

async function publishPublicEvidence(fileName, body) {
  const content = Buffer.from(`${JSON.stringify(body, null, 2)}\n`).toString("base64");
  const apiPath = `repos/${GITHUB_REPOSITORY}/contents/evidence/${fileName}`;
  let existingSha = "";
  try {
    const existing = await execFileAsync("gh", ["api", apiPath]);
    existingSha = String(JSON.parse(existing.stdout).sha || "");
  } catch {}
  const fields = [
    "api",
    apiPath,
    "--method",
    "PUT",
    "--field",
    `message=Publish Recourse demo evidence ${fileName}`,
    "--field",
    `content=${content}`,
  ];
  if (existingSha) fields.push("--field", `sha=${existingSha}`);
  await execFileAsync("gh", fields);
  const url = `${PUBLIC_EVIDENCE_BASE}/${encodeURIComponent(fileName)}`;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await fetch(url, { cache: "no-store" });
    if (response.ok) return url;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2500));
  }
  throw new Error(`Public evidence check failed after publication: ${url}`);
}

async function fundNative(client, sender, recipient, value) {
  const nonce = await client.getCurrentNonce({
    address: sender.address,
    block: "pending",
  });
  const transaction = {
    account: sender,
    to: recipient,
    value,
    type: "legacy",
    nonce,
    gas: 21000n,
    gasPrice: 0n,
    chainId: EXPECTED_CHAIN_ID,
  };
  const serialized = await sender.signTransaction(transaction);
  const hash = await client.sendRawTransaction({ serializedTransaction: serialized });
  const receipt = await client.waitForTransactionReceipt({
    hash,
    waitUntil: "finalized",
    interval: 3000,
    retries: 240,
    fullTransaction: true,
  });
  if (String(receipt.statusName || receipt.status).toLowerCase() === "reverted") {
    throw new Error(`Buyer funding finalized with execution failure: ${JSON.stringify(receipt)}`);
  }
}

async function main() {
  const addresses = parseJson(
    await readFile(resolve(root, "deploy/addresses.json"), "utf8"),
    "deploy/addresses.json",
  );
  if (!ADDRESS_RE.test(addresses.contractAddress)) {
    throw new Error("deploy/addresses.json does not contain a contract address");
  }
  const providerKey = requireKey("DEPLOYER_KEY", DEPLOYER_KEY);
  const buyerKey = await loadBuyerKey();
  const provider = createAccount(providerKey);
  const buyer = createAccount(buyerKey);
  if (provider.address.toLowerCase() === buyer.address.toLowerCase()) {
    throw new Error("Provider and buyer must use different accounts");
  }

  const client = createClient({
    chain: studioDevnet,
    endpoint: RPC,
    account: provider,
  });
  const chainId = Number(await client.getChainId());
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`Refusing demo on chain ${chainId}; expected ${EXPECTED_CHAIN_ID}`);
  }

  const internalTransferFeeParams = encodeInternalMessageFeeParams({
    leaderTimeunitsAllocation: 100n,
    validatorTimeunitsAllocation: 200n,
    appealRounds: 0n,
    executionBudgetPerRound: 25000000000000000n,
    rotations: [3n],
    maxPriceGenPerTimeUnit: 2n,
    storageFeeMaxGasPrice: 300000000n,
    receiptFeeMaxGasPrice: 300000000n,
  });
  const transferAllocations = (recipients) =>
    [...new Set(recipients.map((recipient) => recipient.toLowerCase()))].map(
      (recipient) => ({
        messageType: MessageType.Internal,
        onAcceptance: false,
        recipient,
        callKey: "0x0000000000000000000000000000000000000000000000000000000000000000",
        budget: INTERNAL_TRANSFER_BUDGET,
        feeParams: internalTransferFeeParams,
      }),
    );
  const write = async (
    account,
    functionName,
    args = [],
    value = 0n,
    messageRecipients = [],
  ) => {
    const messageAllocations = transferAllocations(messageRecipients);
    const feeOptions =
      messageAllocations.length > 0
        ? {
            totalMessageFees:
              INTERNAL_TRANSFER_BUDGET * BigInt(messageAllocations.length),
            messageAllocations,
          }
        : {};
    let estimate;
    try {
      estimate = await client.estimateTransactionFeesForWrite({
        account,
        address: addresses.contractAddress,
        functionName,
        args,
        value,
        leaderOnly: false,
        ...feeOptions,
      });
    } catch {
      console.warn(
        `${functionName}: per-write fee simulation unavailable; using generic Studio fee preset`,
      );
      estimate = await client.estimateTransactionFees(feeOptions);
    }
    const hash = await client.writeContract({
      account,
      address: addresses.contractAddress,
      functionName,
      args,
      value,
      leaderOnly: false,
      fees: {
        distribution: estimate.distribution,
        messageAllocations: estimate.messageAllocations,
        feeValue: estimate.feeValue,
      },
    });
    const receipt = await client.waitForTransactionReceipt({
      hash,
      waitUntil: "finalized",
      interval: 3000,
      retries: 240,
      fullTransaction: true,
    });
    if (!isSuccessful(receipt)) {
      throw new Error(
        `${functionName} finalized with execution failure: ${JSON.stringify(receipt)}`,
      );
    }
    return { hash, receipt };
  };
  const readJson = async (functionName, args = []) =>
    parseJson(
      await client.readContract({
        address: addresses.contractAddress,
        functionName,
        args,
        jsonSafeReturn: true,
      }),
      functionName,
    );
  const nextId = async (field) => Number((await readJson("get_counts"))[field]) + 1;

  const providerBalance = await client.getBalance({ address: provider.address });
  const buyerBalance = await client.getBalance({ address: buyer.address });
  const maxPayoutFee = await client.estimateTransactionFees({
    totalMessageFees: INTERNAL_TRANSFER_BUDGET * 2n,
    messageAllocations: transferAllocations([buyer.address, provider.address]),
  });
  const minimumBuyerBalance =
    DEMO_PRICE * 2n + maxPayoutFee.feeValue + DEMO_FUNDING_RESERVE;
  if (buyerBalance < minimumBuyerBalance) {
    const fundingAmount = minimumBuyerBalance - buyerBalance;
    console.log(`Funding demo buyer with ${fundingAmount} wei`);
    await fundNative(client, provider, buyer.address, fundingAmount);
  }
  const fundedBuyerBalance = await client.getBalance({ address: buyer.address });
  if (fundedBuyerBalance < minimumBuyerBalance) {
    throw new Error("Buyer account does not have enough GEN for two demo escrows");
  }

  console.log(JSON.stringify({
    network: "studio-dev",
    chainId,
    contract: addresses.contractAddress,
    provider: provider.address,
    buyer: buyer.address,
    providerBalance: String(providerBalance),
    buyerBalance: String(fundedBuyerBalance),
    priceWei: String(DEMO_PRICE),
  }, null, 2));

  let capabilities = await readJson("get_capabilities");
  let jobs = await readJson("get_jobs");
  let capability = capabilities.find(
    (item) =>
      item.name === "Verified sources demo" &&
      item.provider.toLowerCase() === provider.address.toLowerCase() &&
      String(item.price_wei) === String(DEMO_PRICE),
  );
  let capabilityId;
  if (capability) {
    capabilityId = String(capability.capability_id);
  } else {
    capabilityId = String(await nextId("capabilities"));
    await write(
      provider,
      "register_capability",
      [
        "Verified sources demo",
        "https://research.example.com/v1/sources",
        "Return five verified sources in JSON within the deadline.",
        30,
        '{"type":"array","items":{"type":"object","required":["title","url","citation"]}}',
        10000,
        7500,
        DEMO_PRICE,
      ],
      DEMO_PRICE * 3n,
    );
    capability = await readJson("get_capability", [capabilityId]);
  }

  const findOrCreateJob = async (requestHash, requestLabel) => {
    const existing = jobs.find(
      (item) =>
        item.request_hash === requestHash &&
        item.buyer.toLowerCase() === buyer.address.toLowerCase() &&
        item.capability_id === capabilityId,
    );
    if (existing) return existing;
    const jobId = String(await nextId("jobs"));
    await write(
      buyer,
      "create_job",
      [capabilityId, requestHash, requestLabel],
      DEMO_PRICE,
    );
    return (await readJson("get_jobs")).find((item) => item.job_id === jobId);
  };

  const successfulJob = await findOrCreateJob(
    "demo_request_success",
    "Find five verified sources",
  );
  const malformedJob = await findOrCreateJob(
    "demo_request_malformed",
    "Find five verified sources with malformed output",
  );
  const successfulJobId = String(successfulJob.job_id);
  const malformedJobId = String(malformedJob.job_id);

  const makeReceipt = (job, outputHash, status, schemaValid, responseCode) => ({
    job_id: String(job.job_id),
    request_hash: String(job.request_hash),
    output_hash: outputHash,
    response_status: status,
    response_code: responseCode,
    latency_ms: 1200,
    schema_valid: schemaValid,
    completed_at: new Date((Number(job.funded_at) + 10) * 1000).toISOString(),
    provider: provider.address,
  });
  const signReceipt = async (core) => {
    const receiptHash = createHash("sha256")
      .update(canonicalJson(core))
      .digest("hex");
    const signature = await provider.signMessage({ message: { raw: `0x${receiptHash}` } });
    return { ...core, receipt_signature: signature, receipt_hash: receiptHash };
  };

  const submitIfNeeded = async (job, outputHash, status, schemaValid) => {
    if (job.status !== "funded") return;
    const core = makeReceipt(job, outputHash, status, schemaValid, 200);
    const signed = await signReceipt(core);
    await write(provider, "submit_receipt", [
      job.job_id,
      core.request_hash,
      outputHash,
      status,
      200,
      1200,
      schemaValid,
      core.completed_at,
      signed.receipt_signature,
    ]);
  };
  await submitIfNeeded(successfulJob, "demo_output_success", "success", true);
  await submitIfNeeded(malformedJob, "demo_output_malformed", "malformed", false);

  const receiptSuccess = parseJson(
    await client.readContract({
      address: addresses.contractAddress,
      functionName: "get_receipt",
      args: [successfulJobId],
      jsonSafeReturn: true,
    }),
    "success receipt",
  );
  const receiptMalformed = parseJson(
    await client.readContract({
      address: addresses.contractAddress,
      functionName: "get_receipt",
      args: [malformedJobId],
      jsonSafeReturn: true,
    }),
    "malformed receipt",
  );
  jobs = await readJson("get_jobs");
  const successJob = jobs.find((item) => item.job_id === successfulJobId);
  const malformedJobState = jobs.find((item) => item.job_id === malformedJobId);
  const successCore = makeReceipt(successJob, "demo_output_success", "success", true, 200);
  const malformedCore = makeReceipt(
    malformedJobState,
    "demo_output_malformed",
    "malformed",
    false,
    200,
  );
  const successEvidence = await signReceipt(successCore);
  const malformedEvidence = await signReceipt(malformedCore);
  if (successEvidence.receipt_hash !== receiptSuccess.receipt_hash) {
    throw new Error("Successful receipt hash mismatch before evidence publication");
  }
  if (malformedEvidence.receipt_hash !== receiptMalformed.receipt_hash) {
    throw new Error("Malformed receipt hash mismatch before evidence publication");
  }

  const successFile = `demo-${successfulJobId}.json`;
  const malformedFile = `demo-${malformedJobId}.json`;
  const successUrl = await publishPublicEvidence(successFile, successEvidence);
  const malformedUrl = await publishPublicEvidence(malformedFile, malformedEvidence);
  const evidenceRecords = await readJson("get_evidence_records");
  if (!evidenceRecords.some((item) => item.job_id === successfulJobId)) {
    await write(provider, "publish_evidence", [successfulJobId, successUrl]);
  }
  if (!evidenceRecords.some((item) => item.job_id === malformedJobId)) {
    await write(provider, "publish_evidence", [malformedJobId, malformedUrl]);
  }

  console.log("Waiting 31 seconds for the request deadlines...");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 31_000));
  jobs = await readJson("get_jobs");
  const settled =
    jobs.find((item) => item.job_id === successfulJobId)?.status === "settled"
      ? { hash: "" }
      : await write(buyer, "settle_job", [successfulJobId], 0n, [
          successJob.provider,
          successJob.buyer,
        ]);
  let disputes = await readJson("get_disputes");
  let dispute = disputes.find((item) => item.job_id === malformedJobId);
  if (!dispute) {
    await write(buyer, "open_dispute", [
      malformedJobId,
      "quality",
      "The provider returned an output that violates the required JSON schema.",
    ]);
    disputes = await readJson("get_disputes");
    dispute = disputes.find((item) => item.job_id === malformedJobId);
  }
  const disputeId = String(dispute.dispute_id);
  const resolved =
    dispute.status === "resolved"
      ? { hash: "" }
      : await write(buyer, "resolve_dispute", [disputeId], 0n, [
          malformedJobState.provider,
          malformedJobState.buyer,
        ]);

  const [successJobState, malformedJobResult, disputeState, counts] = await Promise.all([
    client.readContract({ address: addresses.contractAddress, functionName: "get_job", args: [successfulJobId], jsonSafeReturn: true }),
    client.readContract({ address: addresses.contractAddress, functionName: "get_job", args: [malformedJobId], jsonSafeReturn: true }),
    client.readContract({ address: addresses.contractAddress, functionName: "get_dispute", args: [disputeId], jsonSafeReturn: true }),
    client.readContract({ address: addresses.contractAddress, functionName: "get_counts", args: [], jsonSafeReturn: true }),
  ]);
  console.log(JSON.stringify({
    ok: true,
    capabilityId,
    successfulJobId,
    malformedJobId,
    disputeId,
    evidence: { successUrl, malformedUrl },
    transactions: {
      successfulSettlement: settled.hash,
      disputeOpen: dispute.hash,
      disputeResolution: resolved.hash,
    },
    successJob: parseJson(successJobState, "success job"),
    malformedJob: parseJson(malformedJobResult, "malformed job"),
    dispute: parseJson(disputeState, "dispute"),
    counts: parseJson(counts, "counts"),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
