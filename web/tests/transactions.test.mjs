import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/transactions.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
runInNewContext(compiled, { exports, crypto: webcrypto });
const { pendingTransactionKey, readPendingTransaction, submitTrackedTransaction, resumeTrackedTransaction, acknowledgeUnbroadcastTransaction, transactionOutcome } = exports;
const scope = { chainId: 61997, contractAddress: `0x${"ab".repeat(20)}`, wallet: `0x${"cd".repeat(20)}` };
const hash = `0x${"ef".repeat(32)}`;
const quote = { method: "create_job", valueWei: "2000000000000000000", feeWei: "170000000000000000", totalWei: "2170000000000000000", recipients: [] };

function fixture() {
  const records = new Map();
  const locks = new Set();
  const storage = { getItem: (key) => records.get(key) ?? null, setItem: (key, value) => records.set(key, value), removeItem: (key) => records.delete(key) };
  const environment = { storage, scope, changed() {}, lock: async (key, operation) => {
    if (locks.has(key)) throw new Error("another tab owns the lock");
    locks.add(key);
    try { return await operation(); } finally { locks.delete(key); }
  } };
  return { environment, records, storage };
}

test("fee cancellation and invalid budgets never submit or leave an intent", async () => {
  const { environment, records } = fixture();
  const prepare = async () => ({ quote, send: () => { throw new Error("must not send"); } });
  await assert.rejects(submitTrackedTransaction(environment, prepare, async () => false, async () => true), /cancelled/);
  await assert.rejects(submitTrackedTransaction(environment, async () => ({ ...(await prepare()), quote: { ...quote, totalWei: "1" } }), async () => true, async () => true), /Invalid fee/);
  assert.equal(records.size, 0);
});

test("a stale fee approval cannot submit after its two-minute validity window", async () => {
  const { environment, records } = fixture();
  let time = 100;
  const timed = {};
  runInNewContext(compiled, { exports: timed, crypto: webcrypto, Date: class extends Date { static now() { return time; } } });
  await assert.rejects(timed.submitTrackedTransaction(environment, async () => ({ quote, send: async () => { throw new Error("must not send"); } }), async () => { time += 120_000; return true; }, async () => true), /expired/);
  assert.equal(records.size, 0);
});

test("a known broadcast hash cannot be cleared by the unbroadcast override", async () => {
  const { environment, storage } = fixture();
  await assert.rejects(submitTrackedTransaction(environment, async () => ({ quote, send: async () => hash }), async () => true, async () => { throw new Error("pending"); }));
  const record = readPendingTransaction(storage, scope);
  await assert.rejects(acknowledgeUnbroadcastTransaction(environment, record.id, true), /verified unbroadcast/);
  assert.equal(readPendingTransaction(storage, scope).hash, hash);
});

test("a pre-submission intent and returned hash are persisted before polling", async () => {
  const { environment, records, storage } = fixture();
  const prepare = async () => ({ quote, send: async () => {
    const record = readPendingTransaction(storage, scope);
    assert.equal(record.hash, null);
    assert.equal(record.method, "create_job");
    assert.equal(record.valueWei, quote.valueWei);
    assert.equal("args" in record, false);
    return hash;
  } });
  assert.equal(await submitTrackedTransaction(environment, prepare, async () => true, async (record) => {
    assert.equal(readPendingTransaction(storage, scope).hash, hash);
    assert.equal(record.hash, hash);
    return true;
  }), hash);
  assert.equal(records.size, 0);
});

test("timeouts survive reload and resume only polls the same transaction", async () => {
  const { environment, storage, records } = fixture();
  let sends = 0;
  const prepare = async () => ({ quote, send: async () => { sends += 1; return hash; } });
  await assert.rejects(submitTrackedTransaction(environment, prepare, async () => true, async () => { throw new Error("RPC timeout"); }), /ID is saved/);
  assert.equal(readPendingTransaction(storage, scope).hash, hash);
  await assert.rejects(submitTrackedTransaction(environment, prepare, async () => true, async () => true), /reconciliation/);
  const reloaded = { ...environment, changed() {} };
  assert.equal(await resumeTrackedTransaction(reloaded, async (record) => { assert.equal(record.hash, hash); return true; }), hash);
  assert.equal(sends, 1);
  assert.equal(records.size, 0);
});

