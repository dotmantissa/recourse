import { address } from "./privy";
import { CHAIN_ID, CONTRACT_ADDRESS } from "../../src/lib/config";
import { readPendingTransaction, submitTrackedTransaction, resumeTrackedTransaction, type FeeQuote } from "../../src/lib/transactions";

const scope = { chainId: CHAIN_ID, contractAddress: CONTRACT_ADDRESS, wallet: address };
const environment = () => ({ storage: localStorage, scope, lock: <Result,>(key: string, operation: () => Promise<Result>) => navigator.locks.request(key, operation), changed: () => window.dispatchEvent(new Event("recourse-transaction")) });
const capability = { capability_id: "1", provider: "0x3333333333333333333333333333333333333333", name: "Independent service", endpoint: "https://provider.example/work", terms: "Return a JSON object", deadline_seconds: 30, output_schema: '{"type":"object"}', timeout_refund_bps: 10000, malformed_refund_bps: 7500, price_wei: "2000000000000000000", collateral_wei: "10000000000000000000", reserved_collateral_wei: "0", status: "active" };
export const loadState = async () => {
  if (new URLSearchParams(location.search).has("offline")) throw new Error("Fixture RPC unavailable");
  return { legacy: new URLSearchParams(location.search).has("legacy"), capabilities: [capability, { ...capability, capability_id: "2", provider: address, name: "Owned service" }], jobs: [], receipts: {}, evidence: [], disputes: [] };
};
export const clearReadCache = () => {};
export const readBalance = async () => 100000000000000000000n;
export const readReputation = async (provider: string) => {
  if (new URLSearchParams(location.search).has("history-offline") && provider !== address) throw new Error("unavailable");
  return { provider, jobs: 0, successful_jobs: 0, breached_jobs: 0, disputed_jobs: 0, refunded_wei: "0", settled_wei: "0", provider_paid_wei: "0", reliability_bps: 0 };
};
export const hashRequest = async () => `sha256:${"a".repeat(64)}`;
export const pendingTransaction = () => readPendingTransaction(localStorage, scope);
export const write = async (wallet: string, provider: unknown, method: string, args: unknown[], value: bigint, recipients: string[], approve: (quote: FeeQuote) => Promise<boolean>) => submitTrackedTransaction(environment(), async () => ({
  quote: { method, valueWei: String(value), feeWei: "100", totalWei: String(value + 100n), recipients },
  send: async () => { localStorage.setItem("fixture-submissions", String(Number(localStorage.getItem("fixture-submissions")) + 1)); return `0x${"a".repeat(64)}`; },
}), approve, async () => { throw new Error("Fixture finality unavailable; resume without resubmission"); });
export const resumeTransaction = async () => resumeTrackedTransaction(environment(), async () => true);
export const clearUnbroadcastTransaction = async () => { throw new Error("Not available in fixture"); };
export const readCapability = async () => capability;
export const readJob = async () => null;
export const readJobs = async () => [];
export const executeFundedCapability = async () => { throw new Error("No live provider in browser fixture"); };
export const fetchJobResult = async () => null;
export const fundStudioAccount = async () => {};
export const signReceipt = async () => "fixture";
