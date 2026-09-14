import assert from "node:assert/strict";
import test from "node:test";
import { maintenanceAction, runMaintenance } from "../../api/maintenance.mjs";

test("maintenance protects challenges and recovers missing evidence or adjudication", () => {
  assert.equal(maintenanceAction({ status: "funded", receipt_deadline_at: 200 }, 199), null);
  assert.equal(maintenanceAction({ status: "funded", receipt_deadline_at: 200 }, 200), "recover_job");
  assert.equal(maintenanceAction({ status: "receipt_submitted", evidence_id: "1", deadline_at: 100, challenge_deadline_at: 300 }, 299), null);
  assert.equal(maintenanceAction({ status: "receipt_submitted", evidence_id: "1", deadline_at: 100, challenge_deadline_at: 300 }, 300), "settle_job");
  assert.equal(maintenanceAction({ status: "receipt_submitted", evidence_id: "", evidence_deadline_at: 200 }, 200), "recover_job");
  assert.equal(maintenanceAction({ status: "disputed", evidence_id: "1", resolution_deadline_at: 300 }, 200), "resolve_dispute");
  assert.equal(maintenanceAction({ status: "disputed", evidence_id: "1", resolution_deadline_at: 300 }, 300), "recover_job");
});

test("maintenance has a persistent retry budget and reserves both recipients", async () => {
  let entry = null;
  let version = 0;
  let attempts = 0;
  let time = 100;
  const store = {
    read: async () => structuredClone(entry),
    compareAndSet: async (key, expected, value) => {
      if ((entry?.version ?? null) !== expected) return null;
      entry = { version: String(++version), value };
      return structuredClone(entry);
    },
  };
  const job = { job_id: "1", buyer: "buyer", provider: "provider", dispute_id: "2" };
  const settings = { store, job, action: "resolve_dispute", now: () => time, submit: async (action, id, recipients) => {
    assert.equal(id, "2");
    assert.deepEqual(recipients, ["buyer", "provider"]);
    attempts += 1;
    throw new Error("consensus unavailable");
  } };
  for (let index = 0; index < 12; index += 1) {
    await runMaintenance(settings);
    time += 61_000;
  }
  assert.equal(attempts, 8);
  await runMaintenance({ ...settings, action: "recover_job", submit: async () => "transaction" });
  assert.equal(entry.value.complete, true);
});
