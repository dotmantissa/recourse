import { CHAIN_ID, CONTRACT_ADDRESS } from "./config";
import type { CapabilityRequest, Job } from "./types";

const prefix = `recourse:${CHAIN_ID}:${CONTRACT_ADDRESS.toLowerCase()}:`;

export function saveRequestContext(job: Job, request: CapabilityRequest | null, nonce: string) {
  sessionStorage.setItem(`${prefix}request:${job.buyer.toLowerCase()}:${job.job_id}`, JSON.stringify({ request, nonce }));
}

export function loadRequestContext(job: Job): { request: CapabilityRequest | null; nonce: string } | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(`${prefix}request:${job.buyer.toLowerCase()}:${job.job_id}`) || "null");
    return value && typeof value.nonce === "string" ? value : null;
  } catch {
    return null;
  }
}

export function savePendingRequest(requestHash: string, value: { buyer: string; capabilityId: string; requestLabel: string; request: CapabilityRequest | null; nonce: string }) {
  sessionStorage.setItem(`${prefix}pending:${value.buyer.toLowerCase()}:${requestHash}`, JSON.stringify({ ...value, createdAt: Date.now() }));
}

export function clearPendingRequest(requestHash: string, buyer: string) {
  sessionStorage.removeItem(`${prefix}pending:${buyer.toLowerCase()}:${requestHash}`);
}

export function recoverPendingRequestContexts(jobs: Job[]) {
  for (const job of jobs) {
    const key = `${prefix}pending:${job.buyer.toLowerCase()}:${job.request_hash}`;
    try {
      const pending = JSON.parse(sessionStorage.getItem(key) || "null");
      if (!pending) continue;
      if (Date.now() - Number(pending.createdAt) < 86_400_000 && typeof pending.nonce === "string") {
        saveRequestContext(job, pending.request ?? null, pending.nonce);
      }
      sessionStorage.removeItem(key);
    } catch {}
  }
}

export function clearSessionInputs(buyer: string) {
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith(`${prefix}request:${buyer.toLowerCase()}:`) || key.startsWith(`${prefix}pending:${buyer.toLowerCase()}:`)) sessionStorage.removeItem(key);
  }
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("recourse:request:") || key.startsWith("recourse:pending:")) localStorage.removeItem(key);
  }
}
