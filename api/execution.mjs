import { randomUUID } from "node:crypto";
import { HttpError, parseId } from "./http-safety.mjs";

export function createDurableExecutor({ store, execute, deliver, now = Date.now, leaseMs = 30 * 60_000, maxDeliveryAttempts = 8 }) {
  async function enqueue(key, commitment, input) {
    parseId(key);
    let entry = await store.read(key);
    if (!entry) {
      entry = await store.compareAndSet(key, null, {
        version: 1, commitment, input, phase: "queued", created_at: now(), delivery_attempts: 0,
      });
      if (!entry) entry = await store.read(key);
    }
    if (!entry || entry.value.commitment !== commitment) throw new HttpError(409, "job already has a different execution commitment");
    return entry.value;
  }

  async function run(key) {
    let entry = await store.read(key);
    if (!entry) return null;
    let record = entry.value;
    if (["delivered", "indeterminate", "delivery_failed"].includes(record.phase)) return record;
    if (record.next_attempt_at > now()) return record;
    if (record.phase === "executing") {
      if (record.lease_until > now()) return record;
      const stopped = await store.compareAndSet(key, entry.version, { ...record, phase: "indeterminate", reason: "execution_interrupted" });
      return stopped?.value ?? (await store.read(key))?.value;
    }
    if (record.phase === "queued") {
      const claim = await store.compareAndSet(key, entry.version, {
        ...record, phase: "executing", owner: randomUUID(), lease_until: now() + leaseMs,
      });
      if (!claim) return (await store.read(key))?.value;
      let result;
      try {
        result = await execute(claim.value.input);
      } catch {
        const failed = await store.compareAndSet(key, claim.version, { ...claim.value, phase: "indeterminate", reason: "execution_failed" });
        return failed?.value ?? (await store.read(key))?.value;
      }
      entry = await store.compareAndSet(key, claim.version, { ...claim.value, phase: "executed", result, executed_at: now() });
      if (!entry) return (await store.read(key))?.value;
      record = entry.value;
    }
    if (record.phase === "delivering" && record.lease_until > now()) return record;
    if (!["executed", "delivering"].includes(record.phase)) return record;
    if (record.delivery_attempts >= maxDeliveryAttempts) {
      const stopped = await store.compareAndSet(key, entry.version, { ...record, phase: "delivery_failed", reason: "delivery_retry_limit" });
      return stopped?.value ?? (await store.read(key))?.value;
    }
    const claim = await store.compareAndSet(key, entry.version, { ...record, phase: "delivering", owner: randomUUID(),
      lease_until: now() + leaseMs, delivery_attempts: record.delivery_attempts + 1 });
    if (!claim) return (await store.read(key))?.value;
    let result;
    try {
      result = await deliver(claim.value.result, claim.value.input);
    } catch {
      const retry = await store.compareAndSet(key, claim.version, { ...claim.value, phase: "executed", next_attempt_at: now() + 30_000 });
      return retry?.value ?? (await store.read(key))?.value;
    }
    const completed = await store.compareAndSet(key, claim.version, { ...claim.value, phase: "delivered", result, delivered_at: now() });
    return completed?.value ?? (await store.read(key))?.value;
  }

  return { enqueue, run };
}
