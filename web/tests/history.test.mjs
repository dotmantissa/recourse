import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/history.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
runInNewContext(compiled, { exports });
const { loadRegistry } = exports;

test("registry loads bounded recent pages and explicit older history", async () => {
  const calls = [];
  const reader = async (method, args) => {
    calls.push([method, args]);
    if (method === "get_counts") return { capabilities: 1, jobs: 125, evidence: 0, disputes: 0 };
    const [start, limit] = args.map(Number);
    assert.ok(limit <= 50);
    return { items: Array.from({ length: limit }, (_, index) => ({ id: start + index + 1 })), next_cursor: start + limit, total: method === "get_jobs_page" ? 125 : 1 };
  };
  let state = await loadRegistry(reader);
  assert.equal(state.jobs.length, 50);
  assert.equal(state.jobs[0].id, 76);
  assert.equal(state.history.jobs, 75);
  state = await loadRegistry(reader, state.history);
  assert.equal(state.jobs[0].id, 26);
  state = await loadRegistry(reader, state.history);
  assert.equal(state.jobs.length, 25);
  assert.equal(state.history.jobs, 0);
  assert.equal(calls.filter(([method]) => method === "get_counts").length, 1);
  assert.equal(calls.some(([method]) => method === "get_jobs"), false);
});

test("registry rejects malformed counts and oversized or nonprogressing pages", async () => {
  for (const jobs of [-1, NaN, "50", 2 ** 54]) {
    await assert.rejects(loadRegistry(async () => ({ capabilities: 0, jobs, evidence: 0, disputes: 0 })), /cursor/);
  }
  for (const page of [{ items: [], next_cursor: 0, total: 1 }, { items: Array(51), next_cursor: 1, total: 1 }]) {
    await assert.rejects(loadRegistry(async (method) => method === "get_counts" ? { capabilities: 0, jobs: 1, evidence: 0, disputes: 0 } : page), /page/);
  }
});