test("unknown broadcast outcomes block retries and cannot be blindly dismissed", async () => {
  const { environment, storage, records } = fixture();
  await assert.rejects(submitTrackedTransaction(environment, async () => ({ quote, send: async () => { throw new Error("connection lost after wallet prompt"); } }), async () => true, async () => true), /outcome is unknown/);
  const record = readPendingTransaction(storage, scope);
  assert.equal(record.hash, null);
  await assert.rejects(resumeTrackedTransaction(environment, async () => true), /No saved transaction/);
  await assert.rejects(acknowledgeUnbroadcastTransaction(environment, record.id, false), /verified unbroadcast/);
  await assert.rejects(acknowledgeUnbroadcastTransaction(environment, "another-intent", true), /verified unbroadcast/);
  await acknowledgeUnbroadcastTransaction(environment, record.id, true);
  assert.equal(records.size, 0);
});

test("definite wallet rejection clears the intent; finalized failure is not retried", async () => {
  const { environment, records } = fixture();
  await assert.rejects(submitTrackedTransaction(environment, async () => ({ quote, send: async () => { throw { cause: { code: 4001 } }; } }), async () => true, async () => true), /wallet rejected/);
  assert.equal(records.size, 0);
  await assert.rejects(submitTrackedTransaction(environment, async () => ({ quote, send: async () => hash }), async () => true, async () => false), /Fees may still/);
  assert.equal(records.size, 0);
});

test("storage errors fail closed before sending and preserve uncertain submitted intents", async () => {
  const { environment, storage } = fixture();
  let sends = 0;
  const prepare = async () => ({ quote, send: async () => { sends += 1; return hash; } });
  const failing = { ...environment, storage: { ...storage, setItem() { throw new Error("quota exceeded"); } } };
  await assert.rejects(submitTrackedTransaction(failing, prepare, async () => true, async () => true), /quota/);
  assert.equal(sends, 0);
  let saves = 0;
  const failHash = { ...environment, storage: { ...storage, setItem(key, value) {
    saves += 1;
    if (saves > 1) throw new Error("quota exceeded");
    storage.setItem(key, value);
  } } };
  await assert.rejects(submitTrackedTransaction(failHash, prepare, async () => true, async () => true), /ID could not be saved/);
  assert.equal(sends, 1);
  assert.equal(readPendingTransaction(storage, scope).hash, null);
});

test("cross-tab locking blocks duplicate prompts and manual clearing during a write", async () => {
  const { environment, storage } = fixture();
  let release;
  const sending = new Promise((resolve) => { release = resolve; });
  let notify;
  const started = new Promise((resolve) => { notify = resolve; });
  const first = submitTrackedTransaction(environment, async () => ({ quote, send: async () => { notify(); await sending; return hash; } }), async () => true, async () => true);
  await started;
  await assert.rejects(submitTrackedTransaction(environment, async () => { throw new Error("must not estimate"); }, async () => true, async () => true), /another tab/);
  await assert.rejects(acknowledgeUnbroadcastTransaction(environment, readPendingTransaction(storage, scope).id, true), /another tab/);
  release();
  await first;
});

test("stored records are scoped and corrupt records block new submissions", async () => {
  const { environment, storage } = fixture();
  await assert.rejects(submitTrackedTransaction(environment, async () => ({ quote, send: async () => hash }), async () => true, async () => { throw new Error("pending"); }));
  for (const change of [{ chainId: 1 }, { wallet: scope.contractAddress }, { contractAddress: scope.wallet }]) {
    assert.equal(readPendingTransaction(storage, { ...scope, ...change }), null);
  }
  const key = pendingTransactionKey(scope);
  for (const value of ["{broken", "null", JSON.stringify({ version: 1, ...scope, hash: "bad" })]) {
    storage.setItem(key, value);
    assert.throws(() => readPendingTransaction(storage, scope));
    await assert.rejects(submitTrackedTransaction(environment, async () => { throw new Error("must not prepare"); }, async () => true, async () => true));
  }
});

test("accepted is not finalized and transaction identity is verified", () => {
  const record = { ...scope, hash };
  const transaction = { sender: scope.wallet, recipient: scope.contractAddress, hash, statusName: "ACCEPTED", successful: true };
  assert.equal(transactionOutcome(transaction, record), null);
  assert.equal(transactionOutcome({ ...transaction, statusName: "FINALIZED" }, record), true);
  assert.equal(transactionOutcome({ ...transaction, statusName: "FINALIZED", successful: false }, record), false);
  assert.equal(transactionOutcome({ ...transaction, statusName: "CANCELED" }, record), false);
  for (const change of [{ sender: scope.contractAddress }, { recipient: scope.wallet }, { hash: `0x${"01".repeat(32)}` }]) {
    assert.throws(() => transactionOutcome({ ...transaction, ...change }, record), /identity/);
  }
});
