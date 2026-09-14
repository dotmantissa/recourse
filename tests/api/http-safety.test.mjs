import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createPublicFetcher, createWorkLimiter, parseId, publicUrl } from "../../api/http-safety.mjs";

function fakeNetwork(overrides = {}) {
  const state = { lookups: [], connections: [], destroyed: 0 };
  state.fetch = createPublicFetcher({
    resolveHost: async (hostname) => {
      state.lookups.push(hostname);
      return [{ address: "8.8.8.8", family: 4 }];
    },
    dispatcherFactory: (options) => {
      state.connections.push(options.connect);
      return { destroy: async () => { state.destroyed += 1; } };
    },
    fetchResponse: async () => new Response("ok"),
    ...overrides,
  });
  return state;
}

test("connections use only the DNS addresses validated for that hop", async () => {
  const state = fakeNetwork();
  const response = await state.fetch("https://provider.example/result");
  assert.equal(await response.text(), "ok");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const address = await new Promise((resolve, reject) => state.connections[0].lookup("provider.example", {}, (error, address) => error ? reject(error) : resolve(address)));
    assert.equal(address, "8.8.8.8");
  }
  assert.deepEqual(state.lookups, ["provider.example"]);
  assert.equal(state.destroyed, 1);
  const addresses = await new Promise((resolve, reject) => state.connections[0].lookup("provider.example", { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses)));
  assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]);
});

test("literal private addresses, ambiguous IDs, and unsafe ports are rejected", () => {
  for (const value of ["http://127.1", "http://[::1]", "http://localhost.", "https://user:password@example.com", "https://example.com:8080", "file:///etc/passwd"]) {
    assert.throws(() => publicUrl(value), /public host/);
  }
  for (const value of [null, 1, "0", "01", "../1", "1/2", "1e2", " 1", "1".repeat(21)]) {
    assert.throws(() => parseId(value), /numeric ID/);
  }
  assert.equal(parseId("12345678901234567890"), "12345678901234567890");
});

test("mixed public/private DNS answers never reach fetch", async () => {
  let fetched = false;
  const state = fakeNetwork({
    resolveHost: async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }],
    fetchResponse: async () => { fetched = true; return new Response("bad"); },
  });
  await assert.rejects(state.fetch("https://provider.example/"), /public host/);
  assert.equal(fetched, false);
});

test("redirects are revalidated and do not forward credentials cross-origin", async () => {
  const visited = [];
  const state = fakeNetwork({ fetchResponse: async (url, options) => {
    visited.push({ url, auth: options.headers.get("authorization"), cookie: options.headers.get("cookie") });
    return visited.length === 1
      ? new Response(null, { status: 302, headers: { location: "https://other.example/" } })
      : new Response(null, { status: 204 });
  } });
  const response = await state.fetch("https://provider.example/", { headers: { Authorization: "secret", Cookie: "session=secret" } });
  assert.equal(response.status, 204);
  assert.deepEqual(state.lookups, ["provider.example", "other.example"]);
  assert.equal(visited[0].auth, "secret");
  assert.equal(visited[1].auth, null);
  assert.equal(visited[1].cookie, null);
  assert.equal(state.destroyed, 2);
  const privateRedirect = fakeNetwork({ fetchResponse: async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } }) });
  await assert.rejects(privateRedirect.fetch("https://provider.example/"), /public host/);
  assert.equal(privateRedirect.destroyed, 1);
});

test("redirect loops and oversized decompressed bodies are bounded", async () => {
  const loop = fakeNetwork({ fetchResponse: async () => new Response(null, { status: 302, headers: { location: "/again" } }) });
  await assert.rejects(loop.fetch("https://provider.example/"), /redirect limit/);
  assert.equal(loop.destroyed, 4);
  const large = fakeNetwork({ fetchResponse: async () => new Response("x".repeat(1_000_001)) });
  await assert.rejects(large.fetch("https://provider.example/"), /size limit/);
  assert.equal(large.destroyed, 1);
});

test("DNS, headers, and body consumption share the total deadline", async () => {
  for (const stage of ["dns", "headers", "body"]) {
    const state = fakeNetwork({
      ...(stage === "dns" ? { resolveHost: async () => { await delay(100); return [{ address: "8.8.8.8", family: 4 }]; } } : {}),
      fetchResponse: async () => {
        if (stage === "headers") await delay(100);
        return stage === "body" ? new Response(new ReadableStream({ start() {} })) : new Response("ok");
      },
    });
    const keepAlive = setTimeout(() => {}, 200);
    try {
      await assert.rejects(state.fetch("https://provider.example/", {}, 30), { name: "TimeoutError" });
      assert.equal(state.destroyed, stage === "dns" ? 0 : 1);
    } finally {
      clearTimeout(keepAlive);
    }
  }
});

test("caller cancellation is respected before DNS resolution", async () => {
  const state = fakeNetwork();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(state.fetch("https://provider.example/", { signal: controller.signal }), { name: "AbortError" });
  assert.equal(state.lookups.length, 0);
});

test("work limiter rejects excess work and releases slots on failure", async () => {
  const limitWork = createWorkLimiter(1);
  let release;
  const first = limitWork(() => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(limitWork(() => "excess"), { status: 503 });
  release("done");
  assert.equal(await first, "done");
  await assert.rejects(limitWork(() => { throw new Error("failed"); }), /failed/);
  assert.equal(await limitWork(() => "recovered"), "recovered");
});
