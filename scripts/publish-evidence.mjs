import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyMessage } from "viem";

const root = resolve(import.meta.dirname, "..");
const [inputPath] = process.argv.slice(2);
if (!inputPath) {
  throw new Error("Usage: node scripts/publish-evidence.mjs packet.json");
}
const packet = JSON.parse(await readFile(resolve(inputPath), "utf8"));
const required = [
  "job_id",
  "request_hash",
  "output_hash",
  "response_status",
  "response_code",
  "latency_ms",
  "schema_valid",
  "completed_at",
  "provider",
  "receipt_signature",
];
for (const field of required) {
  if (packet[field] === undefined) throw new Error(`Missing evidence field: ${field}`);
}
const core = {
  job_id: String(packet.job_id),
  request_hash: String(packet.request_hash),
  output_hash: String(packet.output_hash),
  response_status: String(packet.response_status),
  response_code: Number(packet.response_code),
  latency_ms: Number(packet.latency_ms),
  schema_valid: Boolean(packet.schema_valid),
  completed_at: String(packet.completed_at),
  provider: String(packet.provider),
};
const canonicalJson = JSON.stringify(
  Object.fromEntries(
    Object.keys(core)
      .sort()
      .map((key) => [key, core[key]]),
  ),
);
const receiptHash = createHash("sha256")
  .update(canonicalJson)
  .digest("hex");
if (!/^0x[a-fA-F0-9]{40}$/.test(core.provider)) {
  throw new Error("provider must be a 20-byte address");
}
const signature = String(packet.receipt_signature);
if (
  !(await verifyMessage({
    address: core.provider,
    message: { raw: `0x${receiptHash}` },
    signature,
  }))
) {
  throw new Error("receipt signature is invalid for the provider");
}
const result = {
  ...core,
  receipt_signature: signature,
  receipt_hash: receiptHash,
};
await mkdir(resolve(root, "evidence"), { recursive: true });
const outputPath = resolve(root, "evidence", `${core.job_id}.json`);
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
const baseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
console.log(JSON.stringify({ outputPath, evidenceUrl: `${baseUrl}/evidence/${core.job_id}`, receiptHash }));
