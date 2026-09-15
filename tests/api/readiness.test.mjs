import assert from "node:assert/strict";
import test from "node:test";
import { createReadiness, createStorageProbe } from "../../api/readiness.mjs";

test("dependency readiness caches probes, coalesces callers, and reports outages", async () => {
  let time = 0;
  let calls = 0;
  let fail = false;
  const probe = createReadiness({ now: () => time, ttlMs: 10, checks: { storage: async () => { calls += 1; if (fail) throw new Error("secret must not appear"); } } });
  const reports = await Promise.all([probe(), probe(), probe()]);
  assert.equal(calls, 1);
  assert.equal(reports[0].readiness, "dependencies_verified");
  await probe();
  assert.equal(calls, 1);
  time = 11;
  fail = true;
  assert.deepEqual(await probe(), { ok: false, readiness: "dependency_unavailable" });
  assert.equal(calls, 2);
});

test("readiness bounds a stalled dependency without publishing its error", async () => {
  const probe = createReadiness({ timeoutMs: 10, checks: { hung: () => new Promise(() => {}) } });
  assert.deepEqual(await probe(), { ok: false, readiness: "dependency_unavailable" });
});

test("storage readiness proves remote write/read restoration once and detects deletion", async () => {
  let stored;
  let writes = 0;
  const store = { compareAndSet: async (key, version, value) => { writes += 1; stored = { value }; return stored; }, read: async () => stored };
  const probe = createStorageProbe({ store, key: "1", nonce: "random-checkpoint" });
  await probe();
  await probe();
  assert.equal(writes, 1);
  stored = null;
  await assert.rejects(probe(), /restoration failed/);
  const restarted = createStorageProbe({ store, key: "2", nonce: "new-process" });
  await restarted();
  assert.equal(writes, 2);
});

test("readiness retries synchronous configuration failures after cache expiry", async () => {
  let time = 0;
  let fail = true;
  const probe = createReadiness({ now: () => time, ttlMs: 1, checks: { config: () => { if (fail) throw new Error("invalid"); } } });
  assert.equal((await probe()).ok, false);
  time = 2;
  fail = false;
  assert.equal((await probe()).ok, true);
});

test("readiness restores an ambiguously acknowledged storage checkpoint", async () => {
  let stored;
  const probe = createStorageProbe({ key: "1", nonce: "checkpoint", store: {
    read: async () => stored,
    compareAndSet: async (key, version, value) => { stored = { value }; throw new Error("response lost"); },
  } });
  await assert.rejects(probe(), /response lost/);
  await probe();
});
