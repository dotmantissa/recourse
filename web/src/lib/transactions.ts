export type TransactionScope = { chainId: number; contractAddress: string; wallet: string };
export type FeeQuote = { method: string; valueWei: string; feeWei: string; totalWei: string; recipients: string[] };
export type PendingTransaction = TransactionScope & {
  version: 1;
  id: string;
  method: string;
  valueWei: string;
  feeWei: string;
  createdAt: number;
  hash: string | null;
};
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type TransactionEnvironment = {
  storage: StorageLike;
  scope: TransactionScope;
  lock: <Result>(key: string, operation: () => Promise<Result>) => Promise<Result>;
  changed: () => void;
};

export function pendingTransactionKey(scope: TransactionScope) {
  if (!Number.isSafeInteger(scope.chainId) || scope.chainId < 1
    || !/^0x[0-9a-f]{40}$/i.test(scope.contractAddress) || !/^0x[0-9a-f]{40}$/i.test(scope.wallet)) throw new Error("Invalid transaction scope.");
  return `recourse:transaction:${scope.chainId}:${scope.contractAddress.toLowerCase()}:${scope.wallet.toLowerCase()}`;
}

export function readPendingTransaction(storage: StorageLike, scope: TransactionScope): PendingTransaction | null {
  const raw = storage.getItem(pendingTransactionKey(scope));
  if (raw === null) return null;
  let value: PendingTransaction;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Pending transaction storage is corrupt. Check wallet history before retrying any write.");
  }
  if (!value || value.version !== 1 || pendingTransactionKey(value) !== pendingTransactionKey(scope)
    || typeof value.id !== "string" || !value.id || typeof value.method !== "string" || !/^[a-z_]+$/.test(value.method)
    || typeof value.valueWei !== "string" || !/^\d+$/.test(value.valueWei)
    || typeof value.feeWei !== "string" || !/^\d+$/.test(value.feeWei) || !Number.isSafeInteger(value.createdAt)
    || (value.hash !== null && (typeof value.hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(value.hash)))) {
    throw new Error("Pending transaction storage is invalid. Check wallet history before retrying any write.");
  }
  return value;
}

function save(environment: TransactionEnvironment, record: PendingTransaction) {
  const key = pendingTransactionKey(environment.scope);
  const encoded = JSON.stringify(record);
  environment.storage.setItem(key, encoded);
  if (environment.storage.getItem(key) !== encoded) throw new Error("Pending transaction could not be saved. Do not retry a potentially broadcast write.");
  environment.changed();
}

function clear(environment: TransactionEnvironment, expectedId: string) {
  if (readPendingTransaction(environment.storage, environment.scope)?.id !== expectedId) throw new Error("Pending transaction changed; refusing to clear it.");
  environment.storage.removeItem(pendingTransactionKey(environment.scope));
  if (environment.storage.getItem(pendingTransactionKey(environment.scope)) !== null) throw new Error("Pending transaction could not be cleared.");
  environment.changed();
}

function walletRejected(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    if ((current as { code?: unknown }).code === 4001) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function submitTrackedTransaction(
  environment: TransactionEnvironment,
  prepare: () => Promise<{ quote: FeeQuote; send: () => Promise<string> }>,
  approve: (quote: FeeQuote) => Promise<boolean>,
  confirm: (record: PendingTransaction) => Promise<boolean>,
) {
  return environment.lock(pendingTransactionKey(environment.scope), async () => {
    if (readPendingTransaction(environment.storage, environment.scope)) throw new Error("A previous transaction needs reconciliation. Resume it instead of submitting another write.");
    const { quote, send } = await prepare();
    if (BigInt(quote.valueWei) < 0n || BigInt(quote.feeWei) < 0n || BigInt(quote.totalWei) !== BigInt(quote.valueWei) + BigInt(quote.feeWei)) throw new Error("Invalid fee quote.");
    const approvalDeadline = Date.now() + 120_000;
    if (!await approve(quote)) throw new Error("Transaction cancelled before wallet submission.");
    if (Date.now() >= approvalDeadline) throw new Error("Fee quote expired. Review a fresh estimate before submitting.");
    const record: PendingTransaction = {
      ...environment.scope, version: 1, id: crypto.randomUUID(), method: quote.method,
      valueWei: quote.valueWei, feeWei: quote.feeWei, createdAt: Date.now(), hash: null,
    };
    save(environment, record);
    let hash: string;
    try {
      hash = await send();
    } catch (cause) {
      if (walletRejected(cause)) {
        clear(environment, record.id);
        throw new Error("The wallet rejected the transaction.");
      }
      throw new Error("Wallet submission outcome is unknown. Check wallet history; this write will not be repeated automatically.");
    }
    if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error("The wallet did not return a valid transaction ID. Check wallet history before retrying.");
    record.hash = hash;
    try {
      save(environment, record);
    } catch {
      throw new Error(`Transaction ${hash} may be broadcast, but its ID could not be saved. Retain this ID and do not resubmit.`);
    }
    return finish(environment, record, confirm);
  });
}

export function transactionOutcome(transaction: { sender?: string; recipient?: string; hash?: string; statusName?: string; successful: boolean }, record: PendingTransaction) {
  if (transaction.sender?.toLowerCase() !== record.wallet.toLowerCase()
    || transaction.recipient?.toLowerCase() !== record.contractAddress.toLowerCase()
    || (transaction.hash && transaction.hash.toLowerCase() !== record.hash?.toLowerCase())) throw new Error("Transaction identity does not match the saved write.");
  if (transaction.statusName === "CANCELED") return false;
  if (transaction.statusName !== "FINALIZED") return null;
  return transaction.successful;
}

async function finish(environment: TransactionEnvironment, record: PendingTransaction, confirm: (record: PendingTransaction) => Promise<boolean>) {
  let successful: boolean;
  try {
    successful = await confirm(record);
  } catch {
    throw new Error(`Transaction ${record.hash} is not confirmed yet. Its ID is saved; use Check finality, not another submission.`);
  }
  clear(environment, record.id);
  if (!successful) throw new Error(`Transaction ${record.hash} finalized with an execution failure. Fees may still have been charged.`);
  return record.hash!;
}

export async function resumeTrackedTransaction(environment: TransactionEnvironment, confirm: (record: PendingTransaction) => Promise<boolean>) {
  return environment.lock(pendingTransactionKey(environment.scope), async () => {
    const record = readPendingTransaction(environment.storage, environment.scope);
    if (!record?.hash) throw new Error("No saved transaction ID is available. Check wallet history before taking further action.");
    return finish(environment, record, confirm);
  });
}

export async function acknowledgeUnbroadcastTransaction(environment: TransactionEnvironment, expectedId: string, confirmedNotBroadcast: boolean) {
  return environment.lock(pendingTransactionKey(environment.scope), async () => {
    const record = readPendingTransaction(environment.storage, environment.scope);
    if (!confirmedNotBroadcast || !record || record.hash || record.id !== expectedId) throw new Error("Only a verified unbroadcast intent can be cleared.");
    clear(environment, expectedId);
  });
}
