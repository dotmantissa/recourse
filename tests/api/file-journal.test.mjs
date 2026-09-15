import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileJournal } from "../../sdk/file-journal.mjs";

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "recourse-journal-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "private", "state.json");
  const key = randomBytes(32);
  return { filename, key, journal: createFileJournal(filename, key, "buyer-scope") };
}

test("journal persists encrypted atomic checkpoints with private permissions", async (context) => {
  const { filename, journal } = await fixture(context);
  assert.equal(await journal.read(), null);
  const value = { pending: { hash: null }, request: "private buyer request" };
  await journal.withLock(() => journal.write(value));
  assert.deepEqual(await journal.read(), value);
  assert.equal((await readFile(filename, "utf8")).includes(value.request), false);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.equal((await stat(join(filename, ".."))).mode & 0o777, 0o700);
  await journal.withLock(() => journal.write({ ...value, pending: { hash: "saved" } }));
  assert.equal((await journal.read()).pending.hash, "saved");
  assert.deepEqual(await readdir(join(filename, "..")), ["state.json"]);
});

test("wrong key, scope, tampering, and corrupt packets fail closed", async (context) => {
  const { filename, key, journal } = await fixture(context);
  await journal.write({ writes: 1 });
  await assert.rejects(createFileJournal(filename, randomBytes(32), "buyer-scope").read(), /authentication failed/);
  await assert.rejects(createFileJournal(filename, key, "other-scope").read(), /authentication failed/);
  const original = await readFile(filename, "utf8");
  const packet = JSON.parse(original);
  const data = Buffer.from(packet.data, "base64");
  data[0] ^= 1;
  packet.data = data.toString("base64");
  await writeFile(filename, JSON.stringify(packet));
  await assert.rejects(journal.read(), /authentication failed/);
  await writeFile(filename, "not json");
  await assert.rejects(journal.read(), /authentication failed/);
});

test("journal lock excludes other instances and releases on failure", async (context) => {
  const { filename, key, journal } = await fixture(context);
  const other = createFileJournal(filename, key, "buyer-scope");
  await journal.withLock(async () => {
    await assert.rejects(other.withLock(() => assert.fail("must not run")), /locked/);
  });
  await assert.rejects(journal.withLock(async () => { throw new Error("operation failure"); }), /operation failure/);
  await other.withLock(() => other.write({ ok: true }));
  assert.deepEqual(await journal.read(), { ok: true });
});

test("oversized checkpoints preserve the prior durable state", async (context) => {
  const { filename, journal } = await fixture(context);
  await journal.write({ writes: 1 });
  await assert.rejects(journal.write({ data: "x".repeat(2_000_000) }), /size limit/);
  assert.deepEqual(await journal.read(), { writes: 1 });
  await writeFile(filename, "x".repeat(2_000_001));
  await assert.rejects(journal.read(), /size limit/);
  assert.throws(() => createFileJournal(filename, randomBytes(16), "scope"), /32-byte/);
});
