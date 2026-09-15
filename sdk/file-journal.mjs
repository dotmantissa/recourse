import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export function createFileJournal(filename, key, scope) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || typeof scope !== "string" || !scope) throw new Error("Journal encryption requires a 32-byte key and explicit scope");
  const path = resolve(filename);
  const directory = dirname(path);
  const lockPath = `${path}.lock`;

  async function read() {
    let text;
    try {
      if ((await stat(path)).size > 2_000_000) throw new Error("Buyer journal exceeds size limit");
      text = await readFile(path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    try {
      const packet = JSON.parse(text);
      if (packet.version !== 1 || packet.scope !== scope) throw new Error("scope mismatch");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(packet.iv, "base64"));
      decipher.setAAD(Buffer.from(scope));
      decipher.setAuthTag(Buffer.from(packet.tag, "base64"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(packet.data, "base64")), decipher.final()]);
      return JSON.parse(plaintext.toString("utf8"));
    } catch {
      throw new Error("Buyer journal authentication failed; do not reset or repeat a potentially funded run");
    }
  }

  async function write(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(scope));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const packet = JSON.stringify({ version: 1, scope, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
    if (Buffer.byteLength(packet) > 2_000_000) throw new Error("Buyer journal exceeds size limit");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(packet); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path);
      const parent = await open(directory, "r");
      try { await parent.sync(); } finally { await parent.close(); }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async function withLock(operation) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { await mkdir(lockPath, { mode: 0o700 }); } catch (error) {
      if (error.code === "EEXIST") throw new Error("Buyer journal is locked; stop other runners and reconcile any crashed run before removing its lock directory");
      throw error;
    }
    try {
      await writeFile(`${lockPath}/owner`, String(process.pid), { mode: 0o600 });
      return await operation();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }
  return { read, write, withLock };
}
