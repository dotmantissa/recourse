import { NextRequest, NextResponse } from "next/server";

const RPC_URL = process.env.RECOURSE_RPC ?? "https://studio-dev.genlayer.com/api";

export async function POST(request: NextRequest) {
  const body = await request.text();
  const upstream = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    cache: "no-store",
  });
  return new NextResponse(await upstream.text(), {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}

