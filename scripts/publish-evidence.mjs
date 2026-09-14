import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseId, parseObject } from "../api/http-safety.mjs";
import { deploymentScope, verifyEvidencePacket } from "../sdk/protocol.mjs";

const root = resolve(import.meta.dirname, "..");
const [inputPath] = process.argv.slice(2);
if (!inputPath) throw new Error("Usage: node scripts/publish-evidence.mjs packet.json");
if ((await stat(resolve(inputPath))).size > 800_000) throw new Error("evidence exceeds size limit");
const packet = parseObject(await readFile(resolve(inputPath), "utf8"));
parseId(packet.job_id);
parseId(packet.capability_id, "capability_id");
const scope = deploymentScope(packet.chain_id, packet.contract_address);
const request = parseObject(packet.request_json);
await verifyEvidencePacket(packet, {
  protocol_version: 2, chain_id: packet.chain_id, contract_address: packet.contract_address,
  capability_id: packet.capability_id, job_id: packet.job_id, request_hash: packet.request_hash,
  request_label: request.request_label, provider: packet.provider,
});
const directory = resolve(root, "evidence", scope);
await mkdir(directory, { recursive: true });
const outputPath = resolve(directory, `${packet.job_id}.json`);
await writeFile(outputPath, `${JSON.stringify(packet, null, 2)}\n`, { flag: "wx", mode: 0o600 });
const baseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
console.log(JSON.stringify({ outputPath, evidenceUrl: `${baseUrl}/evidence/${scope}/${packet.job_id}`, receiptHash: packet.receipt_hash,
  verification: "Signature and document commitments verified locally; onchain job verification occurs at publication." }));
