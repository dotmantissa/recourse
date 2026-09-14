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
