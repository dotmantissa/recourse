"use client";

import { useState } from "react";
import { readReputation } from "@/lib/genlayer";
import { formatGen } from "@/lib/config";
import type { Reputation } from "@/lib/types";

export function ProviderHistory({ provider }: { provider: string }) {
  const [record, setRecord] = useState<Reputation | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  return <details className="specimen-schema" onToggle={async (event) => {
    if (!event.currentTarget.open || record || loading) return;
    setLoading(true);
    setError("");
    try { setRecord(await readReputation(provider)); } catch { setError("Provider history is unavailable. No trust score is inferred."); }
    finally { setLoading(false); }
  }}>
    <summary>Provider settlement history</summary>
    {loading ? <p role="status">Loading provider history…</p> : error ? <p role="alert">{error}</p> : record ? <>
      <p>{record.jobs === 0 ? "Unrated — no settled jobs." : `${record.successful_jobs}/${record.jobs} jobs settled without a refund; ${record.disputed_jobs} disputed.`}</p>
      <p>{formatGen(record.settled_wei ?? 0)} settled exposure · {formatGen(record.refunded_wei)} refunded from buyer escrow.</p>
      <p>Address-level observations only. Not identity verification or a prediction; self-dealing and new addresses can distort this history.</p>
    </> : null}
  </details>;
}
