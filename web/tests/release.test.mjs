import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/release.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
runInNewContext(compiled, { exports, AbortSignal });
const expected = { adapter: "https://adapter.example", chainId: 61997, contractAddress: `0x${"11".repeat(20)}`, rpc: "https://rpc.example", manifestHash: "manifest" };
const identity = { ok: true, readiness: "dependencies_verified", protocol_version: 2, chain_id: expected.chainId,
  contract_address: expected.contractAddress, rpc_url: expected.rpc, manifest_hash: expected.manifestHash };

test("new escrow requires matching dependency readiness, not configuration health", async () => {
  await exports.assertPurchaseReadiness(expected, async (url) => { assert.equal(url, `${expected.adapter}/ready`); return Response.json(identity); });
  for (const change of [{ ok: false }, { readiness: "configuration_only" }, { protocol_version: 1 }, { chain_id: 1 },
    { contract_address: "old" }, { rpc_url: "old" }, { manifest_hash: "old" }]) {
    await assert.rejects(exports.assertPurchaseReadiness(expected, async () => Response.json({ ...identity, ...change })), /Purchases are paused/);
  }
});

test("missing legacy readiness and upstream failures pause new purchases safely", async () => {
  for (const fetcher of [async () => new Response("legacy", { status: 404 }), async () => new Response("down", { status: 503 }), async () => { throw new Error("credential error"); }]) {
    await assert.rejects(exports.assertPurchaseReadiness(expected, fetcher), /Purchases are paused/);
  }
});
