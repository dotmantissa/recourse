"use client";

import {
  createClient,
  encodeInternalMessageFeeParams,
  isSuccessful,
  MessageType,
} from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import JSONbig from "json-bigint";
import { ADAPTER_URL, CONTRACT_ADDRESS, RPC_URL } from "./config";
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

function rpcErrorMessage(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/unexpected token ['"<]/i.test(message) || /<!doctype html>|not valid json/i.test(message)) {
    return "Studio Next returned a temporary non-JSON response. Try again shortly.";
  }
  if (/rate limit|too many requests|429/i.test(message)) {
    return "Studio Next rate-limited the request. Try again in about a minute.";
  }
  return message;
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
  const canonical = canonicalJson({
    capability_id: String(capabilityId),
    request: request ?? null,
    request_label: String(requestLabel).trim(),
    nonce: String(nonce).trim(),
    version: "recourse-request-v2",
  });
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
}

export function resultAccessMessage(jobId: string, requestHash: string) {
  return `Recourse result access: ${jobId}:${requestHash}`;
}

export async function executeFundedCapability(
  capability: Capability,
  job: Job,
  request: CapabilityRequest | null,
  nonce: string,
): Promise<JobResult> {
  const requestHash = await hashRequest(capability.capability_id, job.request_label, request, nonce);
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
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(body?.error || `Capability execution failed (${response.status}).`));
  }
  return body as JobResult;
}

export async function fetchJobResult(
  job: Job,
  accessToken: string,
  provider: WalletProvider,
  address: string,
): Promise<JobResult> {
  const signature = await provider.request({
    method: "personal_sign",
    params: [resultAccessMessage(job.job_id, job.request_hash), address],
  });
  if (typeof signature !== "string" || !signature) {
    throw new Error("The wallet did not authorize access to this result.");
  }
  if (!ADAPTER_URL) throw new Error("The result adapter is not configured.");
  const response = await fetch(`${ADAPTER_URL}/results/${encodeURIComponent(job.job_id)}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "x-recourse-wallet": address,
      "x-recourse-signature": signature,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(body?.error || `Result retrieval failed (${response.status}).`));
  }
  return body as JobResult;
}

export async function loadState(): Promise<AppState> {
  const [capabilities, jobs, evidence, disputes] = await Promise.all([
    read("get_capabilities"),
    read("get_jobs"),
    read("get_evidence_records"),
    read("get_disputes"),
  ]);
  return {
    capabilities: parse<Capability[]>(capabilities || "[]"),
    jobs: parse<Job[]>(jobs || "[]"),
    receipts: {},
    evidence: parse<EvidenceRecord[]>(evidence || "[]"),
    disputes: parse<Dispute[]>(disputes || "[]"),
  };
}

export async function readJobs(): Promise<Job[]> {
  return parse<Job[]>(await read("get_jobs") || "[]");
}

export async function readJob(jobId: string): Promise<Job | null> {
  const value = await read("get_job", [jobId]);
  if (!value) return null;
  return parse<Job>(value);
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

export async function write(
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
  let hash;
  try {
    hash = await client.writeContract({
      address: CONTRACT_ADDRESS as `0x${string}`,
      functionName,
      args,
      value,
      fees: {
        distribution: fees.distribution,
        messageAllocations: fees.messageAllocations,
        feeValue: fees.feeValue,
      },
    });
  } catch (cause) {
    throw new Error(rpcErrorMessage(cause));
  }
  let receipt;
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      receipt = await client.waitForTransactionReceipt({
        hash,
        waitUntil: "finalized",
        interval: 3000,
        retries: 240,
        fullTransaction: true,
      });
      break;
    } catch (cause) {
      lastError = cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!isTransientRpcError(message) || attempt === 3) {
        throw new Error(rpcErrorMessage(cause));
      }
      await sleep(1500 * (attempt + 1));
    }
  }
  if (!receipt) throw new Error(rpcErrorMessage(lastError));
  if (!isSuccessful(receipt)) {
    const result = String(receipt.txExecutionResultName ?? "unknown");
    throw new Error(`Transaction finalized with execution result ${result}.`);
  }
  clearReadCache();
  return String(hash);
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
