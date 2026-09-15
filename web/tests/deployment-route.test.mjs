import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

test("public deployment identity reports only public configuration with no caching", async () => {
  const source = await readFile(new URL("../src/app/api/deployment/route.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  runInNewContext(compiled, { exports, Response, require: (name) => {
    if (name === "@/lib/config") return { CHAIN_ID: 61997, CONTRACT_ADDRESS: "contract", ADAPTER_URL: "adapter", RPC_URL: "rpc" };
    if (name.endsWith("manifest.json")) return { default: { version: 2 } };
    if (name.endsWith("protocol.mjs")) return { digest: () => "manifest-hash" };
    throw new Error(name);
  } });
  const response = exports.GET();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { chain_id: 61997, protocol_version: 2, contract_address: "contract", adapter_url: "adapter", rpc_url: "rpc", manifest_hash: "manifest-hash" });
});
