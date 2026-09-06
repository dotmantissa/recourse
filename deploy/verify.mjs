import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(root, ".env"), quiet: true });
const expectedChainId = 61997;
const metadata = JSON.parse(
  await readFile(resolve(root, "deploy/addresses.json"), "utf8"),
);
if (metadata.chainId !== expectedChainId) {
  throw new Error(`Recorded deployment is not Studio Dev chain ${expectedChainId}`);
}
const client = createClient({
  chain: studioDevnet,
  endpoint: process.env.STUDIO_DEV_RPC?.trim() || "https://studio-dev.genlayer.com/api",
});
const chainId = Number(await client.getChainId());
if (chainId !== expectedChainId) {
  throw new Error(`Connected to chain ${chainId}; expected ${expectedChainId}`);
}
const source = await readFile(resolve(root, "contracts/Recourse.py"), "utf8");
const [schema, deployedCode, counts] = await Promise.all([
  client.getContractSchema(metadata.contractAddress),
  client.getContractCode(metadata.contractAddress),
  client.readContract({
    address: metadata.contractAddress,
    functionName: "get_counts",
    args: [],
    jsonSafeReturn: true,
  }),
]);
const localHash = createHash("sha256").update(source).digest("hex");
const deployedHash = createHash("sha256").update(String(deployedCode)).digest("hex");
if (localHash !== deployedHash || localHash !== metadata.sourceSha256) {
  throw new Error("Local, deployed, and recorded source hashes differ");
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
if (JSON.stringify(expectedMethods) !== JSON.stringify(actualMethods)) {
  throw new Error(`Unexpected schema methods: ${actualMethods.join(", ")}`);
}
console.log(`Verified Recourse at ${metadata.contractAddress}`);
console.log(`Studio Dev chain: ${chainId}`);
console.log(`Counts: ${counts}`);

