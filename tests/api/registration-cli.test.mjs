import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { MANIFEST_HASH } from "../../agents/catalog.mjs";

const execute = promisify(execFile);

test("registration prints an offline manifest plan without signing or networking", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-registration-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const guard = join(directory, "network-guard.mjs");
  await writeFile(guard, 'import net from "node:net"; net.Socket.prototype.connect = function () { throw new Error("Network forbidden"); };');
  const command = ["--import", guard, "scripts/register-agents.mjs"];
  const options = { env: { ...process.env, AGENT_SIGNING_KEY: "", CONTRACT_ADDRESS: "", RECOURSE_ADAPTER_URL: "" }, timeout: 20_000 };
  const { stdout } = await execute(process.execPath, command, options);
  const plan = JSON.parse(stdout);
  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.manifest_hash, MANIFEST_HASH);
  assert.equal(plan.agents.length, 5);
  assert.ok(plan.agents.every((agent) => agent.input_schema && agent.output_schema));
  await assert.rejects(execute(process.execPath, [...command, "--run"], options), /AGENT_SIGNING_KEY must/);
  await assert.rejects(execute(process.execPath, [...command, "--force"], options), /Usage:/);
});
