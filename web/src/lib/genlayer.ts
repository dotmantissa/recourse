"use client";

import {
  createClient,
  encodeInternalMessageFeeParams,
  isSuccessful,
  MessageType,
} from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { TransactionHashVariant, transactionsStatusNumberToName, type TransactionHash } from "genlayer-js/types";
import JSONbig from "json-bigint";
import { ADAPTER_URL, CHAIN_ID, CONTRACT_ADDRESS, RPC_URL } from "./config";
import { requestCommitment, resultAccessMessage, verifyDelivery } from "../../../sdk/protocol.mjs";
import { loadRegistry, loadLegacyRegistry, type HistoryCursor } from "./history";
import { assertPurchaseReadiness } from "./release";
import manifest from "../../../agents/manifest.json";
import { digest } from "../../../sdk/protocol.mjs";
import { acknowledgeUnbroadcastTransaction, readPendingTransaction, resumeTrackedTransaction, submitTrackedTransaction, transactionOutcome, type FeeQuote, type PendingTransaction } from "./transactions";
import type {
  Capability,
  Dispute,
  EvidenceRecord,
  Job,
  Receipt,
  Reputation,
  CapabilityRequest,
  JobResult,
} from "./types";

export type CalldataEncodable =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | Array<CalldataEncodable>
  | { [key: string]: CalldataEncodable };

export type WalletProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

export type AppState = {
  legacy?: boolean;
  history?: HistoryCursor;
  capabilities: Capability[];
  jobs: Job[];
  receipts: Record<string, Receipt>;
  evidence: EvidenceRecord[];
  disputes: Dispute[];
};

let reader: ReturnType<typeof createClient> | null = null;
const READ_CACHE_TTL_MS = 15_000;
const REPUTATION_CACHE_TTL_MS = 60_000;
const READ_MIN_INTERVAL_MS = 350;
const READ_WINDOW_MS = 60_000;
const MAX_READS_PER_WINDOW = 24;
const readCache = new Map<string, { value: unknown; expiresAt: number }>();
const readInFlight = new Map<string, Promise<unknown>>();
let readQueue = Promise.resolve();
const readTimestamps: number[] = [];

function isTransientRpcError(message: string) {
  return /rate limit|too many requests|429|unexpected token ['"<]/i.test(message)
    || /not valid json|<!doctype html>|fetch failed|502|503|504/i.test(message);
}

function sleep(ms: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function retryTransientRpc<T>(operation: () => Promise<T>, retries = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (cause) {
      lastError = cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!isTransientRpcError(message) || attempt === retries) throw cause;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastError;
}

function getReader() {
  reader ??= createClient({ chain: studioDevnet, endpoint: RPC_URL });
  return reader;
}

const jsonParser = JSONbig({ storeAsString: true });

function parse<T>(value: unknown): T {
  return typeof value === "string" ? (jsonParser.parse(value) as T) : (value as T);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function scheduleRead<T>(operation: () => Promise<T>): Promise<T> {
  const run = readQueue.then(async () => {
    while (true) {
      const now = Date.now();
      while (readTimestamps[0] && now - readTimestamps[0] >= READ_WINDOW_MS) {
        readTimestamps.shift();
      }
      if (readTimestamps.length < MAX_READS_PER_WINDOW) {
        const elapsed = Date.now() - (readTimestamps.at(-1) ?? 0);
        if (elapsed < READ_MIN_INTERVAL_MS) {
          await new Promise((resolve) =>
            globalThis.setTimeout(resolve, READ_MIN_INTERVAL_MS - elapsed),
          );
        }
        readTimestamps.push(Date.now());
        return operation();
      }
      const waitMs = READ_WINDOW_MS - (Date.now() - readTimestamps[0]) + 50;
      await new Promise((resolve) => globalThis.setTimeout(resolve, waitMs));
    }
  });
  readQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function read(functionName: string, args: CalldataEncodable[] = []) {
  if (!CONTRACT_ADDRESS) return "";
  const key = `${functionName}:${JSON.stringify(args, (_, value) => typeof value === "bigint" ? `${value}n` : value)}`;
  const cached = readCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const existing = readInFlight.get(key);
  if (existing) return existing;

  const request = (async () => {
    let attempt = 0;
    while (true) {
      try {
        const value = await scheduleRead(() =>
          getReader().readContract({
            address: CONTRACT_ADDRESS as `0x${string}`,
            functionName,
            args,
            jsonSafeReturn: true,
            transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
          }),
        );
        readCache.set(key, { value, expiresAt: Date.now() + READ_CACHE_TTL_MS });
        return value;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!isTransientRpcError(message) || attempt >= 3) {
          if (cached) return cached.value;
          throw cause;
        }
        await sleep(2500 * (attempt + 1));
        attempt += 1;
      }
    }
  })();
  readInFlight.set(key, request);
  try {
    return await request;
  } finally {
    readInFlight.delete(key);
  }
}

export function clearReadCache() {
  readCache.clear();
}

export async function hashRequest(
  capabilityId: string,
  requestLabel: string,
  request: CapabilityRequest | null,
  nonce: string,
) {
  const canonical = requestCommitment({ chainId: CHAIN_ID, contractAddress: CONTRACT_ADDRESS, capabilityId, requestLabel, request, nonce });
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
}

export async function executeFundedCapability(
  capability: Capability,
  job: Job,
  request: CapabilityRequest | null,
  nonce: string,
): Promise<JobResult> {
  const requestHash = await hashRequest(capability.capability_id, job.request_label, request, nonce);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(capability.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-recourse-job-id": job.job_id,
      "x-recourse-request-hash": requestHash,
      "x-recourse-request-label": job.request_label,
      "x-recourse-capability-id": capability.capability_id,
      "x-recourse-request-nonce": nonce,
    },
    body: JSON.stringify({
      capability_id: capability.capability_id,
      request_label: job.request_label,
      nonce,
      request,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(body?.error || `Capability execution failed (${response.status}).`));
  }
    if (response.status === 202) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 4000));
      continue;
    }
  await verifyDelivery(body, job, capability);
  return body as JobResult;
  }
  throw new Error("Execution is durably queued and continues in the background. Reopen My escrows to recover the result.");
}

