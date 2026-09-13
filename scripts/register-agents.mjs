#!/usr/bin/env node

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
const DEPLOYER_KEY = process.env.DEPLOYER_KEY?.trim() || "";
const ADAPTER_URL = (process.env.RECOURSE_ADAPTER_URL?.trim() || "").replace(/\/+$/, "");
const PRICE_WEI = BigInt(process.env.AGENT_PRICE_WEI?.trim() || "10000000000000000");
const COLLATERAL_WEI = BigInt(process.env.AGENT_COLLATERAL_WEI?.trim() || "100000000000000000");

if (!/^0x[0-9a-fA-F]{64}$/.test(DEPLOYER_KEY)) {
  throw new Error("DEPLOYER_KEY must be a 32-byte private key");
}
if (!/^https?:\/\//.test(ADAPTER_URL)) {
  throw new Error("RECOURSE_ADAPTER_URL must be the public adapter origin");
}

const manifest = JSON.parse(await readFile(resolve(root, "agents/manifest.json"), "utf8"));
const provider = createAccount(DEPLOYER_KEY);
const client = createClient({ chain: studioDevnet, endpoint: RPC, account: provider });
const chainId = Number(await client.getChainId());
if (chainId !== EXPECTED_CHAIN_ID) {
  throw new Error(`Refusing agent registration on chain ${chainId}; expected ${EXPECTED_CHAIN_ID}`);
}

const readJson = async (functionName, args = []) => JSON.parse(String(await client.readContract({
  address: CONTRACT_ADDRESS,
  functionName,
  args,
  jsonSafeReturn: true,
})));

async function write(functionName, args, value = 0n) {
  let fees;
  try {
    fees = await client.estimateTransactionFeesForWrite({
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
  if (!isSuccessful(receipt)) {
    throw new Error(`${functionName} failed: ${JSON.stringify(receipt)}`);
  }
  return hash;
}

const capabilities = await readJson("get_capabilities");
const registered = [];
for (const agent of manifest.agents) {
  const endpoint = `${ADAPTER_URL}/agents/${agent.slug}/execute`;
  const existing = capabilities.find((item) =>
    item.provider.toLowerCase() === provider.address.toLowerCase()
    && item.name === agent.name
    && item.endpoint === endpoint,
  );
  if (existing) {
    registered.push(existing);
    continue;
  }
  const capabilityId = await write("register_capability", [
    agent.name,
    endpoint,
    agent.terms,
    BigInt(agent.deadline_seconds),
    agent.schema,
    BigInt(agent.timeout_refund_bps),
    BigInt(agent.malformed_refund_bps),
    PRICE_WEI,
  ], COLLATERAL_WEI);
  const created = await readJson("get_capability", [String((await readJson("get_counts")).capabilities)]);
  registered.push(created);
  console.log(`Registered ${agent.slug} in transaction ${capabilityId}`);
}

console.log(JSON.stringify({
  network: "studio-next",
  chain_id: chainId,
  provider: provider.address,
  adapter: ADAPTER_URL,
  capabilities: registered,
}, null, 2));
