import assert from "node:assert/strict";
import test from "node:test";
import { createDurableExecutor } from "../../api/execution.mjs";
import { createGithubStateStore } from "../../api/github-state-store.mjs";

function memoryStore() {
  const records = new Map();
  let revision = 0;
  return {
    async read(key) { return structuredClone(records.get(key) ?? null); },
    async compareAndSet(key, version, value) {
      if ((records.get(key)?.version ?? null) !== version) return null;
      const entry = { version: String(++revision), value: structuredClone(value) };
      records.set(key, entry);
      return structuredClone(entry);
    },
  };
}

test("concurrent workers claim provider work exactly once", async () => {
  const store = memoryStore();
  let executions = 0;
  let deliveries = 0;
  const settings = { store, execute: async () => { executions += 1; return { output: "real" }; },
    deliver: async (result) => { deliveries += 1; return result; } };
  const first = createDurableExecutor(settings);
  const second = createDurableExecutor(settings);
  await Promise.all([first.enqueue("1", "hash", {}), second.enqueue("1", "hash", {})]);
  await Promise.all([first.run("1"), second.run("1")]);
  await second.run("1");
  assert.equal(executions, 1);
  assert.equal(deliveries, 1);
  assert.equal((await store.read("1")).value.phase, "delivered");
  await assert.rejects(first.enqueue("1", "different", {}), { status: 409 });
});

test("restarted workers retry delivery without repeating provider execution", async () => {
  const store = memoryStore();
  let time = 100;
  let executions = 0;
  const initial = createDurableExecutor({ store, now: () => time,
    execute: async () => { executions += 1; return { output: "real" }; }, deliver: async () => { throw new Error("storage offline"); } });
  await initial.enqueue("1", "hash", {});
  assert.equal((await initial.run("1")).phase, "executed");
  time += 31_000;
  const restarted = createDurableExecutor({ store, now: () => time,
    execute: async () => { throw new Error("must not execute twice"); }, deliver: async (result) => result });
  assert.equal((await restarted.run("1")).phase, "delivered");
  assert.equal(executions, 1);
});

test("a crashed execution becomes indeterminate instead of being billed twice", async () => {
  const store = memoryStore();
  await store.compareAndSet("1", null, { phase: "executing", lease_until: 100, commitment: "hash" });
  const executor = createDurableExecutor({ store, now: () => 101,
    execute: async () => { assert.fail("must not repeat unknown work"); }, deliver: async () => {} });
  assert.equal((await executor.run("1")).phase, "indeterminate");
  assert.equal((await executor.run("1")).phase, "indeterminate");
});

test("delivery retries stop at the configured attempt budget", async () => {
  const store = memoryStore();
  let time = 100;
  const executor = createDurableExecutor({ store, now: () => time, maxDeliveryAttempts: 2,
    execute: async () => ({}), deliver: async () => { throw new Error("offline"); } });
  await executor.enqueue("1", "hash", {});
  await executor.run("1");
  time += 31_000;
  await executor.run("1");
  time += 31_000;
  assert.equal((await executor.run("1")).phase, "delivery_failed");
});

test("GitHub checkpoints use conditional revisions and encrypted payloads", async () => {
  const requests = [];
  const store = createGithubStateStore({ repository: "owner/repo", branch: "evidence", scope: "scope",
    encode: (value) => ({ encrypted: value }), decode: (value) => value.encrypted,
    request: async (path, options) => {
      requests.push({ path, options });
      return options ? Response.json({ content: { sha: "next" } })
        : Response.json({ sha: "previous", encoding: "base64", content: Buffer.from(JSON.stringify({ encrypted: { phase: "queued" } })).toString("base64") });
    } });
  assert.equal((await store.read("1")).version, "previous");
  await store.compareAndSet("1", "previous", { phase: "executing" });
  const body = JSON.parse(requests[1].options.body);
  assert.equal(body.sha, "previous");
  assert.deepEqual(JSON.parse(Buffer.from(body.content, "base64")), { encrypted: { phase: "executing" } });
  assert.match(requests[1].path, /executions\/scope\/1.json$/);
});
