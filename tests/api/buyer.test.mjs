import assert from "node:assert/strict";
import test from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createBuyerWorkflow, validateBuyerPlan } from "../../sdk/buyer.mjs";
import { canonicalJson, digest, requestCommitment } from "../../sdk/protocol.mjs";

export const buyerPlan = { runId: "buyer-test", chainId: 61997, contractAddress: `0x${"44".repeat(20)}`, buyer: `0x${"55".repeat(20)}`,
  capabilityIds: ["1", "2"], requestLabel: "Return the requested answer", request: { task: "Return good" }, publicEvidence: true,
  maxSpendWei: "200", maxFeeWei: "20", maxFeePerTransactionWei: "2", maxTransactions: 12,
  qualityChecks: [{ path: ["answer"], equals: "good" }] };

function fixture(overrides = {}) {
  const plan = { ...buyerPlan, ...overrides };
  const signers = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())];
  const capabilities = signers.map((signer, index) => ({ capability_id: String(index + 1), provider: signer.address, status: "active", price_wei: "100",
    endpoint: `https://provider${index + 1}.example/execute`, deadline_seconds: 30,
    output_schema: '{"type":"object","required":["answer"],"properties":{"answer":{"type":"string"}}}' }));
  let stored = null;
  let locked = false;
  let time = 1_000_000;
  const jobs = [];
  const packets = new Map();
  const transactions = new Map();
  const sends = [];
  const executions = [];
  const fail = new Set();
  let executionMode = "deliver";
  const journal = {
    read: async () => structuredClone(stored),
    write: async (value) => { stored = structuredClone(value); },
    withLock: async (operation) => { if (locked) throw new Error("locked"); locked = true; try { return await operation(); } finally { locked = false; } },
  };
  const transport = {
    read: async (method, args) => {
      if (method === "get_capability") return structuredClone(capabilities.find((item) => item.capability_id === args[0]));
      if (method === "get_counts") return { jobs: jobs.length };
      if (method === "get_jobs_page") return { items: structuredClone(jobs.slice(Number(args[0]), Number(args[0]) + Number(args[1]))), next_cursor: Math.min(Number(args[0]) + Number(args[1]), jobs.length), total: jobs.length };
      if (method === "get_job") return structuredClone(jobs.find((item) => item.job_id === args[0]));
      if (method === "get_evidence") return { packet: structuredClone(packets.get(args[0])) };
      throw new Error(method);
    },
    estimate: async () => ({ feeWei: "1" }),
    send: async (request) => {
      assert.equal(stored.pending.hash, null);
      assert.equal(stored.writes, sends.length + 1);
      sends.push(request);
      const hash = `0x${String(sends.length).padStart(64, "0")}`;
      transactions.set(hash, { request, applied: false });
      return hash;
    },
    transaction: async (hash) => {
      const transaction = transactions.get(hash);
      const { method, args } = transaction.request;
      const successful = !fail.has(method);
      if (successful && !transaction.applied) {
        transaction.applied = true;
        if (method === "create_job") {
          const capability = capabilities.find((item) => item.capability_id === args[0]);
          jobs.push({ protocol_version: 2, chain_id: plan.chainId, contract_address: plan.contractAddress, job_id: String(jobs.length + 1),
            capability_id: args[0], request_hash: args[1], request_label: args[2], buyer: plan.buyer, provider: capability.provider,
            status: "funded", deadline_at: Math.floor(time / 1000) + 1800, receipt_deadline_at: Math.floor(time / 1000) + 1800,
            evidence_id: "", receipt_hash: "", dispute_id: "", escrow_wei: "100" });
        } else {
          const job = method === "resolve_dispute" ? jobs.find((item) => item.dispute_id === args[0]) : jobs.find((item) => item.job_id === args[0]);
          if (method === "open_dispute") Object.assign(job, { status: "disputed", dispute_id: `d-${job.job_id}`, resolution_deadline_at: Math.floor(time / 1000) + 1800 });
          if (["settle_job", "resolve_dispute", "recover_job"].includes(method)) {
            const refund = method === "settle_job" ? 0 : 10000;
            Object.assign(job, { status: "settled", refund_bps: refund, refund_wei: refund ? "100" : "0", outcome: refund ? "refund" : "success" });
          }
        }
      }
      return { hash, sender: plan.buyer, recipient: plan.contractAddress, status: "FINALIZED", successful };
    },
    execute: async ({ capability, job, request, nonce }) => {
      executions.push(job.job_id);
      if (executionMode === "lost") throw new Error("response lost");
      const actual = jobs.find((item) => item.job_id === job.job_id);
      Object.assign(actual, { status: "receipt_submitted", deadline_at: Math.floor(time / 1000) + 10,
        evidence_deadline_at: Math.floor(time / 1000) + 600, challenge_deadline_at: Math.floor(time / 1000) + 120 });
      if (executionMode === "missing-evidence") return;
      const output = { answer: capability.capability_id === "1" ? "bad" : "good" };
      const requestJson = requestCommitment({ ...plan, capabilityId: capability.capability_id, request, nonce });
      const outputJson = canonicalJson(output);
      const core = { version: "recourse-receipt-v2", chain_id: plan.chainId, contract_address: plan.contractAddress,
        capability_id: job.capability_id, job_id: job.job_id, provider: job.provider, request_hash: job.request_hash,
        output_hash: `sha256:${digest(outputJson)}`, response_status: "success", response_code: 200, latency_ms: 1,
        schema_valid: true, completed_at: new Date(time).toISOString() };
      const receiptHash = digest(core);
      const signer = signers[Number(capability.capability_id) - 1];
      packets.set(job.job_id, { ...core, receipt_hash: receiptHash,
        receipt_signature: await signer.signMessage({ message: { raw: `0x${receiptHash}` } }), request_json: requestJson, output_json: outputJson });
      Object.assign(actual, { receipt_hash: receiptHash, evidence_id: job.job_id });
    },
  };
  const engine = () => createBuyerWorkflow({ plan, journal, transport, now: () => time });
  const step = async () => { const result = await engine().step(); time += 15_000; return result; };
  async function until(predicate, limit = 60) {
    for (let index = 0; index < limit; index += 1) { const result = await step(); if (predicate(result)) return result; }
    throw new Error("workflow did not reach expected checkpoint");
  }
  return { plan, journal, transport, engine, step, until, jobs, packets, sends, executions, fail, capabilities,
    state: () => structuredClone(stored), advance: (seconds) => { time += seconds * 1000; }, setExecution: (value) => { executionMode = value; } };
}

