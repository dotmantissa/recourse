import type { Job } from "./types";

export function recoveryReady(job: Job, now: number) {
  if (["funded", "accepted"].includes(job.status)) return Number(job.receipt_deadline_at ?? job.deadline_at) * 1000 <= now;
  if (["receipt_submitted", "disputed"].includes(job.status) && !job.evidence_id) return Number(job.evidence_deadline_at) * 1000 <= now;
  return job.status === "disputed" && Number(job.resolution_deadline_at) * 1000 <= now;
}

export function canDispute(job: Job, now: number) {
  return job.status === "receipt_submitted" && Number(job.challenge_deadline_at) * 1000 > now;
}
