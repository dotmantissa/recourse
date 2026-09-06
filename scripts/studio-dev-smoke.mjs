import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "dotenv";
import { createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";

const root = resolve(import.meta.dirname, "..");
config({ path: resolve(root, ".env"), quiet: true });

const expectedChainId = 61997;
const rpc = process.env.STUDIO_DEV_RPC?.trim() || "https://studio-dev.genlayer.com/api";
const address = process.env.CONTRACT_ADDRESS?.trim();
if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
  throw new Error("CONTRACT_ADDRESS must be set to a deployed Studio Dev contract");
}

const client = createClient({ chain: studioDevnet, endpoint: rpc });
const chainId = Number(await client.getChainId());
if (chainId !== expectedChainId) {
  throw new Error(`Refusing smoke test on chain ${chainId}; expected ${expectedChainId}`);
}

const source = await readFile(resolve(root, "contracts/Recourse.py"), "utf8");
const [schema, code, counts] = await Promise.all([
  client.getContractSchema(address),
  client.getContractCode(address),
  client.readContract({
    address,
    functionName: "get_counts",
    args: [],
    jsonSafeReturn: true,
  }),
]);
if (!code || !code.includes("class Recourse")) {
  throw new Error("deployed code does not contain the Recourse contract");
}
const expectedMethods = [
  "add_collateral",
  "claim_timeout",
  "create_job",
  "get_capabilities",
  "get_capability",
  "get_counts",
  "get_dispute",
  "get_disputes",
  "get_evidence",
  "get_evidence_records",
  "get_job",
  "get_jobs",
  "get_receipt",
  "get_reputation",
  "open_dispute",
  "pause_capability",
  "publish_evidence",
  "register_capability",
  "resolve_dispute",
  "set_monitor_operator",
  "settle_job",
  "submit_receipt",
  "withdraw_collateral",
].sort();
const actualMethods = Object.keys(schema.methods ?? {}).sort();
if (JSON.stringify(actualMethods) !== JSON.stringify(expectedMethods)) {
  throw new Error(`unexpected schema methods: ${actualMethods.join(", ")}`);
}
console.log(JSON.stringify({
  ok: true,
  network: "studio-dev",
  chainId,
  address,
  counts: JSON.parse(String(counts)),
  methods: actualMethods.length,
  localSourceBytes: Buffer.byteLength(source),
  deployedCodeBytes: Buffer.byteLength(String(code)),
}));
