import { sha256, stringToHex, verifyMessage } from "viem";

export function deploymentScope(chainId, contractAddress) {
  if (!Number.isSafeInteger(Number(chainId)) || Number(chainId) < 1 || !/^0x[0-9a-fA-F]{40}$/.test(contractAddress)) throw new Error("invalid deployment scope");
  return `${chainId}-${contractAddress.toLowerCase()}`;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function digest(value) {
  return sha256(stringToHex(typeof value === "string" ? value : canonicalJson(value))).slice(2);
}

export function requestCommitment({ chainId, contractAddress, capabilityId, requestLabel, request, nonce }) {
  deploymentScope(chainId, contractAddress);
  if (!/^[1-9][0-9]{0,19}$/.test(capabilityId) || typeof nonce !== "string" || nonce.trim().length < 8 || nonce.trim().length > 128
    || typeof requestLabel !== "string" || !requestLabel.trim() || requestLabel.trim().length > 240) throw new Error("invalid request commitment");
  const value = canonicalJson({ version: "recourse-request-v3", chain_id: Number(chainId), contract_address: contractAddress.toLowerCase(),
    capability_id: capabilityId, request_label: requestLabel.trim(), request: request ?? null, nonce: nonce.trim(), disclosure: "public" });
  if (new TextEncoder().encode(value).byteLength > 65536) throw new Error("request exceeds the committed evidence size limit");
  return value;
}

export function resultAccessMessage({ chainId, contractAddress, jobId, requestHash, wallet, audience, expiresAt }) {
  const scope = deploymentScope(chainId, contractAddress);
  if (!/^[1-9][0-9]{0,19}$/.test(jobId) || !/^sha256:[a-f0-9]{64}$/.test(requestHash)
    || !/^0x[a-fA-F0-9]{40}$/.test(wallet) || !Number.isSafeInteger(expiresAt)) throw new Error("invalid result authorization");
  return canonicalJson({ action: "recourse-result-access-v2", scope, job_id: jobId, request_hash: requestHash,
    wallet: wallet.toLowerCase(), audience: new URL(audience).origin, expires_at: expiresAt });
}

export function validateAccessExpiry(expiresAt, now = Math.floor(Date.now() / 1000)) {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 300) throw new Error("result authorization is expired or exceeds five minutes");
}

export async function verifyDelivery(result, job, capability) {
  const receipt = result?.receipt;
  if (job.protocol_version != null && ![1, 2].includes(job.protocol_version)) throw new Error("unsupported delivery protocol");
  if (job.protocol_version === 2) {
    if (receipt?.version !== "recourse-receipt-v2" || receipt?.chain_id !== job.chain_id
      || receipt?.contract_address !== job.contract_address || receipt?.capability_id !== job.capability_id
      || typeof result?.request_json !== "string" || typeof result?.output_json !== "string"
      || new TextEncoder().encode(result.request_json).byteLength > 65536 || new TextEncoder().encode(result.output_json).byteLength > 65536
      || `sha256:${digest(result.request_json)}` !== job.request_hash || `sha256:${digest(result.output_json)}` !== receipt.output_hash) {
      throw new Error("delivery belongs to a different protocol or deployment");
    }
    const request = JSON.parse(result.request_json);
    if (request?.version !== "recourse-request-v3" || request.chain_id !== job.chain_id
      || request.contract_address !== job.contract_address || request.capability_id !== job.capability_id
      || request.request_label !== job.request_label || request.disclosure !== "public"
      || typeof request.nonce !== "string" || request.nonce.length < 8 || request.nonce.length > 128
      || canonicalJson(request.request) !== canonicalJson(result.request)
      || canonicalJson(JSON.parse(result.output_json)) !== canonicalJson(result.output)) {
      throw new Error("delivery content does not match its committed documents");
    }
  }
  if (!result || !receipt || typeof receipt !== "object" || result.job_id !== job.job_id
    || result.capability_id !== job.capability_id || capability.capability_id !== job.capability_id
    || result.request_hash !== job.request_hash || result.request_label !== job.request_label
    || receipt.job_id !== job.job_id || receipt.request_hash !== job.request_hash
    || String(receipt.provider).toLowerCase() !== String(job.provider).toLowerCase()
    || String(capability.provider).toLowerCase() !== String(job.provider).toLowerCase()
    || !["success", "timeout", "malformed"].includes(receipt.response_status)
    || !Number.isSafeInteger(receipt.response_code) || receipt.response_code < 0 || receipt.response_code > 599
    || !Number.isSafeInteger(receipt.latency_ms) || receipt.latency_ms < 0 || receipt.latency_ms > 86400000
    || typeof receipt.schema_valid !== "boolean" || !Number.isFinite(Date.parse(receipt.completed_at))
    || result.output === undefined || receipt.output_hash !== `sha256:${digest(canonicalJson(result.output))}`
    || result.receipt_hash !== digest(canonicalJson(receipt))
    || (job.receipt_hash && result.receipt_hash !== job.receipt_hash)) throw new Error("delivery does not match the funded job and committed output");
  if (!await verifyMessage({ address: receipt.provider, message: { raw: `0x${result.receipt_hash}` }, signature: result.receipt_signature })) {
    throw new Error("provider receipt signature is invalid");
  }
}

export async function verifyEvidencePacket(packet, job) {
  if (job.protocol_version !== 2 || typeof packet?.request_json !== "string" || typeof packet?.output_json !== "string") {
    throw new Error("protocol v2 evidence requires committed public documents");
  }
  const receipt = Object.fromEntries([
    "version", "chain_id", "contract_address", "capability_id", "job_id", "request_hash", "output_hash",
    "response_status", "response_code", "latency_ms", "schema_valid", "completed_at", "provider",
  ].map((field) => [field, packet[field]]));
  await verifyDelivery({
    job_id: packet.job_id, capability_id: packet.capability_id, request_hash: packet.request_hash,
    request_label: job.request_label, request: JSON.parse(packet.request_json).request,
    request_json: packet.request_json, output_json: packet.output_json, output: JSON.parse(packet.output_json),
    receipt, receipt_hash: packet.receipt_hash, receipt_signature: packet.receipt_signature,
  }, job, { capability_id: job.capability_id, provider: job.provider });
}
