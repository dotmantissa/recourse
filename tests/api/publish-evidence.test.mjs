import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

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
