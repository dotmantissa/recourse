import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/app/api/genlayer/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function loadRoute(fetchResponse, timeoutMs) {
  const exports = {};
  runInNewContext(compiled, {
    exports,
    require: (name) => name === "@/lib/config" ? { RPC_URL: "https://studio-dev.genlayer.com/api" } : createRequire(import.meta.url)(name),
    process: { env: {} },
    Buffer,
    AbortSignal: timeoutMs ? { any: AbortSignal.any, timeout: () => AbortSignal.timeout(timeoutMs) } : AbortSignal,
    fetch: fetchResponse,
  });
  return exports.POST;
}

function rpcRequest(value = { jsonrpc: "2.0", method: "eth_chainId", id: 1 }) {
  return new Request("http://localhost/api/genlayer", { method: "POST", body: JSON.stringify(value) });
}

function rpcResponse() {
  return Response.json({ jsonrpc: "2.0", id: 1, result: "0xf22d" });
}

test("RPC forwards allowlisted requests unchanged with no-store responses", async () => {
  const POST = loadRoute(async (url, options) => {
    assert.equal(url, "https://studio-dev.genlayer.com/api");
    assert.deepEqual(JSON.parse(options.body), { jsonrpc: "2.0", method: "eth_chainId", id: 1 });
    return rpcResponse();
  });
  const response = await POST(rpcRequest());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).result, "0xf22d");
});

test("RPC rejects invalid shapes, methods, IDs, and batches before contacting upstream", async () => {
  const POST = loadRoute(() => { throw new Error("must not fetch"); });
  for (const value of [null, [], 3, { jsonrpc: "2.0", method: "admin_peers", id: 1 },
    { jsonrpc: "2.0", method: "eth_chainId", id: {} },
    { jsonrpc: "2.0", method: "eth_chainId", params: 1 },
    Array.from({ length: 11 }, () => ({ jsonrpc: "2.0", method: "eth_chainId", id: 1 }))]) {
    const response = await POST(rpcRequest(value));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, -32600);
  }
  const malformed = await POST(new Request("http://localhost/api/genlayer", { method: "POST", body: "{" }));
  assert.equal((await malformed.json()).error.code, -32700);
});

test("RPC bounds request and upstream response sizes", async () => {
  const POST = loadRoute(async () => new Response("x".repeat(4_000_001)));
  const request = new Request("http://localhost/api/genlayer", { method: "POST", body: "x".repeat(256001) });
  assert.equal((await POST(request)).status, 413);
  const upstream = await POST(rpcRequest());
  assert.equal(upstream.status, 502);
  assert.equal((await upstream.json()).id, 1);
});

test("RPC converts malformed, broken, and non-JSON upstream bodies to JSON RPC errors", async () => {
  for (const upstream of [
    new Response("not JSON", { headers: { "content-type": "application/json" } }),
    new Response("unavailable", { status: 503 }),
    new Response(new ReadableStream({ start(controller) { controller.error(new Error("stream failed")); } })),
  ]) {
    const POST = loadRoute(async () => upstream);
    const response = await POST(rpcRequest());
    assert.equal(response.status, 502);
    assert.equal((await response.json()).id, 1);
  }
  const POST = loadRoute(async () => new Response("rate limited", { status: 429 }));
  const response = await POST(rpcRequest([{ jsonrpc: "2.0", method: "eth_chainId", id: "first" }, { jsonrpc: "2.0", method: "eth_chainId", id: 2 }]));
  assert.equal(response.status, 429);
  assert.deepEqual((await response.json()).map((entry) => entry.id), ["first", 2]);
});

test("RPC body deadlines cover inbound and upstream stalls", async () => {
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const POST = loadRoute(async () => new Response(new ReadableStream({ start() {} })), 30);
    const response = await POST(rpcRequest());
    assert.equal(response.status, 502);
    const request = new Request("http://localhost/api/genlayer", {
      method: "POST", body: new ReadableStream({ start() {} }), duplex: "half",
    });
    assert.equal((await POST(request)).status, 408);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("RPC rate and concurrency limits do not queue unlimited work", async () => {
  const POST = loadRoute(async () => rpcResponse());
  for (let index = 0; index < 120; index += 1) assert.equal((await POST(rpcRequest())).status, 200);
  assert.equal((await POST(rpcRequest())).status, 429);
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const concurrent = loadRoute(async () => { await barrier; return rpcResponse(); });
  const pending = Array.from({ length: 32 }, () => concurrent(rpcRequest()));
  try {
    assert.equal((await concurrent(rpcRequest())).status, 503);
  } finally {
    release();
  }
  assert.ok((await Promise.all(pending)).every((response) => response.status === 200));
  assert.equal((await concurrent(rpcRequest())).status, 200);
});
