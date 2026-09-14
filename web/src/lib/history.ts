import type { Capability, Dispute, EvidenceRecord, Job } from "./types";

export type HistoryCursor = { capabilities: number; jobs: number; evidence: number; disputes: number };
type Reader = (method: string, args?: bigint[]) => Promise<unknown>;

export async function loadRegistry(reader: Reader, cursor?: HistoryCursor) {
  const end = cursor ?? await reader("get_counts") as HistoryCursor;
  if (!end || ["capabilities", "jobs", "evidence", "disputes"].some((key) => !Number.isSafeInteger(end[key as keyof HistoryCursor]) || end[key as keyof HistoryCursor] < 0)) {
    throw new Error("Invalid registry history cursor");
  }
  async function page<T>(method: string, count: number): Promise<{ items: T[]; cursor: number }> {
    if (count === 0) return { items: [], cursor: 0 };
    const start = Math.max(0, count - 50);
    const value = await reader(method, [BigInt(start), BigInt(count - start)]) as { items: T[]; next_cursor: number; total: number };
    if (!Array.isArray(value?.items) || value.items.length !== count - start || value.next_cursor !== count || value.total < count) {
      throw new Error("Invalid registry page response");
    }
    return { items: value.items, cursor: start };
  }
  const [capabilities, jobs, evidence, disputes] = await Promise.all([
    page<Capability>("get_capabilities_page", end.capabilities),
    page<Job>("get_jobs_page", end.jobs),
    page<EvidenceRecord>("get_evidence_page", end.evidence),
    page<Dispute>("get_disputes_page", end.disputes),
  ]);
  return {
    capabilities: capabilities.items, jobs: jobs.items, evidence: evidence.items, disputes: disputes.items,
    history: { capabilities: capabilities.cursor, jobs: jobs.cursor, evidence: evidence.cursor, disputes: disputes.cursor },
  };
}