test("buyer plan requires explicit disclosure, bounded budgets and a fixed allowlist", () => {
  assert.equal(validateBuyerPlan(buyerPlan).maxSpendWei, "200");
  for (const change of [{ publicEvidence: false }, { maxSpendWei: 200 }, { maxTransactions: 31 }, { maxFeeWei: "0" },
    { capabilityIds: ["1", "1"] }, { runId: undefined }, { runId: 123 }, { qualityChecks: [{ path: ["__proto__"], equals: true }] }, { privateKey: "not permitted" }]) {
    assert.throws(() => validateBuyerPlan({ ...buyerPlan, ...change }));
  }
});

test("autonomous buyer disputes a verified bad result and replaces it only after settlement", async () => {
  const run = fixture();
  const result = await run.until((report) => report.status === "completed");
  assert.deepEqual(run.sends.map((item) => item.method), ["create_job", "open_dispute", "resolve_dispute", "create_job", "settle_job"]);
  assert.deepEqual(run.executions, ["1", "2"]);
  assert.equal(result.spentWei, "200");
  assert.equal(result.feesWei, "5");
  assert.equal(result.attempts[0].refundWei, "100");
  assert.equal(result.attempts[1].accepted, true);
  assert.deepEqual(result.result, { answer: "good" });
  const resolve = run.sends.find((item) => item.method === "resolve_dispute");
  assert.deepEqual(resolve.recipients, [buyerPlan.buyer, run.capabilities[0].provider]);
  assert.equal((await run.step()).status, "completed");
  assert.equal(run.sends.length, 5);
});

test("a successful result settles without a quality dispute", async () => {
  const run = fixture({ capabilityIds: ["2"] });
  await run.until((report) => report.status === "completed");
  assert.deepEqual(run.sends.map((item) => item.method), ["create_job", "settle_job"]);
});

test("refunds do not replenish gross spending authorization", async () => {
  const run = fixture({ maxSpendWei: "150" });
  const report = await run.until((value) => value.status === "budget_exhausted");
  assert.equal(report.spentWei, "100");
  assert.equal(report.attempts[0].refundWei, "100");
  assert.equal(run.sends.filter((item) => item.method === "create_job").length, 1);
});

test("fee caps stop before signing and total fee budgets include prior attempts", async () => {
  const expensive = fixture();
  expensive.transport.estimate = async () => ({ feeWei: "3" });
  assert.equal((await expensive.step()).status, "budget_exhausted");
  assert.equal(expensive.sends.length, 0);
  const limited = fixture({ maxFeeWei: "2", maxFeePerTransactionWei: "2" });
  const report = await limited.until((value) => value.status === "budget_exhausted");
  assert.equal(report.feesWei, "2");
  assert.equal(limited.sends.length, 2);
});

test("uncertain broadcasts persist and are never resent after restart", async () => {
  const run = fixture();
  run.transport.send = async () => { run.sends.push("unknown"); throw new Error("disconnected after broadcast"); };
  assert.equal((await run.step()).status, "needs_reconciliation");
  assert.equal((await run.step()).status, "needs_reconciliation");
  assert.equal(run.sends.length, 1);
  assert.equal(run.state().pending.hash, null);
});

