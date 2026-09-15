import assert from "node:assert/strict";
import test from "node:test";
import { selectReleaseDeployment } from "../../sdk/release-config.mjs";
import { getAddress } from "viem";

const release = { schemaVersion: 1, protocolVersion: 2, chainId: 61997, contractAddress: `0x${"ab".repeat(20)}`,
  rpc: "https://studio-dev.genlayer.com/api", sourceSha256: "a".repeat(64) };

test("one release manifest takes precedence over stale cloud address variables", () => {
  const selected = selectReleaseDeployment(release, { contractAddress: `0x${"cd".repeat(20)}`, chainId: 1, rpc: "https://old.example" });
  assert.equal(selected.contractAddress, getAddress(release.contractAddress));
  assert.equal(selected.chainId, release.chainId);
  assert.equal(selected.rpc, release.rpc);
  assert.equal(selected.configurationSource, "release_manifest");
});

test("preview overrides require an explicit mode and a complete valid deployment", () => {
  const settings = { mode: "environment", contractAddress: `0x${"cd".repeat(20)}`, chainId: "61997", rpc: "https://preview.example/api" };
  assert.equal(selectReleaseDeployment(release, settings).contractAddress, getAddress(settings.contractAddress));
  assert.equal(selectReleaseDeployment(release, settings).configurationSource, "explicit_environment");
  for (const field of ["contractAddress", "chainId", "rpc"]) {
    assert.throws(() => selectReleaseDeployment(release, { ...settings, [field]: undefined }));
  }
  assert.throws(() => selectReleaseDeployment(release, { mode: "latest" }));
});

test("RPC targets retain checksum spelling even when configuration is lowercase", () => {
  const address = "0x58ffB067A2dee35B81f5fBED66969484c98b6975";
  assert.equal(selectReleaseDeployment({ ...release, contractAddress: address.toLowerCase() }).contractAddress, address);
});

test("release validation rejects unsupported or unsafe contract manifests", () => {
  for (const changes of [{ protocolVersion: 1 }, { schemaVersion: 0 }, { sourceSha256: "stale" }, { chainId: 1 },
    { contractAddress: "" }, { contractAddress: `0x${"0".repeat(40)}` }, { rpc: "http://rpc.example" }, { rpc: "https://user:password@rpc.example" }]) {
    assert.throws(() => selectReleaseDeployment({ ...release, ...changes }));
  }
});
