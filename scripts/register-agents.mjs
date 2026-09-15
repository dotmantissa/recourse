#!/usr/bin/env node

import { mkdir, open, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "dotenv";
import {
  createAccount,
  createClient,
  isSuccessful,
} from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { TransactionHashVariant } from "genlayer-js/types";
import JSONbig from "json-bigint";
import { AGENT_DEFINITIONS, MANIFEST_HASH, hostedCapabilityMatches } from "../agents/catalog.mjs";
import { fetchPublicUrl } from "../api/http-safety.mjs";

const root = resolve(import.meta.dirname, "..");
config({ path: resolve(root, ".env"), quiet: true });

const EXPECTED_CHAIN_ID = 61997;
const RPC = process.env.STUDIO_DEV_RPC?.trim() || "https://studio-dev.genlayer.com/api";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS?.trim() || "";
const PROVIDER_KEY = process.env.AGENT_SIGNING_KEY?.trim() || "";
const ADAPTER_URL = (process.env.RECOURSE_ADAPTER_URL?.trim() || "").replace(/\/+$/, "");
const PRICE_WEI = BigInt(process.env.AGENT_PRICE_WEI?.trim() || "10000000000000000");
const COLLATERAL_WEI = BigInt(process.env.AGENT_COLLATERAL_WEI?.trim() || "100000000000000000");
const MAX_FEE_WEI = BigInt(process.env.REGISTRATION_MAX_FEE_WEI?.trim() || "0");
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--run")) throw new Error("Usage: npm run register:agents -- [--run]");
if (!args.includes("--run")) {
  console.log(JSON.stringify({ mode: "dry-run", manifest_hash: MANIFEST_HASH, chain_id: EXPECTED_CHAIN_ID,
    contract_address: CONTRACT_ADDRESS || null, adapter: ADAPTER_URL || null, price_wei: String(PRICE_WEI),
    collateral_per_capability_wei: String(COLLATERAL_WEI), maximum_total_collateral_wei: String(COLLATERAL_WEI * 5n),
    maximum_fee_per_registration_wei: String(MAX_FEE_WEI), agents: Object.values(AGENT_DEFINITIONS) }, null, 2));
  process.exit(0);
}

if (!/^0x[0-9a-fA-F]{64}$/.test(PROVIDER_KEY)) {
  throw new Error("AGENT_SIGNING_KEY must be the hosted provider's 32-byte private key");
}
if (!/^0x[0-9a-fA-F]{40}$/.test(CONTRACT_ADDRESS)) throw new Error("CONTRACT_ADDRESS must explicitly identify the protocol-v2 deployment");
if (!/^https:\/\//.test(ADAPTER_URL) || new URL(ADAPTER_URL).origin !== ADAPTER_URL) {
  throw new Error("RECOURSE_ADAPTER_URL must be the public HTTPS adapter origin");
}
if (PRICE_WEI <= 0n || COLLATERAL_WEI < PRICE_WEI || MAX_FEE_WEI <= 0n) throw new Error("Positive price, sufficient collateral, and explicit REGISTRATION_MAX_FEE_WEI are required");

const provider = createAccount(PROVIDER_KEY);
const hostedResponse = await fetchPublicUrl(`${ADAPTER_URL}/agents`);
if (!hostedResponse.ok) throw new Error("Hosted provider manifest is unavailable");
const hosted = await hostedResponse.json();
if (hosted.provider?.toLowerCase() !== provider.address.toLowerCase() || hosted.manifest_hash !== MANIFEST_HASH
  || hosted.chain_id !== EXPECTED_CHAIN_ID || hosted.contract_address?.toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) {
  throw new Error("Hosted provider identity, deployment, or manifest differs from the registration plan");
}
const client = createClient({ chain: studioDevnet, endpoint: RPC, account: provider });
const chainId = Number(await client.getChainId());
if (chainId !== EXPECTED_CHAIN_ID) {
  throw new Error(`Refusing agent registration on chain ${chainId}; expected ${EXPECTED_CHAIN_ID}`);
}

const schema = await client.getContractSchema(CONTRACT_ADDRESS);
if (!["accept_job", "recover_job", "get_capabilities_page"].every((method) => Object.hasOwn(schema.methods ?? {}, method))) throw new Error("Registration requires protocol v2");
const parser = JSONbig({ storeAsString: true, strict: true });
const readJson = async (functionName, args = []) => parser.parse(String(await client.readContract({
  address: CONTRACT_ADDRESS,
  functionName,
  args,
  jsonSafeReturn: true,
  transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
})));

async function write(functionName, args, value = 0n) {
  const fees = await client.estimateTransactionFeesForWrite({
    address: CONTRACT_ADDRESS,
    functionName,
    args,
    value,
    leaderOnly: false,
  });
  if (BigInt(fees.feeValue) > MAX_FEE_WEI) throw new Error("Registration fee exceeds the explicitly authorized cap");
  await checkpoint({ status: "submitting", endpoint: args[1], fee_wei: String(fees.feeValue), collateral_wei: String(value) });
  const hash = await client.writeContract({
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
  await checkpoint({ status: "submitted", hash });
  console.log(`Submitted registration transaction: ${hash}`);
  const receipt = await client.waitForTransactionReceipt({
    hash,
    waitUntil: "finalized",
    interval: 3000,
    retries: 240,
    fullTransaction: true,
  });
  if (!isSuccessful(receipt)) {
    throw new Error(`${functionName} failed: ${JSON.stringify(receipt)}`);
  }
  await checkpoint({ status: "finalized", hash });
  return hash;
}

async function checkpoint(value) {
  const handle = await open(lock, "a", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
}

async function readCapabilities() {
  const capabilities = [];
  let cursor = 0;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await readJson("get_capabilities_page", [cursor, 50]);
    if (!Array.isArray(page.items) || page.items.length > 50 || !Number.isSafeInteger(page.next_cursor) || page.next_cursor < cursor) throw new Error("Invalid capability page");
    capabilities.push(...page.items);
    if (page.next_cursor >= page.total) return capabilities;
    if (page.next_cursor === cursor) throw new Error("Capability pagination stalled");
    cursor = page.next_cursor;
  }
  throw new Error("Registration scan exceeded 5000 capabilities; use an operator-reviewed catalog migration");
}

const directory = resolve(root, ".runtime/registrations");
await mkdir(directory, { recursive: true, mode: 0o700 });
const lock = resolve(directory, `${EXPECTED_CHAIN_ID}-${CONTRACT_ADDRESS.toLowerCase()}-${provider.address.toLowerCase()}.lock`);
let guard;
try { guard = await open(lock, "wx", 0o600); } catch (error) {
  if (error.code === "EEXIST") throw new Error("A registration run is active or uncertain; reconcile it before manually removing its lock file");
  throw error;
}
await guard.writeFile(`${JSON.stringify({ pid: process.pid, manifest_hash: MANIFEST_HASH })}\n`);
await guard.sync();
await guard.close();
const parent = await open(directory, "r");
try { await parent.sync(); } finally { await parent.close(); }
const capabilities = await readCapabilities();
const registered = [];
for (const agent of Object.values(AGENT_DEFINITIONS)) {
  const endpoint = `${ADAPTER_URL}/agents/${agent.slug}/execute`;
  const existing = capabilities.find((item) =>
    item.provider.toLowerCase() === provider.address.toLowerCase()
    && item.endpoint === endpoint,
  );
  if (existing) {
    if (!hostedCapabilityMatches(agent.slug, existing) || String(existing.price_wei) !== String(PRICE_WEI) || existing.status !== "active") {
      throw new Error(`Existing ${agent.slug} listing is incompatible; retire it explicitly instead of silently duplicating it`);
    }
    registered.push(existing);
    continue;
  }
  const capabilityId = await write("register_capability", [
    agent.name,
    endpoint,
    agent.terms,
    BigInt(agent.deadline_seconds),
    JSON.stringify(agent.output_schema),
    BigInt(agent.timeout_refund_bps),
    BigInt(agent.malformed_refund_bps),
    PRICE_WEI,
  ], COLLATERAL_WEI);
  const created = (await readCapabilities()).find((item) => item.provider.toLowerCase() === provider.address.toLowerCase()
    && item.endpoint === endpoint && hostedCapabilityMatches(agent.slug, item) && String(item.price_wei) === String(PRICE_WEI));
  if (!created) throw new Error("Finalized registration is not yet indexed; reconcile this run before restarting");
  registered.push(created);
  console.log(`Registered ${agent.slug} in transaction ${capabilityId}`);
}
await rm(lock);

console.log(JSON.stringify({
  network: "studio-dev",
  chain_id: chainId,
  provider: provider.address,
  adapter: ADAPTER_URL,
  capabilities: registered,
}, null, 2));
