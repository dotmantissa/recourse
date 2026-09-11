"use client";

import {
  createClient,
  encodeInternalMessageFeeParams,
  MessageType,
} from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import JSONbig from "json-bigint";
import { CONTRACT_ADDRESS, RPC_URL } from "./config";
import type {
  Capability,
  Dispute,
  EvidenceRecord,
  Job,
  Receipt,
  Reputation,
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

function getReader() {
  reader ??= createClient({ chain: studioDevnet, endpoint: RPC_URL });
  return reader;
}

const jsonParser = JSONbig({ storeAsString: true });

function parse<T>(value: unknown): T {
  return typeof value === "string" ? (jsonParser.parse(value) as T) : (value as T);
}

function canonicalJson(value: Record<string, unknown>) {
  const ordered = Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  );
  return JSON.stringify(ordered);
}

async function read(functionName: string, args: CalldataEncodable[] = []) {
  if (!CONTRACT_ADDRESS) return "";
  return getReader().readContract({
    address: CONTRACT_ADDRESS as `0x${string}`,
    functionName,
    args,
    jsonSafeReturn: true,
  });
}

export async function loadState(): Promise<AppState> {
  const [capabilities, jobs, evidence, disputes] = await Promise.all([
    read("get_capabilities"),
    read("get_jobs"),
    read("get_evidence_records"),
    read("get_disputes"),
  ]);
  const jobList = parse<Job[]>(jobs || "[]");
  const receiptPairs = await Promise.all(
    jobList
      .filter((job) => job.receipt_hash)
      .map(async (job) => [job.job_id, parse<Receipt>(await read("get_receipt", [job.job_id]))] as const),
  );
  return {
    capabilities: parse<Capability[]>(capabilities || "[]"),
    jobs: jobList,
    receipts: Object.fromEntries(receiptPairs),
    evidence: parse<EvidenceRecord[]>(evidence || "[]"),
    disputes: parse<Dispute[]>(disputes || "[]"),
  };
}

export async function readReputation(address: string): Promise<Reputation | null> {
  if (!CONTRACT_ADDRESS || !address) return null;
  return parse<Reputation>(await read("get_reputation", [address]));
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
    fees = await client.estimateTransactionFeesForWrite({
      address: CONTRACT_ADDRESS as `0x${string}`,
      functionName,
      args,
      value,
      leaderOnly: false,
      ...feeOptions,
    });
  } catch {
    fees = await client.estimateTransactionFees(feeOptions);
  }
  const hash = await client.writeContract({
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
  const receipt = await client.waitForTransactionReceipt({
    hash,
    waitUntil: "finalized",
    interval: 3000,
    retries: 240,
    fullTransaction: true,
  });
  const result = String(receipt.txExecutionResultName ?? "");
  if (result && result !== "FINISHED_WITH_RETURN") {
    throw new Error(`Transaction finalized with execution result ${result}.`);
  }
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
