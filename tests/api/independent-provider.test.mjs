import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { canonicalJson, digest, requestCommitment, verifyDelivery, verifyEvidencePacket } from "../../sdk/protocol.mjs";
import { createDurableExecutor } from "../../api/execution.mjs";

test("independent HTTP provider signs committed content; restart retries publication, not execution", async (context) => {
  const provider = privateKeyToAccount(generatePrivateKey());
  const buyer = privateKeyToAccount(generatePrivateKey());
  const contractAddress = "0x1111111111111111111111111111111111111111";
  const request = { query: "Return a supporting source" };
  const requestJson = requestCommitment({ chainId: 61997, contractAddress, capabilityId: "1", requestLabel: "Research", request, nonce: randomUUID() });
  const job = { protocol_version: 2, chain_id: 61997, contract_address: contractAddress, capability_id: "1", job_id: "1",
    provider: provider.address, buyer: buyer.address, request_label: "Research", request_hash: `sha256:${digest(requestJson)}` };
  let executions = 0;
  let packet;
  const server = createServer(async (incoming, response) => {
    if (incoming.url === "/evidence/1") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(packet)); return; }
    let body = "";
    for await (const chunk of incoming) body += chunk;
    assert.deepEqual(JSON.parse(body), request);
    executions += 1;
    const output = { sources: [{ title: "Independent output", citation: "Actual signed content" }] };
    const receipt = { version: "recourse-receipt-v2", chain_id: job.chain_id, contract_address: contractAddress,
      capability_id: "1", job_id: "1", request_hash: job.request_hash, output_hash: `sha256:${digest(canonicalJson(output))}`,
      response_status: "success", response_code: 200, latency_ms: 10, schema_valid: true, completed_at: new Date().toISOString(), provider: provider.address };
    const receiptHash = digest(canonicalJson(receipt));
    const signature = await provider.signMessage({ message: { raw: `0x${receiptHash}` } });
    packet = { ...receipt, receipt_hash: receiptHash, receipt_signature: signature, request_json: requestJson, output_json: canonicalJson(output) };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ...job, request, output, request_json: requestJson, output_json: canonicalJson(output), receipt, receipt_hash: receiptHash, receipt_signature: signature }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  let saved = null;
  let version = 0;
  const store = {
    read: async () => structuredClone(saved),
    compareAndSet: async (key, expected, value) => {
      if ((saved?.version ?? null) !== expected) return null;
      saved = { version: String(++version), value: structuredClone(value) };
      return structuredClone(saved);
    },
  };
  let time = 0;
  const first = createDurableExecutor({ store, now: () => time, execute: async () => {
    const response = await fetch(endpoint, { method: "POST", body: JSON.stringify(request) });
    const delivery = await response.json();
    await verifyDelivery(delivery, job, job);
    return delivery;
  }, deliver: async () => { throw new Error("publication unavailable"); } });
  await first.enqueue("1", job.request_hash, request);
  assert.equal((await first.run("1")).phase, "executed");
  time = 31_000;
  const restarted = createDurableExecutor({ store, now: () => time, execute: async () => assert.fail("duplicate billable execution"),
    deliver: async (delivery) => { await verifyDelivery(delivery, job, job); return delivery; } });
  assert.equal((await restarted.run("1")).phase, "delivered");
  assert.equal(executions, 1);
  const evidence = await (await fetch(`${endpoint}/evidence/1`)).json();
  await verifyEvidencePacket(evidence, job);
  await assert.rejects(verifyEvidencePacket({ ...evidence, output_json: "{}" }, job));
});