test("a crash while saving the hash preserves the pre-send reservation", async () => {
  const run = fixture();
  const save = run.journal.write;
  run.journal.write = async (value) => { if (value.pending?.hash) throw new Error("disk failure"); await save(value); };
  await assert.rejects(run.step(), /disk failure/);
  assert.equal(run.state().pending.hash, null);
  run.journal.write = save;
  assert.equal((await run.step()).status, "needs_reconciliation");
  assert.equal(run.sends.length, 1);
});

test("pending transaction polls do not repeat writes or accept another sender", async () => {
  const run = fixture();
  await run.step();
  const transaction = run.transport.transaction;
  run.transport.transaction = async (hash) => ({ hash, sender: buyerPlan.buyer, recipient: buyerPlan.contractAddress, status: "ACCEPTED", successful: true });
  await run.step();
  await run.step();
  assert.equal(run.sends.length, 1);
  run.transport.transaction = async (hash) => ({ hash, sender: buyerPlan.contractAddress, recipient: buyerPlan.contractAddress, status: "FINALIZED", successful: true });
  await assert.rejects(run.step(), /identity/);
  run.transport.transaction = transaction;
  await run.step();
  assert.equal(run.state().pending, null);
});

test("lost provider responses are not replayed and missing delivery can recover", async () => {
  const run = fixture({ capabilityIds: ["1"] });
  run.setExecution("lost");
  await run.until(() => run.executions.length === 1);
  await run.step();
  assert.equal(run.executions.length, 1);
  run.advance(1801);
  const report = await run.until((value) => value.status === "exhausted");
  assert.equal(report.attempts[0].refundWei, "100");
  assert.equal(run.executions.length, 1);
  assert.deepEqual(run.sends.at(-1).recipients, [buyerPlan.buyer]);
});

test("missing evidence and expired adjudication have autonomous recovery paths", async () => {
  const missing = fixture({ capabilityIds: ["1"] });
  missing.setExecution("missing-evidence");
  await missing.until(() => missing.executions.length === 1);
  missing.advance(601);
  await missing.until((value) => value.status === "exhausted");
  assert.equal(missing.sends.at(-1).method, "recover_job");
  const dispute = fixture({ capabilityIds: ["1"] });
  dispute.fail.add("resolve_dispute");
  await dispute.until(() => dispute.sends.filter((item) => item.method === "resolve_dispute").length === 2);
  await dispute.step();
  await dispute.step();
  assert.equal(dispute.sends.filter((item) => item.method === "resolve_dispute").length, 2);
  dispute.advance(1801);
  await dispute.until((value) => value.status === "exhausted");
  assert.equal(dispute.sends.at(-1).method, "recover_job");
});

test("tampered evidence cannot be accepted or settled by the buyer", async () => {
  const run = fixture();
  await run.until(() => run.packets.size === 1);
  run.packets.get("1").output_json = '{"answer":"forged"}';
  await assert.rejects(run.step(), /protocol|deployment|commit/);
  assert.equal(run.sends.length, 1);
});

test("changed plans cannot reuse journals and inactive listings are skipped without payment", async () => {
  const run = fixture();
  await run.step();
  await assert.rejects(createBuyerWorkflow({ plan: { ...run.plan, maxSpendWei: "300" }, journal: run.journal, transport: run.transport }).step(), /authorized plan/);
  const inactive = fixture();
  inactive.capabilities[0].status = "paused";
  await inactive.until((value) => value.status === "completed");
  assert.equal(inactive.sends.filter((item) => item.method === "create_job").length, 1);
  assert.equal(inactive.state().attempts[0].outcome, "unavailable");
});

test("worker settlement before buyer evaluation still returns verified output", async () => {
  const run = fixture({ capabilityIds: ["2"] });
  await run.until(() => run.packets.size === 1);
  Object.assign(run.jobs[0], { status: "settled", refund_bps: 0, refund_wei: "0", outcome: "success" });
  const report = await run.step();
  assert.equal(report.status, "completed");
  assert.deepEqual(report.result, { answer: "good" });
  assert.equal(run.sends.length, 1);
});

test("job identity and escrow must match the funding authorization", async () => {
  for (const change of [{ job_id: "99" }, { escrow_wei: "101" }]) {
    const run = fixture();
    await run.until((value) => value.jobId === "1");
    const read = run.transport.read;
    run.transport.read = async (method, args) => {
      const value = await read(method, args);
      return method === "get_job" ? { ...value, ...change } : value;
    };
    await assert.rejects(run.step(), /authorized request/);
    assert.equal(run.executions.length, 0);
  }
});
