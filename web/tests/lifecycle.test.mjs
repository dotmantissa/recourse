import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/lifecycle.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
runInNewContext(compiled, { exports });
const { recoveryReady, canDispute } = exports;

test("recovery controls wait for receipt, evidence or adjudication deadlines", () => {
  const job = { status: "accepted", deadline_at: 100, receipt_deadline_at: 200 };
  assert.equal(recoveryReady(job, 100_000), false);
  assert.equal(recoveryReady(job, 200_000), true);
  assert.equal(recoveryReady({ ...job, protocol_version: 1 }, 200_000), false);
  assert.equal(recoveryReady({ status: "receipt_submitted", evidence_id: "", evidence_deadline_at: 300 }, 300_000), true);
  assert.equal(recoveryReady({ status: "receipt_submitted", evidence_id: "1", evidence_deadline_at: 300 }, 300_000), false);
  assert.equal(recoveryReady({ status: "disputed", evidence_id: "1", resolution_deadline_at: 400 }, 400_000), true);
  assert.equal(recoveryReady({ status: "settled", receipt_deadline_at: 1 }, 400_000), false);
});

test("buyers can dispute without evidence but not after the challenge window", () => {
  const job = { status: "receipt_submitted", evidence_id: "", challenge_deadline_at: 300 };
  assert.equal(canDispute(job, 299_999), true);
  assert.equal(canDispute(job, 300_000), false);
  assert.equal(canDispute({ ...job, status: "settled" }, 1), false);
});
