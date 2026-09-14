import { NextRequest, NextResponse } from "next/server";

const RPC_URL = process.env.RECOURSE_RPC ?? "https://studio-dev.genlayer.com/api";
const ALLOWED_METHODS = new Set([
  "eth_chainId", "eth_getBalance", "eth_getTransactionCount", "eth_getTransactionReceipt",
  "eth_getTransactionByHash", "eth_gasPrice", "eth_estimateGas", "eth_sendRawTransaction",
  "gen_call", "gen_getContractSchema", "gen_getContractCode", "gen_getTransactionLifecycle",
  "sim_estimateTransactionFees", "sim_getFeeConfig", "sim_fundAccount",
]);
const requestRates = new Map<string, { count: number; expires: number }>();
let activeRequests = 0;

class BodyLimitError extends Error {}

async function readLimitedBody(stream: ReadableStream<Uint8Array> | null, maxBytes: number, signal: AbortSignal) {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new BodyLimitError("body exceeds size limit");
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

export async function POST(request: NextRequest) {
  const now = Date.now();
  for (const [key, entry] of requestRates) if (entry.expires <= now) requestRates.delete(key);
  const key = request.headers.get("x-vercel-forwarded-for") || "local";
  const entry = requestRates.get(key) || { count: 0, expires: now + 60000 };
  entry.count += 1;
  if (entry.count > 120 || (!requestRates.has(key) && requestRates.size >= 10000)) return jsonRpcError("", 429, -32005, "RPC request limit exceeded.");
  requestRates.set(key, entry);
  if (activeRequests >= 32) return jsonRpcError("", 503, -32005, "RPC is busy. Retry shortly.");
  activeRequests += 1;
  try {
    return await forwardRequest(request);
  } finally {
    activeRequests -= 1;
  }
}

async function forwardRequest(request: NextRequest) {
  let body = "";
  try {
    body = await readLimitedBody(request.body, 256000, AbortSignal.any([request.signal, AbortSignal.timeout(10000)]));
  } catch (error) {
    return error instanceof BodyLimitError
      ? jsonRpcError("", 413, -32600, "RPC request is too large.")
      : jsonRpcError("", 408, -32600, "RPC request body was interrupted or timed out.");
  }
  try {
    const parsed = JSON.parse(body);
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    if (!calls.length || calls.length > 10 || calls.some((call) => !call || typeof call !== "object" || Array.isArray(call)
      || call.jsonrpc !== "2.0" || !ALLOWED_METHODS.has(call.method)
      || (call.params !== undefined && (call.params === null || typeof call.params !== "object"))
      || (call.id !== undefined && call.id !== null && typeof call.id !== "string" && !(typeof call.id === "number" && Number.isSafeInteger(call.id))))) {
      return jsonRpcError(body, 400, -32600, "Unsupported RPC method or batch.");
    }
  } catch {
    return jsonRpcError(body, 400, -32700, "Invalid JSON RPC request.");
  }
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(25000)]);
    const upstream = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      cache: "no-store",
      signal,
    });
    const text = await readLimitedBody(upstream.body, 4_000_000, signal);
    const contentType = upstream.headers.get("content-type") || "";
    if (contentType.includes("json")) {
      JSON.parse(text);
      return new NextResponse(text, {
        status: upstream.status,
        headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
      });
    }

    return jsonRpcError(
      body,
      upstream.status === 429 ? 429 : 502,
      upstream.status === 429 ? -32005 : -32000,
      upstream.status === 429
        ? "Studio Next RPC rate limit exceeded. Retry shortly."
        : `Studio Next RPC returned a non-JSON response (${upstream.status}).`,
    );
  } catch {
    return jsonRpcError(body, 502, -32000, "Studio Next RPC is temporarily unavailable or returned an invalid response.");
  }
}

function jsonRpcError(body: string, status: number, code: number, message: string) {
  let requestBody: unknown = null;
  try {
    requestBody = JSON.parse(body);
  } catch {}
  const errorFor = (entry: unknown) => ({
    jsonrpc: "2.0",
    id: entry && typeof entry === "object" && "id" in entry
      && (typeof entry.id === "string" || (typeof entry.id === "number" && Number.isSafeInteger(entry.id)))
      ? (entry as { id: unknown }).id
      : null,
    error: {
      code,
      message,
    },
  });
  const responseBody = Array.isArray(requestBody) && requestBody.length > 0 && requestBody.length <= 10
    ? requestBody.map(errorFor)
    : errorFor(requestBody);
  return NextResponse.json(responseBody, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
