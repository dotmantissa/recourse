import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";
import { verifyMessage } from "viem";

const PORT = Number(process.env.PORT || 8787);
const MONITOR_SECRET = process.env.MONITOR_SECRET || "";
const EVIDENCE_DIR = resolve(process.env.EVIDENCE_DIR || "evidence");
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const FRONTEND_ORIGIN = (process.env.FRONTEND_ORIGIN || "").replace(/\/+$/, "");
const REQUEST_PRICE_WEI = process.env.REQUEST_PRICE_WEI || "2000000000000000000";
const CONTRACT_ADDRESS =
  process.env.RECOURSE_CONTRACT_ADDRESS ||
  "0x51eDCf8f3Bdbb69a6e83b1cA5076a77C2E5Cdc35";
const CHAIN_ID = 61997;
const RPC_URL = "https://studio-dev.genlayer.com/api";
const EXPLORER_URL = "https://explorer-studio-dev.genlayer.com/";
const MAX_BODY_BYTES = 100_000;
const ALLOWED_STATUSES = new Set(["success", "timeout", "malformed"]);

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
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key]]),
    ),
  );
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
