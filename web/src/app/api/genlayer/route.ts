import { NextRequest, NextResponse } from "next/server";

const RPC_URL = process.env.RECOURSE_RPC ?? "https://studio-dev.genlayer.com/api";

export async function POST(request: NextRequest) {
  const body = await request.text();
  let upstream: Response;
  try {
    upstream = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      cache: "no-store",
    });
  } catch {
    return jsonRpcError(body, 502, -32000, "Studio Next RPC is temporarily unavailable.");
  }
  const text = await upstream.text();
  const contentType = upstream.headers.get("content-type") || "";
  if (contentType.includes("json")) {
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "Content-Type": contentType },
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
}

function jsonRpcError(body: string, status: number, code: number, message: string) {
  let requestBody: unknown = null;
  try {
    requestBody = JSON.parse(body);
  } catch {}
  const errorFor = (entry: unknown) => ({
    jsonrpc: "2.0",
    id: entry && typeof entry === "object" && "id" in entry
      ? (entry as { id: unknown }).id
      : null,
    error: {
      code,
      message,
    },
  });
  const responseBody = Array.isArray(requestBody)
    ? requestBody.map(errorFor)
    : errorFor(requestBody);
  return NextResponse.json(responseBody, {
    status,
  });
}
