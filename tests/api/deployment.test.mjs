import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { describeContract, validateReleaseConfiguration, verifyDeployment, verifyHostedRelease } from "../../sdk/deployment.mjs";

const source = await readFile(new URL("../../contracts/Recourse.py", import.meta.url), "utf8");
const description = describeContract(source);
const address = `0x${"11".repeat(20)}`;
const execute = promisify(execFile);

function fixture() {
  const counts = { capabilities: 5, jobs: 0, evidence: 0, disputes: 0 };
  const client = { getChainId: async () => 61997, getContractCode: async () => source,
    getContractSchema: async () => ({ methods: Object.fromEntries(description.methods.map((method) => [method, {}])) }),
    readContract: async (options) => { assert.equal(options.transactionHashVariant, "latest-final"); return JSON.stringify(counts); } };
  const metadata = { chainId: 61997, contractAddress: address, sourceSha256: description.sourceSha256, rpc: "https://rpc.example/api" };
  const backend = { CONTRACT_ADDRESS: address, RECOURSE_CONTRACT_ADDRESS: address, STUDIO_DEV_RPC: metadata.rpc,
    PUBLIC_BASE_URL: "https://adapter.example", RECOURSE_ADAPTER_URL: "https://adapter.example", FRONTEND_ORIGIN: "https://frontend.example" };
  const frontend = { NEXT_PUBLIC_RECOURSE_CONTRACT_ADDRESS: address, NEXT_PUBLIC_RECOURSE_CHAIN_ID: "61997", NEXT_PUBLIC_RECOURSE_RPC: metadata.rpc,
    NEXT_PUBLIC_RECOURSE_ADAPTER_URL: backend.PUBLIC_BASE_URL };
  const releaseManifest = { schemaVersion: 1, protocolVersion: 2, ...metadata };
  return { client, counts, metadata, backend, frontend, source, releaseManifest };
}

test("deployment verification derives all current methods and requires finalized counts", async () => {
  const { client, counts } = fixture();
  assert.equal(description.methods.length, 29);
  const result = await verifyDeployment({ client, address, source, recordedHash: description.sourceSha256 });
  assert.deepEqual({ ...result.counts }, counts);
  assert.equal(result.protocolVersion, 2);
});

test("deployment verification checksums every Studio RPC contract target", async () => {
  const { client } = fixture();
  const checksumAddress = "0x58ffB067A2dee35B81f5fBED66969484c98b6975";
  for (const method of ["getContractSchema", "getContractCode", "readContract"]) {
    const original = client[method];
    client[method] = async (argument) => {
      assert.equal(typeof argument === "string" ? argument : argument.address, checksumAddress);
      return original(argument);
    };
  }
  await verifyDeployment({ client, address: checksumAddress.toLowerCase(), source });
});

test("deployment verification rejects wrong chain, stale code, schema, and metadata", async () => {
  for (const [method, value, pattern] of [["getChainId", 1, /chain/], ["getContractCode", "old source", /source hashes/],
    ["getContractSchema", { methods: {} }, /method schema/], ["readContract", '{"jobs":0}', /counts/]]) {
    const { client } = fixture();
    client[method] = async () => value;
    await assert.rejects(verifyDeployment({ client, address, source }), pattern);
  }
  await assert.rejects(verifyDeployment({ client: fixture().client, address, source, recordedHash: "stale" }), /Recorded/);
});

test("release configuration validates the effective manifest deployment and origins", () => {
  const input = fixture();
  assert.equal(validateReleaseConfiguration(input).contractAddress, address);
  for (const [section, key, value] of [["backend", "RECOURSE_ADAPTER_URL", "https://old.example"],
    ["releaseManifest", "contractAddress", `0x${"22".repeat(20)}`], ["releaseManifest", "rpc", "https://old.example"],
    ["releaseManifest", "sourceSha256", "b".repeat(64)], ["metadata", "sourceSha256", "old"], ["backend", "FRONTEND_ORIGIN", "http://localhost:3000"]]) {
    const changed = { ...input, [section]: { ...input[section], [key]: value } };
    assert.throws(() => validateReleaseConfiguration(changed));
  }
});

test("preflight ignores inactive legacy variables but checks explicit environment overrides", () => {
  const input = fixture();
  input.backend.RECOURSE_CONTRACT_ADDRESS = `0x${"22".repeat(20)}`;
  input.frontend.NEXT_PUBLIC_RECOURSE_RPC = "https://old.example";
  assert.equal(validateReleaseConfiguration(input).contractAddress, address);
  input.backend.RECOURSE_DEPLOYMENT_MODE = "environment";
  assert.throws(() => validateReleaseConfiguration(input));
  input.backend.RECOURSE_CONTRACT_ADDRESS = address;
  input.backend.STUDIO_DEV_CHAIN_ID = "61997";
  assert.equal(validateReleaseConfiguration(input).backendConfigurationSource, "explicit_environment");
  input.frontend.NEXT_PUBLIC_RECOURSE_DEPLOYMENT_MODE = "environment";
  assert.throws(() => validateReleaseConfiguration(input), /Effective deployment/);
});

test("hosted release checks identities without claiming paid-flow acceptance", async () => {
  const release = validateReleaseConfiguration(fixture());
  const manifestHash = "a".repeat(64);
  const identity = { chain_id: 61997, protocol_version: 2, contract_address: address, manifest_hash: manifestHash, rpc_url: release.rpc, source_sha256: description.sourceSha256 };
  const records = { "/agents": { ...identity, provider: `0x${"33".repeat(20)}` }, "/ready": { ...identity, ok: true, readiness: "dependencies_verified" },
    "/api/deployment": { ...identity, adapter_url: release.adapter } };
  const fetcher = async (url) => Response.json(records[new URL(url).pathname]);
  const report = await verifyHostedRelease({ release, manifestHash, fetcher });
  assert.equal(report.configurationConsistent, true);
  assert.equal(report.liveAcceptanceComplete, false);
  records["/ready"].source_sha256 = "stale";
  await assert.rejects(verifyHostedRelease({ release, manifestHash, fetcher }), /source identity/);
  records["/ready"].source_sha256 = description.sourceSha256;
  records["/api/deployment"].manifest_hash = "old";
  await assert.rejects(verifyHostedRelease({ release, manifestHash, fetcher }), /stale/);
  await assert.rejects(verifyHostedRelease({ release, manifestHash, fetcher: async () => new Response("not ready", { status: 503 }) }), /unavailable/);
});

test("deployment defaults to offline planning and the synthetic demo cannot write", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-deploy-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const guard = join(directory, "no-network.mjs");
  await writeFile(guard, 'import net from "node:net"; net.Socket.prototype.connect = function () { throw new Error("Network forbidden"); };');
  const options = { env: { ...process.env, DEPLOYER_KEY: "", DEPLOYMENT_MAX_FEE_WEI: "" }, timeout: 20_000 };
  const { stdout } = await execute(process.execPath, ["--import", guard, "deploy/deploy.mjs"], options);
  const plan = JSON.parse(stdout);
  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.sourceSha256, description.sourceSha256);
  await assert.rejects(execute(process.execPath, ["--import", guard, "deploy/deploy.mjs", "--run"], options), /DEPLOYER_KEY must/);
  await assert.rejects(execute(process.execPath, ["--import", guard, "scripts/studio-dev-demo.mjs"], options), /Retired/);
});
