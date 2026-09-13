import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";

const PORT = Number(process.env.PORT || 8787);
const MONITOR_SECRET = process.env.MONITOR_SECRET || "";
const EVIDENCE_DIR = resolve(process.env.EVIDENCE_DIR || "evidence");
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const FRONTEND_ORIGIN = (process.env.FRONTEND_ORIGIN || "").replace(/\/+$/, "");
const REQUEST_PRICE_WEI = process.env.REQUEST_PRICE_WEI || "2000000000000000000";
const AGENT_SIGNING_KEY = process.env.AGENT_SIGNING_KEY || "";
const CONTRACT_ADDRESS =
  process.env.RECOURSE_CONTRACT_ADDRESS ||
  "0x51eDCf8f3Bdbb69a6e83b1cA5076a77C2E5Cdc35";
const CHAIN_ID = 61997;
const RPC_URL = "https://studio-dev.genlayer.com/api";
const EXPLORER_URL = "https://explorer-studio-dev.genlayer.com/";
const MAX_BODY_BYTES = 100_000;
const ALLOWED_STATUSES = new Set(["success", "timeout", "malformed"]);
const AGENT_DEFINITIONS = {
  "research-sources": {
    name: "Source Scout",
    description: "Finds five citable scholarly or public sources for a research question.",
    method: "POST",
    input: { query: "string, 3-240 characters" },
    output: { query: "string", sources: "[{title,url,citation}]" },
    endpoint: "/agents/research-sources/execute",
  },
  "citation-validator": {
    name: "Citation Auditor",
    description: "Checks whether supplied source URLs are reachable and exposes their page titles.",
    method: "POST",
    input: { claim: "string, 3-1000 characters", sources: "array of 1-10 http(s) URLs" },
    output: { claim: "string", checks: "[{url,reachable,title,status}]", verdict: "string" },
    endpoint: "/agents/citation-validator/execute",
  },
  "json-repair": {
    name: "Schema Mechanic",
    description: "Validates and normalizes a JSON document against a small required-key schema.",
    method: "POST",
    input: { document: "JSON string or JSON value", required_keys: "array of key names" },
    output: { valid: "boolean", normalized: "JSON value", missing_keys: "array" },
    endpoint: "/agents/json-repair/execute",
  },
  "code-policy": {
    name: "Code Sentinel",
    description: "Runs bounded static policy checks against submitted JavaScript, TypeScript, or Python.",
    method: "POST",
    input: { code: "string, 1-20000 characters", language: "javascript|typescript|python" },
    output: { language: "string", score: "integer", findings: "[{rule,severity,line}]" },
    endpoint: "/agents/code-policy/execute",
  },
  "page-brief": {
    name: "Page Brief",
    description: "Fetches a public page and returns a bounded title, excerpt, and key phrase brief.",
    method: "POST",
    input: { url: "http(s) URL" },
    output: { url: "string", title: "string", excerpt: "string", key_phrases: "array" },
    endpoint: "/agents/page-brief/execute",
  },
};

const agentAccount = /^0x[0-9a-fA-F]{64}$/.test(AGENT_SIGNING_KEY)
  ? privateKeyToAccount(AGENT_SIGNING_KEY)
  : null;

function corsHeaders(request, isPublic = false) {
  const origin = request.headers.origin || "";
  const allowedOrigin =
    isPublic || !FRONTEND_ORIGIN || origin === FRONTEND_ORIGIN
      ? isPublic
        ? "*"
        : origin || FRONTEND_ORIGIN || "*"
      : "";
  return allowedOrigin
    ? {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Headers": "authorization, content-type, x-payment",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        Vary: "Origin",
      }
    : {};
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function packetPath(jobId) {
  if (!/^[A-Za-z0-9._~-]{1,128}$/.test(jobId)) {
    throw new Error("invalid job id");
  }
  return resolve(EVIDENCE_DIR, `${jobId}.json`);
}

function requestBaseUrl(request) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const protocol = request.headers["x-forwarded-proto"] || "http";
  const host = request.headers["x-forwarded-host"] || request.headers.host || "localhost";
  return `${protocol}://${host}`;
}