export async function fetchJobResult(
  job: Job,
  capability: Capability,
  accessToken: string,
  provider: WalletProvider,
  address: string,
): Promise<JobResult> {
  const audience = new URL(capability.endpoint).origin;
  const expiresAt = Math.floor(Date.now() / 1000) + 180;
  const signature = await provider.request({
    method: "personal_sign",
    params: [resultAccessMessage({ chainId: CHAIN_ID, contractAddress: CONTRACT_ADDRESS, jobId: job.job_id,
      requestHash: job.request_hash, wallet: address, audience, expiresAt }), address],
  });
  if (typeof signature !== "string" || !signature) {
    throw new Error("The wallet did not authorize access to this result.");
  }
  const response = await fetch(`${audience}/results/${encodeURIComponent(job.job_id)}`, {
    headers: {
      ...(ADAPTER_URL && audience === new URL(ADAPTER_URL).origin ? { Authorization: `Bearer ${accessToken}` } : {}),
      "x-recourse-wallet": address,
      "x-recourse-signature": signature,
      "x-recourse-expires-at": String(expiresAt),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(body?.error || `Result retrieval failed (${response.status}).`));
  }
  await verifyDelivery(body, job, capability);
  return body as JobResult;
}

export async function loadState(cursor?: HistoryCursor): Promise<AppState> {
  if (!CONTRACT_ADDRESS) return { capabilities: [], jobs: [], receipts: {}, evidence: [], disputes: [] };
  if (CHAIN_ID === 61997 && CONTRACT_ADDRESS.toLowerCase() === "0x51edcf8f3bdbb69a6e83b1ca5076a77c2e5cdc35") {
    return { ...await loadLegacyRegistry(async (method, args) => parse(await read(method, args)), cursor), receipts: {} };
  }
  const registry = await loadRegistry(async (method, args) => parse(await read(method, args)), cursor);
  return { ...registry, receipts: {} };
}

export async function readJobs(): Promise<Job[]> {
  const counts = parse<{ jobs: number }>(await read("get_counts"));
  const cursor = Math.max(0, counts.jobs - 50);
  return parse<{ items: Job[] }>(await read("get_jobs_page", [BigInt(cursor), 50n])).items;
}

export async function readJob(jobId: string): Promise<Job | null> {
  const value = await read("get_job", [jobId]);
  if (!value) return null;
  return parse<Job>(value);
}

export async function readCapability(capabilityId: string): Promise<Capability | null> {
  const value = await read("get_capability", [capabilityId]);
  return value ? parse<Capability>(value) : null;
}

export async function readReputation(address: string): Promise<Reputation | null> {
  if (!CONTRACT_ADDRESS || !address) return null;
  const key = `reputation:${address.toLowerCase()}`;
  const cached = readCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return parse<Reputation>(cached.value);
  const value = await read("get_reputation", [address]);
  readCache.set(key, { value, expiresAt: Date.now() + REPUTATION_CACHE_TTL_MS });
  return parse<Reputation>(value);
}

export async function readBalance(address: string): Promise<bigint> {
  if (!address) return 0n;
  return retryTransientRpc(() =>
    scheduleRead(() =>
      getReader().getBalance({ address: address as `0x${string}` }),
    ),
  );
}

export async function fundStudioAccount(
  address: string,
  amountWei = 10_000_000_000_000_000_000n,
) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error("A valid Studio Next wallet address is required.");
  }
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: `{"jsonrpc":"2.0","id":1,"method":"sim_fundAccount","params":["${address}",${amountWei}]}`,
  });
  const text = await response.text();
  let body: { result?: unknown; error?: { message?: unknown } } | null = null;
  try {
    body = JSON.parse(text);
  } catch {}
  if (!response.ok || body?.error) {
    const fallback = response.status === 429
      ? "Studio Next rate-limited the faucet request. Try again in about a minute."
      : "Studio Next faucet request failed.";
    throw new Error(String(body?.error?.message || fallback));
  }
  clearReadCache();
  return String(body?.result || "");
}

