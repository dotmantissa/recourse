import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { canonicalJson, digest, requestCommitment } from "../../sdk/protocol.mjs";

const run = promisify(execFile);

test("evidence CLI rejects traversal and non-object packets before writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-evidence-test-"));
  try {
    const input = join(directory, "packet.json");
    for (const packet of [null, [], { job_id: "../outside" }, { job_id: "/tmp/outside" }, { job_id: "01" }, { job_id: 9007199254740992 }]) {
      await writeFile(input, JSON.stringify(packet));
      await assert.rejects(run(process.execPath, ["scripts/publish-evidence.mjs", input]), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /JSON object|positive numeric ID/);
        return true;
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("evidence CLI verifies scoped content and refuses overwrites", async () => {
  const signer = privateKeyToAccount(generatePrivateKey());
  const contract = signer.address.toLowerCase();
  const directory = await mkdtemp(join(tmpdir(), "recourse-evidence-test-"));
  const outputDirectory = join(process.cwd(), "evidence", `61997-${contract}`);
  const requestJson = requestCommitment({ chainId: 61997, contractAddress: contract, capabilityId: "1", requestLabel: "Test", request: { query: "Test" }, nonce: "test-nonce" });
  const outputJson = canonicalJson({ result: "Test" });
  const core = { version: "recourse-receipt-v2", chain_id: 61997, contract_address: contract, capability_id: "1",
    job_id: "1", provider: signer.address, request_hash: `sha256:${digest(requestJson)}`, output_hash: `sha256:${digest(outputJson)}`,
    response_status: "success", response_code: 200, latency_ms: 10, schema_valid: true, completed_at: "2026-01-01T00:00:00Z" };
  const receiptHash = digest(core);
  const packet = { ...core, receipt_hash: receiptHash, receipt_signature: await signer.signMessage({ message: { raw: `0x${receiptHash}` } }),
    request_json: requestJson, output_json: outputJson };
  try {
    const input = join(directory, "packet.json");
    await writeFile(input, JSON.stringify({ ...packet, output_json: "{}" }));
    await assert.rejects(run(process.execPath, ["scripts/publish-evidence.mjs", input]));
    await writeFile(input, JSON.stringify(packet));
    const { stdout } = await run(process.execPath, ["scripts/publish-evidence.mjs", input]);
    assert.equal(JSON.parse(stdout).outputPath, join(outputDirectory, "1.json"));
    assert.deepEqual(JSON.parse(await readFile(join(outputDirectory, "1.json"), "utf8")), packet);
    await assert.rejects(run(process.execPath, ["scripts/publish-evidence.mjs", input]), /EEXIST/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
