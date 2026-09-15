import assert from "node:assert/strict";
import test from "node:test";
import { retryRpcRead } from "../../sdk/rpc-read.mjs";

test("RPC confirmation retries only the supplied read and returns its result", async () => {
  let reads = 0;
  const receipt = await retryRpcRead(async () => {
    reads += 1;
    if (reads < 3) throw new SyntaxError("Upstream returned HTML");
    return { status: "FINALIZED" };
  }, { delayMs: 0 });
  assert.equal(reads, 3);
  assert.equal(receipt.status, "FINALIZED");
});

test("RPC read retries are bounded and preserve the final failure", async () => {
  let reads = 0;
  const failure = new Error("RPC unavailable");
  await assert.rejects(retryRpcRead(async () => { reads += 1; throw failure; }, { attempts: 2, delayMs: 0 }), error => error === failure);
  assert.equal(reads, 2);
  await assert.rejects(retryRpcRead(async () => {}, { attempts: 0 }), /limits/);
});
