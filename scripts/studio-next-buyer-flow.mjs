#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "dotenv";
import {
  createAccount,
  createClient,
  isSuccessful,
} from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";

const root = resolve(import.meta.dirname, "..");
config({ path: resolve(root, ".env"), quiet: true });

const EXPECTED_CHAIN_ID = 61997;
const RPC = process.env.STUDIO_DEV_RPC?.trim() || "https://studio-dev.genlayer.com/api";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS?.trim() || "0x51eDCf8f3Bdbb69a6e83b1cA5076a77C2E5Cdc35";
const ADAPTER_URL = (process.env.RECOURSE_ADAPTER_URL?.trim() || "https://recourse-evidence.onrender.com").replace(/\/+$/, "");
const PROVIDER_KEY = process.env.DEPLOYER_KEY?.trim() || process.env.AGENT_SIGNING_KEY?.trim();
const BUYER_KEY = process.env.DEMO_BUYER_KEY?.trim() || (await readFile(resolve(root, ".demo/buyer-key"), "utf8")).trim();
const PROVIDER_MESSAGE_FEE = 150000000000000000n;
const KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

if (!KEY_PATTERN.test(PROVIDER_KEY || "") || !KEY_PATTERN.test(BUYER_KEY || "")) {
  throw new Error("DEPLOYER_KEY/AGENT_SIGNING_KEY and DEMO_BUYER_KEY must be 32-byte private keys");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashRequest(capabilityId, requestLabel, request, nonce) {
  return `sha256:${createHash("sha256").update(canonicalJson({
    capability_id: String(capabilityId),
    request: request ?? null,
    request_label: String(requestLabel).trim(),
    nonce: String(nonce).trim(),
    version: "recourse-request-v2",
  })).digest("hex")}`;
}

function parseJson(value, label) {
  try {
    return JSON.parse(String(value));
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function main() {
  const provider = createAccount(PROVIDER_KEY);
  const buyer = createAccount(BUYER_KEY);
  if (provider.address.toLowerCase() === buyer.address.toLowerCase()) {
    throw new Error("provider and buyer must be different accounts");
  }
  const client = createClient({ chain: studioDevnet, endpoint: RPC, account: provider });
  const chainId = Number(await client.getChainId());
  if (chainId !== EXPECTED_CHAIN_ID) throw new Error(`connected to chain ${chainId}, expected ${EXPECTED_CHAIN_ID}`);

  const readJson = async (functionName, args = []) => parseJson(
    await client.readContract({
      address: CONTRACT_ADDRESS,
      functionName,
      args,
      jsonSafeReturn: true,
    }),
    functionName,
  );

  const capabilities = await readJson("get_capabilities");
  const capability = capabilities.find((item) => item.capability_id === "2");
  if (!capability) throw new Error("Source Scout capability 2 is not registered");

  const write = async (account, functionName, args = [], value = 0n) => {
    let fees;
    try {
      fees = await client.estimateTransactionFeesForWrite({
        account,
        address: CONTRACT_ADDRESS,
        functionName,
        args,
        value,
        leaderOnly: false,
      });
    } catch {
      fees = await client.estimateTransactionFees();
    }
    const hash = await client.writeContract({
      account,
      address: CONTRACT_ADDRESS,
      functionName,
      args,
      value,
      fees: {
        distribution: fees.distribution,
        messageAllocations: fees.messageAllocations,
        feeValue: fees.feeValue,
      },
    });
    const receipt = await client.waitForTransactionReceipt({
      hash,
      waitUntil: "finalized",
      interval: 3000,
      retries: 240,
      fullTransaction: true,
    });
    if (!isSuccessful(receipt)) throw new Error(`${functionName} finalized unsuccessfully`);
    return String(hash);
  };

  const request = { query: "How can autonomous agents verify external sources?" };
  const nonce = randomUUID();
  const requestLabel = `Live Source Scout check ${new Date().toISOString()}`;
  const hash = await hashRequest(capability.capability_id, requestLabel, request, nonce);
  const buyerBalance = await client.getBalance({ address: buyer.address });
  const price = BigInt(capability.price_wei);
  const feeEstimate = await client.estimateTransactionFees();
  if (buyerBalance < price + feeEstimate.feeValue + PROVIDER_MESSAGE_FEE) {
    throw new Error("demo buyer does not have enough GEN for a live request; fund the embedded buyer first");
  }

  const createTx = await write(buyer, "create_job", [capability.capability_id, hash, requestLabel], price);
  let job;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    job = (await readJson("get_jobs")).find((item) => item.request_hash === hash);
    if (job) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1800));
  }
  if (!job) throw new Error("funded job was not readable after finalization");

  const response = await fetch(`${capability.endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-recourse-job-id": job.job_id,
      "x-recourse-request-hash": hash,
      "x-recourse-request-label": requestLabel,
      "x-recourse-capability-id": capability.capability_id,
      "x-recourse-request-nonce": nonce,
    },
    body: JSON.stringify({
      capability_id: capability.capability_id,
      request_label: requestLabel,
      nonce,
      request,
    }),
  });
  const execution = await response.json();
  if (!response.ok) throw new Error(`adapter execution failed (${response.status}): ${JSON.stringify(execution)}`);
  const finalJob = await readJson("get_job", [job.job_id]);
  const receipt = parseJson(await client.readContract({
    address: CONTRACT_ADDRESS,
    functionName: "get_receipt",
    args: [job.job_id],
    jsonSafeReturn: true,
  }), "get_receipt");
  const evidence = await fetch(execution.evidence_url).then((value) => value.json());
  if (finalJob.status !== "receipt_submitted" || !finalJob.evidence_id) {
    throw new Error(`job did not reach receipt/evidence state: ${JSON.stringify(finalJob)}`);
  }
  if (receipt.receipt_hash !== execution.receipt_hash || evidence.receipt_hash !== execution.receipt_hash) {
    throw new Error("receipt hash mismatch across adapter, chain, and public evidence");
  }
  console.log(JSON.stringify({
    ok: true,
    network: "studio-next",
    chain_id: chainId,
    contract: CONTRACT_ADDRESS,
    buyer: buyer.address,
    capability: capability.name,
    job_id: job.job_id,
    create_tx: createTx,
    receipt_tx: execution.receipt_tx_hash,
    evidence_tx: execution.evidence_tx_hash,
    status: finalJob.status,
    evidence_url: execution.evidence_url,
    output_hash: execution.receipt.output_hash,
  }, null, 2));
}

await main();
