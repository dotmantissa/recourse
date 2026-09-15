import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const root = new URL("../../", import.meta.url);
const plan = { runId: "cli-test", chainId: 61997, contractAddress: `0x${"44".repeat(20)}`, buyer: `0x${"55".repeat(20)}`,
  capabilityIds: ["1"], requestLabel: "Public test", request: { message: "do not log this request" }, publicEvidence: true,
  maxSpendWei: "100", maxFeeWei: "20", maxFeePerTransactionWei: "2", maxTransactions: 10 };

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "recourse-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "plan.json");
  await writeFile(filename, JSON.stringify(plan));
  const guard = join(directory, "network-guard.mjs");
  await writeFile(guard, 'import net from "node:net"; net.Socket.prototype.connect = function () { throw new Error("Network forbidden in validation tests"); };');
  const run = (...args) => execute(process.execPath, ["--import", guard, "scripts/buyer.mjs", filename, ...args], {
    cwd: root, env: { ...process.env, BUYER_PRIVATE_KEY: "", STUDIO_DEV_RPC: "http://127.0.0.1:1" }, timeout: 20_000,
  });
  return { filename, run };
}

test("CLI defaults to offline validation and does not print request bodies", async (context) => {
  const { run } = await fixture(context);
  const { stdout } = await run();
  const report = JSON.parse(stdout);
  assert.equal(report.mode, "dry-run");
  assert.equal(report.runId, plan.runId);
  assert.equal(stdout.includes(plan.request.message), false);
});

test("CLI rejects unauthorized plans and requires its own buyer key", async (context) => {
  const { filename, run } = await fixture(context);
  await assert.rejects(run("--run", "--once"), /BUYER_PRIVATE_KEY must be configured/);
  await assert.rejects(run("--unexpected"), /Usage:/);
  await writeFile(filename, JSON.stringify({ ...plan, publicEvidence: false }));
  await assert.rejects(run(), /Explicit consent/);
  await writeFile(filename, "x".repeat(100_001));
  await assert.rejects(run(), /size limit/);
});

test("production backend and buyer readers explicitly select finalized state", async () => {
  for (const filename of ["api/server.mjs", "scripts/buyer.mjs"]) {
    const source = await readFile(new URL(filename, root), "utf8");
    const calls = source.match(/\.readContract\(\{[\s\S]*?\}\)/g);
    assert.equal(calls?.length, 1, filename);
    assert.match(calls[0], /transactionHashVariant:\s*TransactionHashVariant\.LATEST_FINAL/);
  }
});
