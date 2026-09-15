import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { describeContract } from "../../sdk/deployment.mjs";
import { selectReleaseDeployment } from "../../sdk/release-config.mjs";

test("committed release targets the current source and records its deployment transaction", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../deploy/release.json", import.meta.url), "utf8"));
  const source = await readFile(new URL("../../contracts/Recourse.py", import.meta.url), "utf8");
  const selected = selectReleaseDeployment(manifest);
  assert.equal(selected.sourceSha256, describeContract(source).sourceSha256);
  assert.match(selected.deploymentTransaction, /^0x[0-9a-f]{64}$/i);
  assert.equal(selected.configurationSource, "release_manifest");
});