function writer(address: string, provider: WalletProvider) {
  return createClient({
    chain: studioDevnet,
    endpoint: RPC_URL,
    account: address as `0x${string}`,
    provider,
  });
}

async function prepareTransaction(
  address: string,
  provider: WalletProvider,
  functionName: string,
  args: CalldataEncodable[] = [],
  value = 0n,
  messageRecipients: string[] = [],
) {
  if (!CONTRACT_ADDRESS) throw new Error("Deploy Recourse and set the contract address first.");
  const client = writer(address, provider);
  const uniqueRecipients = [...new Set(messageRecipients.map((item) => item.toLowerCase()))];
  const messageAllocations = uniqueRecipients.map((recipient) => ({
    messageType: MessageType.Internal,
    onAcceptance: false,
    recipient: recipient as `0x${string}`,
    callKey: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
    budget: 150000000000000000n,
    feeParams: encodeInternalMessageFeeParams({
      leaderTimeunitsAllocation: 100n,
      validatorTimeunitsAllocation: 200n,
      appealRounds: 0n,
      executionBudgetPerRound: 25000000000000000n,
      rotations: [3n],
      maxPriceGenPerTimeUnit: 2n,
      storageFeeMaxGasPrice: 300000000n,
      receiptFeeMaxGasPrice: 300000000n,
    }),
  }));
  const feeOptions =
    messageAllocations.length > 0
      ? {
          totalMessageFees: 150000000000000000n * BigInt(messageAllocations.length),
          messageAllocations,
        }
      : {};
  let fees;
  try {
    fees = await retryTransientRpc(() =>
      client.estimateTransactionFeesForWrite({
        address: CONTRACT_ADDRESS as `0x${string}`,
        functionName,
        args,
        value,
        leaderOnly: false,
        ...feeOptions,
      }),
    );
  } catch {
    fees = await retryTransientRpc(() => client.estimateTransactionFees(feeOptions));
  }
  return {
    quote: { method: functionName, valueWei: String(value), feeWei: String(fees.feeValue), totalWei: String(value + BigInt(fees.feeValue)), recipients: uniqueRecipients },
    send: async () => String(await client.writeContract({
      address: CONTRACT_ADDRESS as `0x${string}`,
      functionName,
      args,
      value,
      fees: {
        distribution: fees.distribution,
        messageAllocations: fees.messageAllocations,
        feeValue: fees.feeValue,
      },
    })),
  };
}

