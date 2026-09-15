import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const compile = async (name) => ts.transpileModule(await readFile(new URL(`../src/lib/${name}.ts`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const clientCode = await compile("genlayer");
const transactionCode = await compile("transactions");
const wallet = `0x${"11".repeat(20)}`;
const contract = `0x${"22".repeat(20)}`;
const hash = `0x${"33".repeat(32)}`;

function loadClient() {
  const transactions = {};
  runInNewContext(transactionCode, { exports: transactions, crypto: webcrypto });
  const records = new Map();
  const localStorage = { getItem: (key) => records.get(key) ?? null, setItem: (key, value) => records.set(key, value), removeItem: (key) => records.delete(key) };
  const calls = [];
  const fees = { feeValue: 123n, distribution: {}, messageAllocations: [] };
  const rpc = {
    readContract: async (options) => { calls.push(["contractRead", options]); return "{}"; },
    estimateTransactionFeesForWrite: async (options) => { calls.push(["estimate", options]); return fees; },
    writeContract: async (options) => { calls.push(["write", options]); assert.equal(JSON.parse([...records.values()][0]).hash, null); return hash; },
    getTransaction: async ({ hash: requested }) => { calls.push(["read", requested]); return { sender: wallet, recipient: contract, hash, statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_RETURN" }; },
  };
  const modules = {
    "genlayer-js": { createClient: () => rpc, encodeInternalMessageFeeParams: () => "encoded", MessageType: { Internal: 0 }, isSuccessful: (receipt) => receipt.txExecutionResultName === "FINISHED_WITH_RETURN" },
    "genlayer-js/chains": { studioDevnet: {} },
    "genlayer-js/types": { transactionsStatusNumberToName: {}, TransactionHashVariant: { LATEST_FINAL: "latest-final" } },
    "json-bigint": () => ({ parse: JSON.parse }),
    "./config": { CHAIN_ID: 61997, CONTRACT_ADDRESS: contract, RPC_URL: "/api/genlayer" },
    "./transactions": transactions, "./history": {}, "../../../sdk/protocol.mjs": { digest: () => "manifest" },
    "../../../agents/manifest.json": {}, "./release": { assertPurchaseReadiness: async () => {} },
  };
  const exports = {};
  runInNewContext(clientCode, { exports, require: (name) => { if (!(name in modules)) throw new Error(name); return modules[name]; },
    window: { localStorage, dispatchEvent() {} }, navigator: { locks: { request: async (key, options, operation) => operation({ name: key }) } }, Event, crypto: webcrypto });
  const provider = { request: async ({ method }) => method === "eth_chainId" ? "0xf22d" : [wallet] };
  return { exports, rpc, calls, records, fees, provider };
}

test("the browser contract reader explicitly selects finalized state", async () => {
  const { exports, calls } = loadClient();
  await exports.readJob("1");
  assert.equal(calls.find(([method]) => method === "contractRead")[1].transactionHashVariant, "latest-final");
});

test("real write bridge requires fee approval, preserves its estimate, and verifies finality", async () => {
  const { exports, calls, fees, provider, records } = loadClient();
  await assert.rejects(exports.write(wallet, provider, "create_job"), /Explicit fee/);
  let quoted;
  const result = await exports.write(wallet, provider, "create_job", ["1", "hash", "label"], 2000n, [wallet, contract], async (quote) => { quoted = quote; return true; });
  assert.equal(quoted.valueWei, "2000");
  assert.equal(quoted.feeWei, "123");
  assert.equal(quoted.totalWei, "2123");
  assert.equal(quoted.recipients.length, 2);
  assert.equal(calls[0][1].messageAllocations.length, 2);
  assert.equal(calls.find(([method]) => method === "write")[1].fees.feeValue, fees.feeValue);
  assert.equal(result, hash);
  assert.equal(records.size, 0);
});

test("wallet changes during approval prevent submission and leave no intent", async () => {
  const { exports, provider, calls, records } = loadClient();
  provider.request = async ({ method }) => method === "eth_chainId" ? "0x1" : [wallet];
  await assert.rejects(exports.write(wallet, provider, "accept_job", ["1"], 0n, [], async () => true), /Wallet or chain changed/);
  assert.equal(calls.some(([method]) => method === "write"), false);
  assert.equal(records.size, 0);
});

test("the real recovery bridge only reads a previously saved hash", async () => {
  const { exports, rpc, calls, provider, records } = loadClient();
  const successfulRead = rpc.getTransaction;
  rpc.getTransaction = async () => { throw new Error("rate limited"); };
  await assert.rejects(exports.write(wallet, provider, "accept_job", ["1"], 0n, [], async () => true), /ID is saved/);
  assert.equal(records.size, 1);
  rpc.getTransaction = successfulRead;
  assert.equal(await exports.resumeTransaction(wallet), hash);
  assert.equal(calls.filter(([method]) => method === "write").length, 1);
  assert.equal(records.size, 0);
});
