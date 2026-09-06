import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { verifyMessage } from "viem";

const port = Number(process.env.PORT || 8787);
const monitorSecret = process.env.MONITOR_SECRET || "";
const packets = new Map();

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100000) reject(new Error("payload too large"));
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (request.method === "GET" && url.pathname === "/health") {
    return json(response, 200, { ok: true, service: "recourse-evidence" });
  }
  if (request.method === "GET" && url.pathname.startsWith("/evidence/")) {
    const jobId = decodeURIComponent(url.pathname.slice("/evidence/".length));
    const packet = packets.get(jobId);
    return packet
      ? json(response, 200, packet, { "Access-Control-Allow-Origin": "*" })
      : json(response, 404, { error: "evidence not found" });
  }
  if (request.method === "POST" && url.pathname === "/evidence") {
    if (!monitorSecret || request.headers.authorization !== `Bearer ${monitorSecret}`) {
      return json(response, 401, { error: "monitor authorization required" });
    }
    try {
      const payload = JSON.parse(await readBody(request));
      if (!payload.job_id || !payload.request_hash || !payload.output_hash) {
        return json(response, 400, { error: "incomplete evidence packet" });
      }
      const core = {
        job_id: String(payload.job_id),
        request_hash: String(payload.request_hash),
        output_hash: String(payload.output_hash),
        response_status: String(payload.response_status),
        response_code: Number(payload.response_code),
        latency_ms: Number(payload.latency_ms),
        schema_valid: Boolean(payload.schema_valid),
        completed_at: String(payload.completed_at),
        provider: String(payload.provider),
      };
      const receiptHash = createHash("sha256")
        .update(JSON.stringify(core, Object.keys(core).sort()))
        .digest("hex");
      if (!/^0x[a-fA-F0-9]{40}$/.test(core.provider)) {
        return json(response, 400, { error: "provider must be an address" });
      }
      const signature = String(payload.receipt_signature || "");
      const signatureValid = await verifyMessage({
        address: core.provider,
        message: receiptHash,
        signature,
      });
      if (!signatureValid) {
        return json(response, 422, { error: "receipt signature is invalid" });
      }
      const packet = {
        ...core,
        receipt_signature: signature,
        receipt_hash: receiptHash,
      };
      packets.set(core.job_id, packet);
      return json(response, 201, {
        evidence_url: `/evidence/${encodeURIComponent(core.job_id)}`,
        receipt_hash: receiptHash,
      });
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : "invalid JSON" });
    }
  }
  if (request.method === "POST" && url.pathname === "/x402/request") {
    const price = process.env.REQUEST_PRICE_WEI || "2000000000000000000";
    if (!request.headers["x-payment"]) {
      const payment = Buffer.from(
        JSON.stringify({
          scheme: "genlayer-native",
          network: "studio-dev",
          asset: "GEN",
          amount: price,
          description: "Recourse request escrow intent",
        }),
      ).toString("base64");
      return json(response, 402, { error: "payment required" }, { "PAYMENT-REQUIRED": payment });
    }
    return json(response, 202, {
      status: "payment_intent_received",
      next: "create_job",
      payment: request.headers["x-payment"],
    });
  }
  return json(response, 404, { error: "not found" });
});

server.listen(port, () => {
  console.log(`Recourse evidence adapter listening on http://localhost:${port}`);
});
