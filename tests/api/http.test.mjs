import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import { readBody } from "../../api/http-safety.mjs";

process.env.AGENT_SIGNING_KEY = "";
const { fetchWithTimeout, parseObject, server } = await import("../../api/server.mjs");

test("HTTP rejects non-object payment requests without crashing", async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const body of ["null", "[]", "42", '"text"', "{"]) {
      const response = await fetch(`${origin}/x402/request`, { method: "POST", body });
      assert.equal(response.status, 400);
    }
    for (const capabilityId of ["../secret", "01", "0", "1e3", "1.1", "1".repeat(21), {}, 42]) {
      const response = await fetch(`${origin}/x402/request`, {
        method: "POST", body: JSON.stringify({ capability_id: capabilityId }),
      });
      assert.equal(response.status, 400);
    }
    for (const path of ["/evidence/%2e%2e%2fsecret", "/evidence/%zz", "/results/01"]) {
      assert.equal((await fetch(`${origin}${path}`)).status, 400);
    }
    for (const path of ["/agents/__proto__", "/agents/constructor", "/agents/toString"]) {
      assert.equal((await fetch(`${origin}${path}`)).status, 404);
    }
    const oversized = await fetch(`${origin}/x402/request`, { method: "POST", body: " ".repeat(100_001) });
    assert.equal(oversized.status, 413);
    assert.match((await oversized.json()).error, /large/);
    const payment = await fetch(`${origin}/x402/request`, { method: "POST", body: "{}" });
    assert.equal(payment.status, 402);
    assert.ok(payment.headers.get("payment-required"));
    assert.equal((await fetch(`${origin}/`)).status, 200);
    assert.equal((await fetch(`${origin}/health`)).status, 503);
    let lastResponse;
    for (let index = 0; index < 240; index += 1) lastResponse = await fetch(`${origin}/`);
    assert.equal(lastResponse.status, 429);
    assert.equal(lastResponse.headers.get("retry-after"), "60");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("slow HTTP request bodies receive a bounded 408 response", async () => {
  const upstream = createServer(async (request, response) => {
    try {
      await readBody(request, 1000, 50);
      response.end("ok");
    } catch (error) {
      response.writeHead(error.status, { Connection: "close" });
      response.end(error.message);
    }
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } });
    const response = await fetch(`http://127.0.0.1:${upstream.address().port}/`, {
      method: "POST", body, duplex: "half", signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 408);
    assert.match(await response.text(), /timed out/);
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("aborted HTTP request bodies release their reader", async () => {
  let received;
  const started = new Promise((resolve) => { received = resolve; });
  let rejected;
  const completed = new Promise((resolve) => { rejected = resolve; });
  const upstream = createServer(async (request, response) => {
    received();
    try {
      await readBody(request);
      response.end("ok");
    } catch (error) {
      rejected(error);
    }
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const client = httpRequest(`http://127.0.0.1:${upstream.address().port}/`, { method: "POST" });
    client.on("error", () => {});
    client.write("{");
    await started;
    client.destroy();
    assert.equal((await completed).status, 400);
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("request parser accepts only objects", () => {
  assert.deepEqual(parseObject('{"capability_id":"1"}'), { capability_id: "1" });
  assert.throws(() => parseObject("null"), /JSON object/);
});

test("remote deadline remains active while consuming the body", async () => {
  const upstream = createServer((request, response) => {
    response.writeHead(200);
    response.write("start");
    const timer = setTimeout(() => response.end("end"), 1000);
    response.on("close", () => clearTimeout(timer));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(async () => {
      const response = await fetchWithTimeout(`http://127.0.0.1:${upstream.address().port}/`, {}, 100);
      await response.text();
    });
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
