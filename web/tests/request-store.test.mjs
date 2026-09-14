import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/request-store.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

class Storage {
  getItem(key) { return this[key] ?? null; }
  setItem(key, value) { this[key] = value; }
  removeItem(key) { delete this[key]; }
}

function loadStore(sessionStorage, localStorage, contract = "first") {
  const exports = {};
  runInNewContext(compiled, { exports, sessionStorage, localStorage,
    require: () => ({ CHAIN_ID: 61997, CONTRACT_ADDRESS: contract }) });
  return exports;
}

test("request inputs are scoped to wallet and deployment and kept out of local storage", () => {
  const session = new Storage();
  const persistent = new Storage();
  const store = loadStore(session, persistent);
  const job = { job_id: "1", buyer: "buyer-a", request_hash: "hash" };
  store.saveRequestContext(job, { secret: "private" }, "nonce");
  assert.equal(store.loadRequestContext(job).request.secret, "private");
  assert.equal(store.loadRequestContext({ ...job, buyer: "buyer-b" }), null);
  assert.equal(loadStore(session, persistent, "second").loadRequestContext(job), null);
  assert.equal(Object.keys(persistent).length, 0);
  store.saveRequestContext({ ...job, buyer: "buyer-b" }, {}, "other");
  persistent.setItem("recourse:request:1", "legacy plaintext");
  store.clearSessionInputs(job.buyer);
  assert.equal(store.loadRequestContext(job), null);
  assert.equal(store.loadRequestContext({ ...job, buyer: "buyer-b" }).nonce, "other");
  assert.equal(persistent.getItem("recourse:request:1"), null);
});

test("pending requests recover only into their buyer's matching onchain job", () => {
  const store = loadStore(new Storage(), new Storage());
  const job = { job_id: "1", buyer: "buyer-a", request_hash: "hash" };
  store.savePendingRequest("hash", { buyer: "buyer-a", capabilityId: "2", requestLabel: "Work", request: {}, nonce: "nonce" });
  store.recoverPendingRequestContexts([{ ...job, buyer: "buyer-b" }]);
  assert.equal(store.loadRequestContext(job), null);
  store.recoverPendingRequestContexts([job]);
  assert.equal(store.loadRequestContext(job).nonce, "nonce");
});
