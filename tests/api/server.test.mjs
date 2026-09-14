import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPublicUrl,
  evidenceMatchesChain,
  hashRequest,
  outputMatchesSchema,
  parsePaymentEnvelope,
  paymentEnvelopeMatches,
  privateIp,
  readTextLimited,
  storedResultMatchesJob,
} from "../../api/server.mjs";

test("request commitments are stable across object key order", () => {
  const first = hashRequest("2", "Research", { query: "agents", depth: 2 }, "nonce-123");
  const second = hashRequest("2", "Research", { depth: 2, query: "agents" }, "nonce-123");
  assert.equal(first, second);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
});

test("private and reserved network addresses are blocked", async () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.1.1",
    "172.16.0.1",
    "192.168.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
  ]) {
    assert.equal(privateIp(address), true, address);
  }
  assert.equal(privateIp("8.8.8.8"), false);
  assert.equal(privateIp("2606:4700:4700::1111"), false);
  await assert.rejects(assertPublicUrl("http://127.0.0.1/private", "url"), /public host/);
  await assert.rejects(assertPublicUrl("http://localhost/private", "url"), /public host/);
});

test("remote response bodies are bounded", async () => {
  assert.equal(await readTextLimited(new Response("small"), 10), "small");
  await assert.rejects(
    readTextLimited(new Response("response is too large"), 5),
    /size limit/,
  );
});

test("capability output is validated against its registered schema", () => {
  const schema = JSON.stringify({
    type: "object",
    required: ["query", "sources"],
    properties: {
      query: { type: "string" },
      sources: { type: "array", minItems: 1 },
    },
  });
  assert.equal(outputMatchesSchema({ query: "agents", sources: [{}] }, schema), true);
  assert.equal(outputMatchesSchema({ query: "agents", sources: [] }, schema), false);
  assert.equal(outputMatchesSchema({}, "not-json"), false);
});

test("published evidence must match the exact onchain receipt", () => {
  const signature = "0xsigned";
  const core = {
    job_id: "7",
    request_hash: "sha256:request",
    output_hash: "sha256:output",
    response_status: "success",
    response_code: 200,
    latency_ms: 1200,
    schema_valid: true,
    completed_at: "2026-09-14T00:00:00.000Z",
    provider: "0x0000000000000000000000000000000000000001",
  };
  const job = {
    job_id: "7",
    request_hash: core.request_hash,
    provider: core.provider,
  };
  const receipt = {
    ...core,
    receipt_signature: signature,
  };
  assert.equal(evidenceMatchesChain(core, signature, job, receipt), true);
  assert.equal(
    evidenceMatchesChain(core, signature, job, { ...receipt, latency_ms: 1201 }),
    false,
  );
});

test("stored deliveries remain bound to their funded job", () => {
  const job = {
    job_id: "7",
    request_hash: "sha256:request",
    provider: "0x0000000000000000000000000000000000000001",
  };
  const result = {
    job_id: "7",
    capability_id: "2",
    request_hash: job.request_hash,
    request_label: "Research",
    receipt: {
      job_id: "7",
      request_hash: job.request_hash,
      provider: job.provider,
    },
  };
  assert.equal(storedResultMatchesJob(result, job, "2", "Research"), true);
  assert.equal(
    storedResultMatchesJob({ ...result, capability_id: "3" }, job, "2", "Research"),
    false,
  );
});

test("x-payment accepts JSON or base64 JSON and must match the funded job", () => {
  const requirement = {
    scheme: "genlayer-native",
    network: "studio-next",
    chain_id: 61997,
    asset: "GEN",
    action: "create_job",
  };
  const envelope = {
    ...requirement,
    amount: "10",
    contract_address: "0x51eDCf8f3Bdbb69a6e83b1cA5076a77C2E5Cdc35",
    capability_id: "2",
    job_id: "7",
  };
  assert.deepEqual(parsePaymentEnvelope(JSON.stringify(envelope)), envelope);
  assert.deepEqual(
    parsePaymentEnvelope(Buffer.from(JSON.stringify(envelope)).toString("base64")),
    envelope,
  );
  assert.equal(parsePaymentEnvelope("not-json"), null);
  assert.equal(
    paymentEnvelopeMatches(
      envelope,
      requirement,
      { job_id: "7", capability_id: "2" },
      { price_wei: "10" },
    ),
    true,
  );
  assert.equal(
    paymentEnvelopeMatches(
      { ...envelope, amount: "11" },
      requirement,
      { job_id: "7", capability_id: "2" },
      { price_wei: "10" },
    ),
    false,
  );
  assert.equal(
    paymentEnvelopeMatches(
      { ...envelope, capability_id: undefined },
      requirement,
      { job_id: "7", capability_id: "2" },
      { price_wei: "10" },
    ),
    false,
  );
});
