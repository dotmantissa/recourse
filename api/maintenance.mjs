export function maintenanceAction(job, now) {
  if (["funded", "accepted"].includes(job.status) && now >= Number(job.receipt_deadline_at)) return "recover_job";
  if (["receipt_submitted", "disputed"].includes(job.status) && !job.evidence_id && now >= Number(job.evidence_deadline_at)) return "recover_job";
  if (job.status === "disputed" && now >= Number(job.resolution_deadline_at)) return "recover_job";
  if (job.status === "disputed" && job.evidence_id) return "resolve_dispute";
  if (job.status === "receipt_submitted" && job.evidence_id && now >= Math.max(Number(job.deadline_at), Number(job.challenge_deadline_at))) return "settle_job";
  return null;
}

export async function runMaintenance({ store, job, action, submit, now = Date.now }) {
  const previous = await store.read(job.job_id);
  const record = previous?.value;
  if (record?.action === action && (record.complete || record.attempts >= 8 || record.next_attempt_at > now() || record.lease_until > now())) return;
  const claim = await store.compareAndSet(job.job_id, previous?.version ?? null, {
    action, attempts: record?.action === action ? record.attempts + 1 : 1, lease_until: now() + 30 * 60_000,
  });
  if (!claim) return;
  try {
    const transaction = await submit(action, action === "resolve_dispute" ? job.dispute_id : job.job_id, [job.buyer, job.provider]);
    await store.compareAndSet(job.job_id, claim.version, { ...claim.value, complete: true, transaction, lease_until: 0 });
  } catch {
    await store.compareAndSet(job.job_id, claim.version, { ...claim.value, lease_until: 0, next_attempt_at: now() + 60_000 });
  }
}