function transactionEnvironment(address: string) {
  return {
    storage: window.localStorage,
    scope: { chainId: CHAIN_ID, contractAddress: CONTRACT_ADDRESS, wallet: address },
    changed: () => window.dispatchEvent(new Event("recourse-transaction")),
    lock: async <Result>(key: string, operation: () => Promise<Result>): Promise<Result> => {
      if (!navigator.locks) throw new Error("This browser needs Web Locks support for safe transaction recovery.");
      return navigator.locks.request(key, { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error("Another tab is handling this wallet's transaction. Wait for it to finish.");
        return operation();
      });
    },
  };
}

export function pendingTransaction(address: string) {
  const environment = transactionEnvironment(address);
  return readPendingTransaction(environment.storage, environment.scope);
}

async function confirmTransaction(record: PendingTransaction) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const receipt = await getReader().getTransaction({ hash: record.hash as TransactionHash });
    const outcome = transactionOutcome({
      sender: receipt.sender ?? receipt.from_address, recipient: receipt.recipient ?? receipt.to_address,
      hash: receipt.hash ?? receipt.txId,
      statusName: receipt.statusName ?? transactionsStatusNumberToName[String(receipt.status) as keyof typeof transactionsStatusNumberToName] ?? String(receipt.status),
      successful: isSuccessful(receipt),
    }, record);
    if (outcome !== null) return outcome;
    if (attempt < 5) await sleep(1500);
  }
  throw new Error("Transaction finality is still pending.");
}

export async function resumeTransaction(address: string) {
  const hash = await resumeTrackedTransaction(transactionEnvironment(address), confirmTransaction);
  clearReadCache();
  return hash;
}

export async function clearUnbroadcastTransaction(address: string, id: string, confirmedNotBroadcast: boolean) {
  await acknowledgeUnbroadcastTransaction(transactionEnvironment(address), id, confirmedNotBroadcast);
}

export async function write(
  address: string,
  provider: WalletProvider,
  functionName: string,
  args: CalldataEncodable[] = [],
  value = 0n,
  messageRecipients: string[] = [],
  approve?: (quote: FeeQuote) => Promise<boolean>,
) {
  if (!approve) throw new Error("Explicit fee approval is required before sending a transaction.");
  if (["create_job", "register_capability", "resume_capability"].includes(functionName)) {
    await assertPurchaseReadiness({ adapter: ADAPTER_URL, chainId: CHAIN_ID, contractAddress: CONTRACT_ADDRESS, rpc: RPC_URL, manifestHash: digest(manifest) });
  }
  const hash = await submitTrackedTransaction(transactionEnvironment(address),
    () => prepareTransaction(address, provider, functionName, args, value, messageRecipients),
    async (quote) => {
      if (!await approve(quote)) return false;
      const [chainId, accounts] = await Promise.all([
        provider.request({ method: "eth_chainId" }), provider.request({ method: "eth_accounts" }),
      ]);
      if (Number(chainId) !== CHAIN_ID || !Array.isArray(accounts) || String(accounts[0]).toLowerCase() !== address.toLowerCase()) {
        throw new Error("Wallet or chain changed during approval. Review the transaction again.");
      }
      return true;
    }, confirmTransaction);
  clearReadCache();
  return hash;
}

export async function connectWallet(provider: WalletProvider) {
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const address = Array.isArray(accounts) ? String(accounts[0] ?? "") : "";
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error("The wallet did not return an address.");
  return address;
}

export async function signReceipt(
  provider: WalletProvider,
  address: string,
  receipt: {
    version: "recourse-receipt-v2";
    chain_id: number;
    contract_address: string;
    capability_id: string;
    job_id: string;
    request_hash: string;
    output_hash: string;
    response_status: string;
    response_code: number;
    latency_ms: number;
    schema_valid: boolean;
    completed_at: string;
    provider: string;
  },
) {
  const canonical = canonicalJson(receipt);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await window.crypto.subtle.digest("SHA-256", bytes);
  const receiptHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const signature = await provider.request({
    method: "personal_sign",
    params: [`0x${receiptHash}`, address],
  });
  if (typeof signature !== "string" || !signature) {
    throw new Error("The wallet did not return a receipt signature.");
  }
  return { receiptHash, signature };
}
