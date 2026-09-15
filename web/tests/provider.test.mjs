import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/provider.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
runInNewContext(compiled, { exports, URL, AbortSignal });
const { validateRegistrationEndpoint } = exports;

test("registration rejects a hosted endpoint owned by another signer", async () => {
  const endpoint = "https://adapter.example/agents/research/execute";
  const fetcher = async () => Response.json({ provider: "0xProvider", agents: [{ execute_url: endpoint }] });
  await validateRegistrationEndpoint(endpoint, "0xprovider", "https://adapter.example", fetcher);
  await assert.rejects(validateRegistrationEndpoint(endpoint, "0xbuyer", "https://adapter.example", fetcher), /another provider/);
  await assert.rejects(validateRegistrationEndpoint(`${endpoint}-unknown`, "0xprovider", "https://adapter.example", fetcher), /another provider/);
});

test("registration requires HTTPS and fails closed when hosted manifest is unavailable", async () => {
  for (const endpoint of ["http://example.com/execute", "https://user:pass@example.com/execute", "https://example.com/execute#fragment"]) {
    await assert.rejects(validateRegistrationEndpoint(endpoint, "provider", "", async () => { throw new Error("must not fetch"); }), /HTTPS/);
  }
  await assert.rejects(validateRegistrationEndpoint("https://adapter.example/execute", "provider", "https://adapter.example", async () => new Response("unavailable", { status: 503 })), /unavailable/);
  await validateRegistrationEndpoint("https://independent.example/execute", "provider", "https://adapter.example", async () => { throw new Error("must not fetch an arbitrary endpoint"); });
});

test("hosted registration rejects mismatched service terms before requesting a wallet write", async () => {
  const endpoint = "https://adapter.example/agents/research/execute";
  const definition = { execute_url: endpoint, name: "Service", terms: "Declared terms", deadline_seconds: 30,
    timeout_refund_bps: 10000, malformed_refund_bps: 7500, output_schema: { type: "object", required: ["answer"] } };
  const fetcher = async () => Response.json({ provider: "0xProvider", agents: [definition] });
  const registration = { name: "Service", terms: "Declared terms", deadline: "30", timeout: "100", malformed: "75",
    schema: '{"required":["answer"],"type":"object"}' };
  await validateRegistrationEndpoint(endpoint, "0xprovider", "https://adapter.example", fetcher, registration);
  for (const update of [{ schema: "{}" }, { terms: "Different promise" }, { malformed: "0" }, { deadline: "10" }]) {
    await assert.rejects(validateRegistrationEndpoint(endpoint, "0xprovider", "https://adapter.example", fetcher, { ...registration, ...update }), /exact hosted service/);
  }
});
