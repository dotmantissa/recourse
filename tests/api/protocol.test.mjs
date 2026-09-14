import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import { canonicalJson, deploymentScope, digest, requestCommitment, resultAccessMessage, validateAccessExpiry, verifyDelivery, verifyEvidencePacket } from "../../sdk/protocol.mjs";

const signer = privateKeyToAccount(generatePrivateKey());
const contract = `0x${"12".repeat(20)}`;
const buyer = `0x${"23".repeat(20)}`;
const job = { job_id: "7", capability_id: "2", request_label: "Research", request_hash: `sha256:${"ab".repeat(32)}`, provider: signer.address, buyer };
const capability = { capability_id: "2", provider: signer.address };

async function delivery() {
  const output = { sources: [{ title: "Verified input", values: { "2": "two", "10": "ten" } }] };
  const receipt = { job_id: job.job_id, request_hash: job.request_hash, provider: signer.address,
    output_hash: `sha256:${digest(canonicalJson(output))}`, response_status: "success", response_code: 200,
    latency_ms: 100, schema_valid: true, completed_at: "2026-09-14T00:00:00.000Z" };
  const receiptHash = digest(canonicalJson(receipt));
  return { ...job, output, receipt, receipt_hash: receiptHash,
    receipt_signature: await signer.signMessage({ message: { raw: `0x${receiptHash}` } }) };
}

test("deliveries verify output, identity, and provider signature independently", async () => {
  const result = await delivery();
  await verifyDelivery(result, job, capability);
  for (const changed of [
    { ...result, output: { text: "tampered" } }, { ...result, job_id: "8" },
    { ...result, capability_id: "3" }, { ...result, request_hash: "different" },
    { ...result, receipt_signature: `0x${"00".repeat(65)}` },
    { ...result, receipt: { ...result.receipt, response_code: "200" } },
  ]) await assert.rejects(verifyDelivery(changed, job, capability));
  await assert.rejects(verifyDelivery(result, { ...job, receipt_hash: "different" }, capability));
  await assert.rejects(verifyDelivery(result, job, { ...capability, provider: buyer }));
});

test("result access signatures bind chain, deployment, buyer, audience, and expiry", async () => {
  const value = { chainId: 61997, contractAddress: contract, jobId: "7", requestHash: job.request_hash,
    wallet: signer.address, audience: "https://provider.example", expiresAt: 200 };
  const message = resultAccessMessage(value);
  const signature = await signer.signMessage({ message });
  assert.equal(await verifyMessage({ address: signer.address, message, signature }), true);
  for (const change of [{ chainId: 1 }, { contractAddress: buyer }, { jobId: "8" },
    { wallet: buyer }, { audience: "https://other.example" }, { expiresAt: 201 }]) {
    assert.equal(await verifyMessage({ address: signer.address, message: resultAccessMessage({ ...value, ...change }), signature }), false);
  }
  validateAccessExpiry(200, 100);
  for (const expiry of [100, 99, 401, Infinity, NaN]) assert.throws(() => validateAccessExpiry(expiry, 100));
  assert.notEqual(deploymentScope(61997, contract), deploymentScope(61997, buyer));
  assert.throws(() => deploymentScope(1, "../outside"));
});

test("encrypted deliveries authenticate their deployment namespace", async () => {
  process.env.RESULT_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  const { encryptResult, decryptResult } = await import("../../api/server.mjs");
  const packet = encryptResult({ job_id: "7", output: "private" });
  assert.deepEqual(decryptResult(packet), { job_id: "7", output: "private" });
  assert.throws(() => decryptResult({ ...packet, scope: deploymentScope(61997, buyer) }));
  assert.throws(() => decryptResult({ ...packet, ciphertext: Buffer.from("tampered").toString("base64") }));
});

test("protocol v2 deliveries bind public documents and the complete deployment domain", async () => {
  const request = { query: "Research" };
  const requestJson = requestCommitment({ chainId: 61997, contractAddress: contract, capabilityId: "2", requestLabel: "Research", request, nonce: "unique-nonce" });
  const scopedJob = { ...job, protocol_version: 2, chain_id: 61997, contract_address: contract, request_hash: `sha256:${digest(requestJson)}` };
  const result = await delivery();
  Object.assign(result, scopedJob, { request, request_json: requestJson, output_json: canonicalJson(result.output) });
  Object.assign(result.receipt, { version: "recourse-receipt-v2", chain_id: 61997, contract_address: contract, capability_id: "2", request_hash: scopedJob.request_hash });
  result.receipt_hash = digest(canonicalJson(result.receipt));
  result.receipt_signature = await signer.signMessage({ message: { raw: `0x${result.receipt_hash}` } });
  await verifyDelivery(result, scopedJob, capability);
  const packet = { ...result.receipt, receipt_hash: result.receipt_hash, receipt_signature: result.receipt_signature,
    request_json: result.request_json, output_json: result.output_json };
  await verifyEvidencePacket(packet, scopedJob);
  await assert.rejects(verifyEvidencePacket({ ...packet, output_json: "{}" }, scopedJob));
  await assert.rejects(verifyEvidencePacket(packet, { ...scopedJob, receipt_hash: "wrong" }));
  for (const change of [{ chain_id: 1 }, { contract_address: buyer }, { capability_id: "3" }, { protocol_version: 3 }]) {
    await assert.rejects(verifyDelivery(result, { ...scopedJob, ...change }, capability));
  }
  for (const change of [{ request: { query: "tampered" } }, { request_json: "{}" }, { output_json: "{}" }, { request_json: null }]) {
    await assert.rejects(verifyDelivery({ ...result, ...change }, scopedJob, capability));
  }
});

test("request commitments reject blank nonces and bound UTF-8 evidence size", () => {
  const options = { chainId: 61997, contractAddress: contract, capabilityId: "2", requestLabel: "Research", request: {}, nonce: "unique-nonce" };
  assert.throws(() => requestCommitment({ ...options, nonce: "        " }));
  assert.throws(() => requestCommitment({ ...options, request: { text: "🔥".repeat(20_000) } }));
  assert.equal(requestCommitment(options), requestCommitment({ ...options, contractAddress: contract.toUpperCase().replace("0X", "0x") }));
});