function authorized(request) {
  if (!MONITOR_SECRET) return false;
  const supplied = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const expected = Buffer.from(MONITOR_SECRET);
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseInteger(value, field, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${field} must be an integer of at least ${minimum}`);
  }
  return parsed;
}

function assertString(value, field, minimum, maximum) {
  const text = String(value ?? "").trim();
  if (text.length < minimum || text.length > maximum) {
    throw new Error(`${field} must be ${minimum}-${maximum} characters`);
  }
  return text;
}

function assertHttpUrl(value, field) {
  const text = assertString(value, field, 12, 2048);
  const url = new URL(text);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${field} must use http(s)`);
  return url;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function stripMarkup(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function words(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 4 && !new Set(["about", "after", "their", "there", "which", "would", "could", "these", "those", "where", "while"]).has(word));
}

async function executeAgent(slug, payload) {
  if (slug === "research-sources") {
    const query = assertString(payload.query, "query", 3, 240);
    const crossrefUrl = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=5&select=title,URL,author,published,container-title`;
    const response = await fetchWithTimeout(crossrefUrl, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`source index returned ${response.status}`);
    const body = await response.json();
    const items = Array.isArray(body?.message?.items) ? body.message.items : [];
    const sources = items.slice(0, 5).map((item) => {
      const title = Array.isArray(item.title) ? String(item.title[0] || "") : "";
      const authors = Array.isArray(item.author)
        ? item.author.slice(0, 3).map((author) => `${author.given || ""} ${author.family || ""}`.trim()).filter(Boolean).join(", ")
        : "";
      const year = item.published?.["date-parts"]?.[0]?.[0] || "n.d.";
      return {
        title: title || "Untitled source",
        url: String(item.URL || ""),
        citation: `${authors || "Unknown author"} (${year}). ${title || "Untitled source"}.`,
      };
    }).filter((item) => /^https?:\/\//.test(item.url));
    if (sources.length < 5) throw new Error("source index returned fewer than five usable sources");
    return { query, sources };
  }

  if (slug === "citation-validator") {
    const claim = assertString(payload.claim, "claim", 3, 1000);
    if (!Array.isArray(payload.sources) || payload.sources.length < 1 || payload.sources.length > 10) {
      throw new Error("sources must contain 1-10 URLs");
    }
    const sources = payload.sources.map((value) => assertHttpUrl(value, "source"));
    const checks = await Promise.all(sources.map(async (url) => {
      try {
        const response = await fetchWithTimeout(url, { headers: { Accept: "text/html,application/xhtml+xml" }, redirect: "follow" }, 6000);
        const text = stripMarkup(await response.text()).slice(0, 30000);
        const titleMatch = text.match(/^(.{1,180}?)(?:\s{2,}|$)/);
        return {
          url: url.toString(),
          reachable: response.ok,
          title: titleMatch?.[1] || url.hostname,
          status: response.status,
        };
      } catch {
        return { url: url.toString(), reachable: false, title: "", status: 0 };
      }
    }));
    const reachable = checks.filter((item) => item.reachable).length;
    return { claim, checks, verdict: reachable === checks.length ? "all sources reachable" : `${reachable}/${checks.length} sources reachable` };
  }

  if (slug === "json-repair") {
    let normalized;
    try {
      normalized = typeof payload.document === "string" ? JSON.parse(payload.document) : payload.document;
    } catch {
      return { valid: false, normalized: null, missing_keys: [], error: "document is not valid JSON" };
    }
    if (normalized === null || typeof normalized !== "object") {
      return { valid: false, normalized, missing_keys: [], error: "document must be an object or array" };
    }
    const requiredKeys = Array.isArray(payload.required_keys)
      ? payload.required_keys.map((item) => assertString(item, "required_key", 1, 64)).slice(0, 32)
      : [];
    const target = Array.isArray(normalized) ? normalized[0] : normalized;
    const missingKeys = target && typeof target === "object" && !Array.isArray(target)
      ? requiredKeys.filter((key) => !(key in target))
      : requiredKeys;
    return { valid: missingKeys.length === 0, normalized, missing_keys: missingKeys };
  }

  if (slug === "code-policy") {
    const code = assertString(payload.code, "code", 1, 20000);
    const language = assertString(payload.language, "language", 2, 12).toLowerCase();
    if (!["javascript", "typescript", "python"].includes(language)) throw new Error("language must be javascript, typescript, or python");
    const rules = [
      ["eval", /\beval\s*\(/g, "high"],
      ["shell-exec", /\b(child_process|subprocess|os\.system|execSync)\b/g, "high"],
      ["secret-access", /\b(process\.env|os\.environ)\b/g, "medium"],
      ["network-call", /\b(fetch|axios|requests\.(get|post)|httpx\.)\b/g, "low"],
    ];
    const findings = [];
    for (const [rule, pattern, severity] of rules) {
      for (const match of code.matchAll(pattern)) {
        const line = code.slice(0, match.index).split("\n").length;
        findings.push({ rule, severity, line });
      }
    }
    const score = Math.max(0, 100 - findings.reduce((total, finding) => total + (finding.severity === "high" ? 25 : finding.severity === "medium" ? 10 : 3), 0));
    return { language, score, findings: findings.slice(0, 100) };
  }

  if (slug === "page-brief") {
    const url = assertHttpUrl(payload.url, "url");
    const response = await fetchWithTimeout(url, { headers: { Accept: "text/html,application/xhtml+xml,text/plain" }, redirect: "follow" }, 8000);
    if (!response.ok) throw new Error(`page returned ${response.status}`);
    const raw = await response.text();
    const text = stripMarkup(raw);
    const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || url.hostname;
    const phraseCounts = new Map();
    for (const word of words(text)) phraseCounts.set(word, (phraseCounts.get(word) || 0) + 1);
    const keyPhrases = [...phraseCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([word]) => word);
    return { url: url.toString(), title: stripMarkup(title).slice(0, 180), excerpt: text.slice(0, 900), key_phrases: keyPhrases };
  }

  throw new Error("unknown agent capability");
}

async function signedAgentReceipt(slug, payload, output, startedAt, provider) {
  const outputText = JSON.stringify(output, (_, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
  });
  const outputHash = `sha256:${createHash("sha256").update(outputText).digest("hex")}`;
  const requestHash = String(payload.request_hash);
  const receipt = {
    job_id: String(payload.job_id),
    request_hash: requestHash,
    output_hash: outputHash,
    response_status: "success",
    response_code: 200,
    latency_ms: Math.max(0, Date.now() - startedAt),
    schema_valid: true,
    completed_at: new Date().toISOString(),
    provider,
  };
  const receiptHash = createHash("sha256").update(canonicalJson(receipt)).digest("hex");
  return {
    output,
    receipt,
    receipt_hash: receiptHash,
    receipt_signature: agentAccount
      ? await agentAccount.signMessage({ message: { raw: `0x${receiptHash}` } })
      : "",
  };
}

function parseEvidencePayload(payload) {
  const core = {
    job_id: String(payload.job_id || ""),
    request_hash: String(payload.request_hash || "").trim(),
    output_hash: String(payload.output_hash || "").trim(),
    response_status: String(payload.response_status || "").trim(),
    response_code: parseInteger(payload.response_code, "response_code"),
    latency_ms: parseInteger(payload.latency_ms, "latency_ms"),
    schema_valid: payload.schema_valid === true,
    completed_at: String(payload.completed_at || "").trim(),
    provider: String(payload.provider || "").trim(),
  };
  packetPath(core.job_id);
  if (!core.request_hash || !core.output_hash) {
    throw new Error("request_hash and output_hash are required");
  }
  if (!ALLOWED_STATUSES.has(core.response_status)) {
    throw new Error("response_status must be success, timeout, or malformed");
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(core.provider)) {
    throw new Error("provider must be a 20-byte address");
  }
  if (Number.isNaN(Date.parse(core.completed_at))) {
    throw new Error("completed_at must be an ISO date");
  }
  return core;
}

async function readPacket(jobId) {
  try {
    return JSON.parse(await readFile(packetPath(jobId), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writePacket(jobId, packet) {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const target = packetPath(jobId);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(packet, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
}

function paymentRequirement() {
  return {
    version: "1",
    scheme: "genlayer-native",
    network: "studio-next",
    chain_id: CHAIN_ID,
    rpc_url: RPC_URL,
    asset: "GEN",
    amount: REQUEST_PRICE_WEI,
    contract_address: CONTRACT_ADDRESS,
    action: "create_job",
    description: "Fund a Recourse request escrow on GenLayer Studio Next.",
  };
}

await mkdir(EVIDENCE_DIR, { recursive: true });

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const publicCors = corsHeaders(request, true);
  const restrictedCors = corsHeaders(request);

  if (request.method === "OPTIONS") {
    response.writeHead(204, restrictedCors);
    return response.end();
  }

  if (request.method === "GET" && url.pathname === "/") {
    return json(
      response,
      200,
      {
        service: "Recourse evidence and x402 adapter",
        status: "operational",
        network: "studio-next",
        chain_id: CHAIN_ID,
        rpc_url: RPC_URL,
        contract_address: CONTRACT_ADDRESS,
        explorer_url: EXPLORER_URL,
        endpoints: {
          health: "GET /health",
          evidence: "GET /evidence/:job_id",
          publish_evidence: "POST /evidence",
          x402: "POST /x402/request",
        },
      },
      publicCors,
    );
  }

  if (request.method === "GET" && url.pathname === "/health") {
    try {
      await access(EVIDENCE_DIR, fsConstants.R_OK | fsConstants.W_OK);
      return json(
        response,
        200,
        {
          ok: true,
          service: "recourse-adapter",
          network: "studio-next",
          chain_id: CHAIN_ID,
          storage: "ready",
          privy_configured: Boolean(process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET),
        },
        publicCors,
      );
    } catch {
      return json(response, 503, { ok: false, storage: "unavailable" }, publicCors);
    }
  }

  if (request.method === "GET" && url.pathname === "/agents") {
    return json(
      response,
      200,
      {
        network: "studio-next",
        chain_id: CHAIN_ID,
        provider: agentAccount?.address || null,
        agents: Object.entries(AGENT_DEFINITIONS).map(([slug, definition]) => ({
          slug,
          ...definition,
          execute_url: `${requestBaseUrl(request)}${definition.endpoint}`,
          provider: agentAccount?.address || null,
        })),
      },
      publicCors,
    );
  }

  if (request.method === "GET" && url.pathname.startsWith("/agents/")) {
    const slug = decodeURIComponent(url.pathname.slice("/agents/".length));
    const definition = AGENT_DEFINITIONS[slug];
    return definition
      ? json(
          response,
          200,
          {
            slug,
            ...definition,
            execute_url: `${requestBaseUrl(request)}${definition.endpoint}`,
            provider: agentAccount?.address || null,
          },
          publicCors,
        )
      : json(response, 404, { error: "agent capability not found" }, publicCors);
  }

  if (request.method === "POST" && url.pathname.startsWith("/agents/") && url.pathname.endsWith("/execute")) {
    const slug = decodeURIComponent(url.pathname.slice("/agents/".length, -"/execute".length));
    if (!AGENT_DEFINITIONS[slug]) {
      return json(response, 404, { error: "agent capability not found" }, publicCors);
    }
    if (!agentAccount) {
      return json(response, 503, { error: "agent signing is not configured" }, publicCors);
    }
    try {
      const payload = JSON.parse(await readBody(request));
      const jobId = assertString(request.headers["x-recourse-job-id"], "x-recourse-job-id", 1, 128);
      const requestHash = assertString(request.headers["x-recourse-request-hash"], "x-recourse-request-hash", 1, 128).toLowerCase();
      const executionPayload = { ...payload, job_id: jobId, request_hash: requestHash };
      const startedAt = Date.now();
      const output = await executeAgent(slug, executionPayload);
      const result = await signedAgentReceipt(slug, executionPayload, output, startedAt, agentAccount.address);
      const evidencePacket = {
        ...result.receipt,
        receipt_signature: result.receipt_signature,
        receipt_hash: result.receipt_hash,
      };
      const existing = await readPacket(jobId);
      if (existing && existing.receipt_hash !== result.receipt_hash) {
        return json(response, 409, { error: "job already has a different agent receipt" }, publicCors);
      }
      if (!existing) await writePacket(jobId, evidencePacket);
      return json(response, 200, {
        agent: slug,
        network: "studio-next",
        chain_id: CHAIN_ID,
        evidence_url: `${requestBaseUrl(request)}/evidence/${encodeURIComponent(jobId)}`,
        ...result,
      }, publicCors);
    } catch (error) {
      return json(
        response,
        422,
        { error: error instanceof Error ? error.message : "agent execution failed" },
        publicCors,
      );
    }
  }

  if (request.method === "GET" && url.pathname.startsWith("/evidence/")) {
    const jobId = decodeURIComponent(url.pathname.slice("/evidence/".length));
    try {
      const packet = await readPacket(jobId);
      return packet
        ? json(response, 200, packet, publicCors)
        : json(response, 404, { error: "evidence not found" }, publicCors);
    } catch (error) {
      return json(
        response,
        400,
        { error: error instanceof Error ? error.message : "invalid evidence id" },
        publicCors,
      );
    }
  }

  if (request.method === "POST" && url.pathname === "/evidence") {
    if (!authorized(request)) {
      return json(response, 401, { error: "monitor authorization required" }, restrictedCors);
    }
    try {
      const payload = JSON.parse(await readBody(request));
      const core = parseEvidencePayload(payload);
      const receiptHash = createHash("sha256").update(canonicalJson(core)).digest("hex");
      const signature = String(payload.receipt_signature || "");
      const signatureValid = await verifyMessage({
        address: core.provider,
        message: { raw: `0x${receiptHash}` },
        signature,
      });
      if (!signatureValid) {
        return json(response, 422, { error: "receipt signature is invalid" }, restrictedCors);
      }
      const packet = {
        ...core,
        receipt_signature: signature,
        receipt_hash: receiptHash,
      };
      const existing = await readPacket(core.job_id);
      if (existing && existing.receipt_hash !== receiptHash) {
        return json(
          response,
          409,
          { error: "evidence already exists for this job with a different receipt" },
          restrictedCors,
        );
      }
      if (!existing) await writePacket(core.job_id, packet);
      const evidenceUrl = `${requestBaseUrl(request)}/evidence/${encodeURIComponent(core.job_id)}`;
      return json(
        response,
        existing ? 200 : 201,
        { evidence_url: evidenceUrl, receipt_hash: receiptHash },
        restrictedCors,
      );
    } catch (error) {
      return json(
        response,
        400,
        { error: error instanceof Error ? error.message : "invalid JSON" },
        restrictedCors,
      );
    }
  }

  if (request.method === "POST" && url.pathname === "/x402/request") {
    const requirement = paymentRequirement();
    if (!request.headers["x-payment"]) {
      const encoded = Buffer.from(JSON.stringify(requirement)).toString("base64");
      return json(
        response,
        402,
        { error: "payment required", accepts: [requirement] },
        { ...publicCors, "PAYMENT-REQUIRED": encoded },
      );
    }
    const jobId = String(request.headers["x-recourse-job-id"] || "").trim();
    return json(
      response,
      202,
      {
        status: "payment_proof_received",
        network: "studio-next",
        chain_id: CHAIN_ID,
        job_id: jobId || null,
        payment_proof: String(request.headers["x-payment"]),
        next: jobId ? "provider_execution" : "submit_x-recourse-job-id",
      },
      publicCors,
    );
  }

  return json(response, 404, { error: "not found" }, publicCors);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Recourse adapter listening on 0.0.0.0:${PORT}`);
});

function shutdown(signal) {
  console.log(`${signal} received; closing Recourse adapter`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
