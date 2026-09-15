import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Ajv from "ajv";
import JSONbig from "json-bigint";
import "dotenv/config";
import { deploymentScope, requestCommitment, resultAccessMessage, validateAccessExpiry, verifyDelivery, verifyEvidencePacket } from "../sdk/protocol.mjs";
import { createDurableExecutor } from "./execution.mjs";
import { executeAgent } from "./agents.mjs";
import { AGENT_DEFINITIONS, MANIFEST_HASH, hostedCapabilityMatches, validateAgentRequest } from "../agents/catalog.mjs";
import { createGithubStateStore } from "./github-state-store.mjs";
import { maintenanceAction, runMaintenance } from "./maintenance.mjs";
import {
  HttpError, assertPublicUrl, createWorkLimiter, fetchPublicUrl, fetchWithTimeout,
  parseId, parseObject, privateIp, publicUrl, readBody, readTextLimited,
} from "./http-safety.mjs";
import {
  createClient,
  encodeInternalMessageFeeParams,
  isSuccessful,
  MessageType,
} from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { TransactionHashVariant } from "genlayer-js/types";
import { PrivyClient } from "@privy-io/node";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";

const PORT = Number(process.env.PORT || 8787);
const MONITOR_SECRET = process.env.MONITOR_SECRET || "";
const EVIDENCE_ROOT = resolve(process.env.EVIDENCE_DIR || "evidence");
const RESULT_ROOT = resolve(process.env.RESULT_DIR || "results");
const RESULT_ENCRYPTION_KEY = process.env.RESULT_ENCRYPTION_KEY || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const FRONTEND_ORIGIN = (process.env.FRONTEND_ORIGIN || "").replace(/\/+$/, "");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || "dotmantissa/recourse";
const GITHUB_EVIDENCE_BRANCH = process.env.GITHUB_EVIDENCE_BRANCH || "evidence";
const REQUEST_PRICE_WEI = process.env.REQUEST_PRICE_WEI || "2000000000000000000";
const AGENT_SIGNING_KEY = process.env.AGENT_SIGNING_KEY || "";
const CONTRACT_ADDRESS =
  process.env.RECOURSE_CONTRACT_ADDRESS ||
  "0x51eDCf8f3Bdbb69a6e83b1cA5076a77C2E5Cdc35";
const CHAIN_ID = 61997;
const STORAGE_SCOPE = deploymentScope(CHAIN_ID, CONTRACT_ADDRESS);
const EVIDENCE_DIR = resolve(EVIDENCE_ROOT, STORAGE_SCOPE);
const RESULT_DIR = resolve(RESULT_ROOT, STORAGE_SCOPE);
const RPC_URL = process.env.STUDIO_DEV_RPC?.trim() || "https://studio-dev.genlayer.com/api";
const EXPLORER_URL = "https://explorer-studio-dev.genlayer.com/";
const PRIVY_APP_ID = process.env.PRIVY_APP_ID || "";
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || "";
const ALLOWED_STATUSES = new Set(["success", "timeout", "malformed"]);

const agentAccount = /^0x[0-9a-fA-F]{64}$/.test(AGENT_SIGNING_KEY)
  ? privateKeyToAccount(AGENT_SIGNING_KEY)
  : null;
let chainClient = null;
let privyClient = null;
let githubWriteQueue = Promise.resolve();
let chainWriteQueue = Promise.resolve();
const jobExecutionLocks = new Map();
const limitExecution = createWorkLimiter(8);
const limitRequests = createWorkLimiter(64);
const requestRates = new Map();
const chainJson = JSONbig({ storeAsString: true, strict: true });

function requestAllowed(request) {
  const now = Date.now();
  for (const [key, entry] of requestRates) if (entry.expires <= now) requestRates.delete(key);
  const key = request.socket.remoteAddress || "unknown";
  if (!requestRates.has(key) && requestRates.size >= 10000) return false;
  const entry = requestRates.get(key) || { expires: now + 60000, count: 0 };
  entry.count += 1;
  requestRates.set(key, entry);
  return entry.count <= 240;
}

function corsHeaders(request, isPublic = false) {
  const origin = request.headers.origin || "";
  const allowedOrigin =
    isPublic || !FRONTEND_ORIGIN || origin === FRONTEND_ORIGIN
      ? isPublic
        ? "*"
        : origin || FRONTEND_ORIGIN || "*"
      : "";
  return allowedOrigin
    ? {
        "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Headers": "authorization, content-type, x-payment, x-recourse-job-id, x-recourse-request-hash, x-recourse-request-label, x-recourse-capability-id, x-recourse-request-nonce, x-recourse-wallet, x-recourse-signature, x-recourse-expires-at",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      ...(isPublic ? { "Access-Control-Expose-Headers": "PAYMENT-REQUIRED" } : {}),
      Vary: "Origin",
    }
    : {};
}

function json(response, status, body, headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...([408, 413].includes(status) ? { Connection: "close" } : {}),
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashRequest(capabilityId, requestLabel, request, nonce) {
  const canonical = requestCommitment({ chainId: CHAIN_ID, contractAddress: CONTRACT_ADDRESS, capabilityId: String(capabilityId), requestLabel, request, nonce });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function resultPath(jobId) {
  parseId(jobId);
  return resolve(RESULT_DIR, `${jobId}.json`);
}

function encryptionKey() {
  if (/^[a-fA-F0-9]{64}$/.test(RESULT_ENCRYPTION_KEY)) {
    return Buffer.from(RESULT_ENCRYPTION_KEY, "hex");
  }
  try {
    const decoded = Buffer.from(RESULT_ENCRYPTION_KEY, "base64");
    if (decoded.length === 32) return decoded;
  } catch {}
  throw new Error("RESULT_ENCRYPTION_KEY must be a 32-byte hex or base64 secret");
}

function encryptResult(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(STORAGE_SCOPE));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return {
    version: 2,
    scope: STORAGE_SCOPE,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptResult(packet) {
  if (packet?.version !== 2 || packet?.scope !== STORAGE_SCOPE || packet?.algorithm !== "aes-256-gcm") {
    throw new Error("stored result format is invalid");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(String(packet.iv), "base64"),
  );
  decipher.setAAD(Buffer.from(STORAGE_SCOPE));
  decipher.setAuthTag(Buffer.from(String(packet.tag), "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(String(packet.ciphertext), "base64")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext);
}

function packetPath(jobId) {
  parseId(jobId);
  return resolve(EVIDENCE_DIR, `${jobId}.json`);
}

function requestBaseUrl(request) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const protocol = request.headers["x-forwarded-proto"] || "http";
  const host = request.headers["x-forwarded-host"] || request.headers.host || "localhost";
  return `${protocol}://${host}`;
}

function authorized(request) {
  if (!MONITOR_SECRET) return false;
  const supplied = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const expected = Buffer.from(MONITOR_SECRET);
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function getPrivyClient() {
  if (!PRIVY_APP_ID || !PRIVY_APP_SECRET) {
    throw new Error("Privy server authentication is not configured");
  }
  privyClient ??= new PrivyClient({
    appId: PRIVY_APP_ID,
    appSecret: PRIVY_APP_SECRET,
  });
  return privyClient;
}

async function authenticate(request) {
  const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new Error("Privy access token is required");
  return getPrivyClient().utils().auth().verifyAccessToken(token);
}

function parseInteger(value, field, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${field} must be an integer of at least ${minimum}`);
  }
  return parsed;
}

function assertString(value, field, minimum, maximum) {
  const text = String(value ?? "").trim();
  if (text.length < minimum || text.length > maximum) {
    throw new Error(`${field} must be ${minimum}-${maximum} characters`);
  }
  return text;
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}


async function signedAgentReceipt(slug, payload, output, startedAt, provider) {
  const outputText = canonicalJson(output);
  if (Buffer.byteLength(outputText) > 65536) throw new Error("output exceeds the committed evidence size limit");
  const outputHash = `sha256:${createHash("sha256").update(outputText).digest("hex")}`;
  const requestHash = String(payload.request_hash);
  const schemaValid = payload.schema_valid === true;
  const receipt = {
    version: "recourse-receipt-v2",
    chain_id: CHAIN_ID,
    contract_address: CONTRACT_ADDRESS.toLowerCase(),
    capability_id: String(payload.capability_id),
    job_id: String(payload.job_id),
    request_hash: requestHash,
    output_hash: outputHash,
    response_status: schemaValid ? "success" : "malformed",
    response_code: 200,
    latency_ms: Math.max(0, Date.now() - startedAt),
    schema_valid: schemaValid,
    completed_at: new Date().toISOString(),
    provider,
  };
  const receiptHash = createHash("sha256").update(canonicalJson(receipt)).digest("hex");
  return {
    output,
    receipt,
    receipt_hash: receiptHash,
    receipt_signature: agentAccount
      ? await agentAccount.signMessage({ message: { raw: `0x${receiptHash}` } })
      : "",
  };
}

function outputMatchesSchema(output, schemaText) {
  try {
    const schema = JSON.parse(String(schemaText));
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
    return validate(output) === true;
  } catch {
    return false;
  }
}

function parseEvidencePayload(payload) {
  const core = {
    version: "recourse-receipt-v2",
    chain_id: CHAIN_ID,
    contract_address: CONTRACT_ADDRESS.toLowerCase(),
    capability_id: parseId(payload.capability_id, "capability_id"),
    job_id: parseId(payload.job_id),
    request_hash: assertString(payload.request_hash, "request_hash", 1, 128).toLowerCase(),
    output_hash: assertString(payload.output_hash, "output_hash", 1, 128).toLowerCase(),
    response_status: String(payload.response_status || "").trim(),
    response_code: parseInteger(payload.response_code, "response_code"),
    latency_ms: parseInteger(payload.latency_ms, "latency_ms"),
    schema_valid: payload.schema_valid === true,
    completed_at: String(payload.completed_at || "").trim(),
    provider: String(payload.provider || "").trim(),
  };
  packetPath(core.job_id);
  if (!ALLOWED_STATUSES.has(core.response_status)) {
    throw new Error("response_status must be success, timeout, or malformed");
  }
  if (core.response_code > 599) throw new Error("response_code must be at most 599");
  if (core.latency_ms > 86400000) throw new Error("latency_ms must be at most 86400000");
  if (!/^0x[a-fA-F0-9]{40}$/.test(core.provider)) {
    throw new Error("provider must be a 20-byte address");
  }
  if (Number.isNaN(Date.parse(core.completed_at))) {
    throw new Error("completed_at must be an ISO date");
  }
  return core;
}

function evidenceMatchesChain(core, signature, job, receipt) {
  return Boolean(job && receipt)
    && String(job.job_id || "") === core.job_id
    && String(job.request_hash || "").toLowerCase() === core.request_hash
    && String(job.provider || "").toLowerCase() === core.provider.toLowerCase()
    && String(receipt.request_hash || "").toLowerCase() === core.request_hash
    && String(receipt.output_hash || "").toLowerCase() === core.output_hash
    && String(receipt.response_status || "") === core.response_status
    && Number(receipt.response_code) === core.response_code
    && Number(receipt.latency_ms) === core.latency_ms
    && Boolean(receipt.schema_valid) === core.schema_valid
    && String(receipt.completed_at || "") === core.completed_at
    && String(receipt.receipt_signature || "") === signature;
}

function storedResultMatchesJob(result, job, capabilityId, requestLabel) {
  return Boolean(result && job)
    && String(result.job_id || "") === String(job.job_id)
    && String(result.capability_id || "") === String(capabilityId)
    && String(result.request_hash || "").toLowerCase() === String(job.request_hash || "").toLowerCase()
    && String(result.request_label || "") === String(requestLabel)
    && String(result.receipt?.job_id || "") === String(job.job_id)
    && String(result.receipt?.request_hash || "").toLowerCase() === String(job.request_hash || "").toLowerCase()
    && String(result.receipt?.provider || "").toLowerCase() === String(job.provider || "").toLowerCase();
}

async function readPacket(jobId, scope = STORAGE_SCOPE) {
  parseId(jobId);
  if (scope && !/^[1-9][0-9]*-0x[a-f0-9]{40}$/.test(scope)) throw new HttpError(400, "invalid evidence scope");
  try {
    return JSON.parse(await readFile(resolve(EVIDENCE_ROOT, scope, `${jobId}.json`), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return readGithubFile("evidence", jobId, scope);
}

async function readGithubFile(directory, jobId, scope = STORAGE_SCOPE) {
  if (!GITHUB_TOKEN) return null;
  const response = await githubRequest(
    `/repos/${GITHUB_REPOSITORY}/contents/${directory}/${scope ? `${scope}/` : ""}${encodeURIComponent(jobId)}.json?ref=${encodeURIComponent(GITHUB_EVIDENCE_BRANCH)}`,
  );
  return decodeGithubFileResponse(response);
}

async function decodeGithubFileResponse(response) {
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(503, "durable storage is temporarily unavailable");
  }
  const body = JSON.parse(await readTextLimited(response, 2_000_000));
  if (body.encoding !== "base64" || typeof body.content !== "string") throw new Error("durable storage returned an invalid file");
  return parseObject(Buffer.from(body.content.replace(/\n/g, ""), "base64").toString("utf8"));
}

async function githubRequest(path, options = {}) {
  return fetchWithTimeout(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
      ...(options.headers || {}),
    },
  });
}

async function ensureGithubEvidenceBranch() {
  const current = await githubRequest(
    `/repos/${GITHUB_REPOSITORY}/git/ref/heads/${encodeURIComponent(GITHUB_EVIDENCE_BRANCH)}`,
  );
  await current.body?.cancel();
  if (current.ok) return;
  if (current.status !== 404) throw new Error(`GitHub branch lookup returned ${current.status}`);
  const main = await githubRequest(`/repos/${GITHUB_REPOSITORY}/git/ref/heads/main`);
  if (!main.ok) throw new Error(`GitHub main branch lookup returned ${main.status}`);
  const mainBody = JSON.parse(await readTextLimited(main, 100_000));
  const created = await githubRequest(`/repos/${GITHUB_REPOSITORY}/git/refs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ref: `refs/heads/${GITHUB_EVIDENCE_BRANCH}`,
      sha: mainBody.object.sha,
    }),
  });
  await created.body?.cancel();
  if (!created.ok && created.status !== 422) {
    throw new Error(`GitHub evidence branch creation returned ${created.status}`);
  }
}

async function writeGithubPacket(jobId, packet) {
  await writeGithubFile("evidence", jobId, packet, `Publish Recourse evidence ${jobId}`);
}

async function writeGithubFile(directory, jobId, packet, message) {
  if (!GITHUB_TOKEN) return;
  const operation = githubWriteQueue.then(async () => {
    await ensureGithubEvidenceBranch();
    const path = `/repos/${GITHUB_REPOSITORY}/contents/${directory}/${STORAGE_SCOPE}/${encodeURIComponent(jobId)}.json`;
    const existing = await githubRequest(`${path}?ref=${encodeURIComponent(GITHUB_EVIDENCE_BRANCH)}`);
    let sha;
    if (existing.ok) sha = JSON.parse(await readTextLimited(existing, 2_000_000)).sha;
    else {
      await existing.body?.cancel();
      if (existing.status !== 404) throw new Error(`GitHub evidence lookup returned ${existing.status}`);
    }
    const response = await githubRequest(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        content: Buffer.from(`${JSON.stringify(packet, null, 2)}\n`).toString("base64"),
        branch: GITHUB_EVIDENCE_BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`GitHub evidence write returned ${response.status}`);
  });
  githubWriteQueue = operation.then(() => undefined, () => undefined);
  await operation;
}

async function writePacket(jobId, packet) {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeGithubPacket(jobId, packet);
  const target = packetPath(jobId);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(packet, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
}

async function readResult(jobId) {
  try {
    return decryptResult(JSON.parse(await readFile(resultPath(jobId), "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const stored = await readGithubFile("results", jobId);
  return stored ? decryptResult(stored) : null;
}

async function writeResult(jobId, result) {
  const encrypted = encryptResult(result);
  await mkdir(RESULT_DIR, { recursive: true });
  await writeGithubFile("results", jobId, encrypted, `Store Recourse result ${jobId}`);
  const target = resultPath(jobId);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(encrypted, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
}

async function paymentRequirement(capabilityId) {
  let amount = REQUEST_PRICE_WEI;
  if (capabilityId && /^\d{1,20}$/.test(capabilityId)) {
    try {
      const capability = await readChainJson("get_capability", [capabilityId]);
      if (capability?.price_wei !== undefined) amount = String(capability.price_wei);
    } catch {}
  }
  return {
    version: "1",
    scheme: "genlayer-native",
    network: "studio-next",
    chain_id: CHAIN_ID,
    rpc_url: RPC_URL,
    asset: "GEN",
    amount,
    contract_address: CONTRACT_ADDRESS,
    action: "create_job",
    ...(capabilityId ? { capability_id: capabilityId } : {}),
    description: "Fund a Recourse request escrow on GenLayer Studio Next.",
  };
}

function parsePaymentEnvelope(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {}
  try {
    const parsed = JSON.parse(Buffer.from(text, "base64").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function paymentEnvelopeMatches(paymentEnvelope, requirement, job, capability) {
  return String(paymentEnvelope.scheme || "") === requirement.scheme
    && String(paymentEnvelope.network || "") === requirement.network
    && Number(paymentEnvelope.chain_id) === CHAIN_ID
    && String(paymentEnvelope.asset || "") === requirement.asset
    && String(paymentEnvelope.action || "") === requirement.action
    && String(paymentEnvelope.contract_address || "").toLowerCase() === CONTRACT_ADDRESS.toLowerCase()
    && String(paymentEnvelope.job_id || "") === String(job.job_id)
    && String(paymentEnvelope.capability_id || "") === String(job.capability_id)
    && String(paymentEnvelope.amount || "") === String(capability.price_wei);
}

await mkdir(EVIDENCE_DIR, { recursive: true });
await mkdir(RESULT_DIR, { recursive: true });

function getChainClient() {
  if (!agentAccount) throw new Error("agent signing is not configured");
  chainClient ??= createClient({
    chain: studioDevnet,
    endpoint: RPC_URL,
    account: agentAccount,
  });
  return chainClient;
}

async function readChainJson(functionName, args = []) {
  const value = await getChainClient().readContract({
    address: CONTRACT_ADDRESS,
    functionName,
    args,
    jsonSafeReturn: true,
    transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
  });
  if (!value) return null;
  try {
    return parseChainJson(String(value));
  } catch {
    throw new Error(`${functionName} returned invalid JSON`);
  }
}

function parseChainJson(value) {
  return chainJson.parse(value);
}

function transferAllocations(recipients) {
  const feeParams = encodeInternalMessageFeeParams({
    leaderTimeunitsAllocation: 100n,
    validatorTimeunitsAllocation: 200n,
    appealRounds: 0n,
    executionBudgetPerRound: 25000000000000000n,
    rotations: [3n],
    maxPriceGenPerTimeUnit: 2n,
    storageFeeMaxGasPrice: 300000000n,
    receiptFeeMaxGasPrice: 300000000n,
  });
  return [...new Set(recipients.map((recipient) => recipient.toLowerCase()))].map(
    (recipient) => ({
      messageType: MessageType.Internal,
      onAcceptance: false,
      recipient,
      callKey: "0x0000000000000000000000000000000000000000000000000000000000000000",
      budget: 150000000000000000n,
      feeParams,
    }),
  );
}

async function writeChainUnlocked(functionName, args = [], value = 0n, recipients = []) {
  const client = getChainClient();
  const messageAllocations = transferAllocations(recipients);
  const feeOptions = messageAllocations.length > 0
    ? {
        totalMessageFees: 150000000000000000n * BigInt(messageAllocations.length),
        messageAllocations,
      }
    : {};
  let fees;
  try {
    fees = await client.estimateTransactionFeesForWrite({
      address: CONTRACT_ADDRESS,
      functionName,
      args,
      value,
      leaderOnly: false,
      ...feeOptions,
    });
  } catch {
    fees = await client.estimateTransactionFees(feeOptions);
  }
  if (BigInt(fees.feeValue) > BigInt(process.env.WORKER_MAX_TRANSACTION_FEE_WEI || "5000000000000000000")) {
    throw new Error("transaction fee exceeds the worker fee budget");
  }
  const hash = await client.writeContract({
    address: CONTRACT_ADDRESS,
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
  if (!isSuccessful(receipt)) {
    throw new Error(`${functionName} finalized with execution failure`);
  }
  return String(hash);
}

function writeChain(functionName, args = [], value = 0n, recipients = []) {
  const operation = chainWriteQueue.then(() => writeChainUnlocked(functionName, args, value, recipients));
  chainWriteQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

async function matchingJob(slug, jobId, requestHash) {
  const job = await readChainJson("get_job", [jobId]);
  const capability = job
    ? await readChainJson("get_capability", [String(job.capability_id)])
    : null;
  if (!job || !capability) throw new Error("funded job could not be found on Studio Next");
  if (String(job.request_hash).toLowerCase() !== requestHash.toLowerCase()) {
    throw new Error("request hash does not match the funded job");
  }
  if (String(job.provider).toLowerCase() !== String(agentAccount.address).toLowerCase()) {
    throw new Error("this capability is served by a different provider");
  }
  const expectedPath = AGENT_DEFINITIONS[slug].endpoint;
  if (!PUBLIC_BASE_URL || new URL(String(capability.endpoint)).toString() !== new URL(expectedPath, PUBLIC_BASE_URL).toString()) {
    throw new Error("funded job capability endpoint does not match this agent route");
  }
  if (!hostedCapabilityMatches(slug, capability)) throw new Error("funded capability terms or schema do not match this hosted service manifest");
  return { job, capability };
}

async function prepareAgentJob(slug, payload, request) {
  const jobId = parseId(request.headers["x-recourse-job-id"]);
  const requestHash = assertString(request.headers["x-recourse-request-hash"], "x-recourse-request-hash", 1, 128).toLowerCase();
  const requestLabel = assertString(request.headers["x-recourse-request-label"], "x-recourse-request-label", 1, 240);
  const capabilityId = parseId(request.headers["x-recourse-capability-id"], "capability_id");
  const nonce = assertString(request.headers["x-recourse-request-nonce"], "x-recourse-request-nonce", 8, 128);
  const requestPayload = payload.request ?? null;
  validateAgentRequest(slug, requestPayload);
  if (String(payload.capability_id) !== capabilityId || String(payload.request_label).trim() !== requestLabel || String(payload.nonce).trim() !== nonce) {
    throw new Error("request commitment metadata is inconsistent");
  }
  if (hashRequest(capabilityId, requestLabel, requestPayload, nonce) !== requestHash) {
    throw new Error("request payload does not match the funded request hash");
  }
  const { job } = await matchingJob(slug, jobId, requestHash);
  if (String(job.capability_id) !== capabilityId || job.request_label !== requestLabel) throw new Error("request metadata does not match the funded job");
  return { slug, jobId, requestHash, requestLabel, capabilityId, nonce, requestPayload };
}

async function executePreparedJob(input) {
  const { slug, jobId, requestHash, requestLabel, capabilityId, requestPayload } = input;
  let { job, capability } = await matchingJob(slug, jobId, requestHash);
  const existing = await readResult(jobId);
  if (existing && !storedResultMatchesJob(existing, job, capabilityId, requestLabel)) {
    throw new Error("stored result does not match the funded request");
  }
  let result = existing;
  if (result) await verifyDelivery(result, job, capability);
  if (!result) {
    if (job.status === "funded") {
      await writeChain("accept_job", [jobId]);
      job = await readChainJson("get_job", [jobId]);
    }
    if (job.status !== "accepted") {
      throw new Error(`job is ${job.status} and has no recoverable stored result`);
    }
    if (Number(job.deadline_at) * 1000 <= Date.now()) throw new Error("funded job execution deadline has passed");
    const startedAt = Date.now();
    const output = await executeAgent(slug, requestPayload);
    const signed = await signedAgentReceipt(slug, {
      job_id: jobId,
      capability_id: capabilityId,
      request_hash: requestHash,
      schema_valid: outputMatchesSchema(output, capability.output_schema),
    }, output, startedAt, agentAccount.address);
    result = {
      job_id: jobId,
      capability_id: capabilityId,
      request_hash: requestHash,
      request_label: requestLabel,
      request: requestPayload,
      request_json: requestCommitment({ chainId: CHAIN_ID, contractAddress: CONTRACT_ADDRESS, capabilityId,
        requestLabel, request: requestPayload, nonce: input.nonce }),
      output_json: canonicalJson(signed.output),
      output: signed.output,
      receipt: signed.receipt,
      receipt_hash: signed.receipt_hash,
      receipt_signature: signed.receipt_signature,
      stored_at: new Date().toISOString(),
    };
  }
  return result;
}

async function deliverAgentResult(result, input) {
  const { jobId } = input;
  let receiptTxHash = "";
  let evidenceTxHash = "";
  await writeResult(jobId, result);
  const evidencePacket = {
    ...result.receipt,
    receipt_signature: result.receipt_signature,
    receipt_hash: result.receipt_hash,
    request_json: result.request_json,
    output_json: result.output_json,
  };
  const existingEvidence = await readPacket(jobId);
  if (existingEvidence && existingEvidence.receipt_hash !== result.receipt_hash) {
    throw new Error("stored evidence does not match the funded request result");
  }
  if (!existingEvidence) await writePacket(jobId, evidencePacket);

  let latestJob = await readChainJson("get_job", [jobId]);
  if (latestJob?.status === "accepted") {
    receiptTxHash = await writeChain("submit_receipt", [
      jobId,
      result.receipt.request_hash,
      result.receipt.output_hash,
      result.receipt.response_status,
      BigInt(result.receipt.response_code),
      BigInt(result.receipt.latency_ms),
      result.receipt.schema_valid,
      result.receipt.completed_at,
      result.receipt_signature,
    ]);
    latestJob = await readChainJson("get_job", [jobId]);
  }
  if (latestJob?.status === "receipt_submitted" && !latestJob.evidence_id) {
    const evidenceUrl = `${PUBLIC_BASE_URL}/evidence/${STORAGE_SCOPE}/${encodeURIComponent(jobId)}`;
    evidenceTxHash = await writeChain("publish_evidence", [jobId, evidenceUrl]);
    latestJob = await readChainJson("get_job", [jobId]);
  }
  return {
    ...result,
    evidence_url: `${PUBLIC_BASE_URL}/evidence/${STORAGE_SCOPE}/${encodeURIComponent(jobId)}`,
    receipt_tx_hash: receiptTxHash || null,
    evidence_tx_hash: evidenceTxHash || null,
    onchain_job: latestJob,
  };
}

const executionStore = createGithubStateStore({ request: githubRequest, repository: GITHUB_REPOSITORY,
  branch: GITHUB_EVIDENCE_BRANCH, scope: STORAGE_SCOPE, encode: encryptResult, decode: decryptResult });
const durableExecutor = createDurableExecutor({ store: executionStore, execute: executePreparedJob, deliver: deliverAgentResult });
const maintenanceStore = createGithubStateStore({ request: githubRequest, repository: GITHUB_REPOSITORY,
  branch: GITHUB_EVIDENCE_BRANCH, scope: `${STORAGE_SCOPE}/maintenance`, encode: encryptResult, decode: decryptResult });

function scheduleExecution(jobId) {
  if (jobExecutionLocks.has(jobId)) return;
  jobExecutionLocks.set(jobId, true);
  void limitExecution(() => durableExecutor.run(jobId)).catch(() => {
    console.error("Execution checkpoint unavailable; durable recovery will retry");
  }).finally(() => jobExecutionLocks.delete(jobId));
}

async function completeAgentJob(slug, payload, request) {
  if (!GITHUB_TOKEN) throw new HttpError(503, "durable execution storage is not configured");
  const input = await prepareAgentJob(slug, payload, request);
  await ensureGithubEvidenceBranch();
  const record = await durableExecutor.enqueue(input.jobId, input.requestHash, input);
  if (record.phase === "delivered") return record.result;
  if (["indeterminate", "delivery_failed"].includes(record.phase)) throw new HttpError(409, "execution requires onchain recovery; work will not be repeated");
  scheduleExecution(input.jobId);
  return { job_id: input.jobId, request_hash: input.requestHash, execution_status: record.phase };
}

let workerTimer;
let workerCursor = 0;
let workerScanning = false;

async function recoverExecutions() {
  if (workerScanning || !agentAccount || !GITHUB_TOKEN || !PUBLIC_BASE_URL) return;
  workerScanning = true;
  try {
    const page = await readChainJson("get_jobs_page", [BigInt(workerCursor), 50n]);
    workerCursor = Number(page.next_cursor) >= Number(page.total) ? 0 : Number(page.next_cursor);
    for (const job of page.items) {
      if (String(job.provider).toLowerCase() !== agentAccount.address.toLowerCase() || job.status === "settled") continue;
      scheduleExecution(String(job.job_id));
      const action = maintenanceAction(job, Math.floor(Date.now() / 1000));
      if (action) await runMaintenance({ store: maintenanceStore, job, action,
        submit: (method, id, recipients) => writeChain(method, [id], 0n, recipients) });
    }
  } catch {
    console.error("Execution recovery scan unavailable; retrying on the next interval");
  } finally {
    workerScanning = false;
  }
}

async function handleRequest(request, response) {
  const url = new URL(request.url || "/", "http://localhost");
  const publicCors = corsHeaders(request, true);
  const restrictedCors = corsHeaders(request);
  if (!requestAllowed(request)) return json(response, 429, { error: "request rate limit exceeded" }, { ...publicCors, "Retry-After": "60" });

  if (request.method === "OPTIONS") {
    const publicPreflight = url.pathname === "/"
      || url.pathname === "/health"
      || url.pathname === "/agents"
      || url.pathname.startsWith("/agents/")
      || url.pathname.startsWith("/evidence/")
      || url.pathname === "/x402/request";
    response.writeHead(204, publicPreflight ? publicCors : restrictedCors);
    return response.end();
  }

  if (request.method === "GET" && url.pathname === "/") {
    return json(
      response,
      200,
      {
        service: "Recourse evidence and native GEN escrow adapter",
        status: "listening",
        payment_protocol: "recourse-native-gen",
        x402_interoperable: false,
        network: "studio-next",
        chain_id: CHAIN_ID,
        rpc_url: RPC_URL,
        contract_address: CONTRACT_ADDRESS,
        explorer_url: EXPLORER_URL,
        endpoints: {
          health: "GET /health",
          evidence: "GET /evidence/:job_id",
          result: "GET /results/:job_id",
          publish_evidence: "POST /evidence",
          native_escrow_intent: "POST /x402/request (legacy path; not interoperable x402)",
        },
      },
      publicCors,
    );
  }

  if (request.method === "GET" && url.pathname === "/health") {
    try {
      await access(EVIDENCE_DIR, fsConstants.R_OK | fsConstants.W_OK);
      await access(RESULT_DIR, fsConstants.R_OK | fsConstants.W_OK);
      encryptionKey();
      if (!agentAccount || !PUBLIC_BASE_URL || !GITHUB_TOKEN || !MONITOR_SECRET || !PRIVY_APP_ID || !PRIVY_APP_SECRET) throw new Error("required runtime configuration is missing");
      publicUrl(PUBLIC_BASE_URL, "PUBLIC_BASE_URL");
      return json(
        response,
        200,
        {
          ok: true,
          service: "recourse-adapter",
          network: "studio-next",
          chain_id: CHAIN_ID,
          storage: "ready",
          protocol_version: 2,
          contract_address: CONTRACT_ADDRESS,
          manifest_hash: MANIFEST_HASH,
          readiness: "configuration_only",
          rpc_url: RPC_URL,
          durable_evidence: Boolean(GITHUB_TOKEN),
          durable_results: Boolean(GITHUB_TOKEN && RESULT_ENCRYPTION_KEY),
          privy_configured: Boolean(process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET),
          result_encryption_configured: Boolean(RESULT_ENCRYPTION_KEY),
        },
        publicCors,
      );
    } catch {
      return json(response, 503, { ok: false, status: "not_ready" }, publicCors);
    }
  }

  if (request.method === "GET" && url.pathname === "/agents") {
    return json(
      response,
      200,
      {
        network: "studio-next",
        chain_id: CHAIN_ID,
        provider: agentAccount?.address || null,
        manifest_hash: MANIFEST_HASH,
        protocol_version: 2,
        contract_address: CONTRACT_ADDRESS,
        rpc_url: RPC_URL,
        agents: Object.entries(AGENT_DEFINITIONS).map(([slug, definition]) => ({
          slug,
          ...definition,
          execute_url: `${requestBaseUrl(request)}${definition.endpoint}`,
          provider: agentAccount?.address || null,
        })),
      },
      publicCors,
    );
  }

  if (request.method === "GET" && url.pathname.startsWith("/agents/")) {
    const slug = decodeSegment(url.pathname.slice("/agents/".length));
    const definition = Object.hasOwn(AGENT_DEFINITIONS, slug) ? AGENT_DEFINITIONS[slug] : null;
    return definition
      ? json(
          response,
          200,
          {
            slug,
            ...definition,
            execute_url: `${requestBaseUrl(request)}${definition.endpoint}`,
            provider: agentAccount?.address || null,
          },
          publicCors,
        )
      : json(response, 404, { error: "agent capability not found" }, publicCors);
  }

  if (request.method === "POST" && url.pathname.startsWith("/agents/") && url.pathname.endsWith("/execute")) {
    const slug = decodeSegment(url.pathname.slice("/agents/".length, -"/execute".length));
    if (!Object.hasOwn(AGENT_DEFINITIONS, slug)) {
      return json(response, 404, { error: "agent capability not found" }, publicCors);
    }
    if (!agentAccount) {
      return json(response, 503, { error: "agent signing is not configured" }, publicCors);
    }
    try {
      const payload = parseObject(await readBody(request));
      const result = await completeAgentJob(slug, payload, request);
      return json(response, result.execution_status ? 202 : 200, {
        agent: slug,
        network: "studio-next",
        chain_id: CHAIN_ID,
        ...result,
      }, publicCors);
    } catch (error) {
      return json(
        response,
        error instanceof HttpError ? error.status : /request|job|commitment|capability|configured/i.test(error?.message || "") ? 422 : 502,
        { error: error instanceof Error ? error.message : "agent execution failed" },
        publicCors,
      );
    }
  }

  if (request.method === "GET" && url.pathname.startsWith("/results/")) {
    const jobId = decodeSegment(url.pathname.slice("/results/".length));
    try {
      parseId(jobId);
      const claims = await authenticate(request);
      const job = await readChainJson("get_job", [jobId]);
      if (!job) return json(response, 404, { error: "job not found" }, restrictedCors);
      const wallet = String(request.headers["x-recourse-wallet"] || "").trim();
      const signature = String(request.headers["x-recourse-signature"] || "").trim();
      const expiresAt = Number(request.headers["x-recourse-expires-at"]);
      validateAccessExpiry(expiresAt);
      if (!/^0x[a-fA-F0-9]{40}$/.test(wallet) || wallet.toLowerCase() !== String(job.buyer).toLowerCase()) {
        return json(response, 403, { error: "result belongs to a different buyer" }, restrictedCors);
      }
      if (!signature) {
        return json(response, 401, { error: "wallet authorization is required" }, restrictedCors);
      }
      const verified = await verifyMessage({
        address: wallet,
        message: resultAccessMessage({ chainId: CHAIN_ID, contractAddress: CONTRACT_ADDRESS, jobId: job.job_id,
          requestHash: job.request_hash, wallet, audience: PUBLIC_BASE_URL, expiresAt }),
        signature,
      });
      if (!verified) return json(response, 403, { error: "wallet authorization is invalid" }, restrictedCors);
      const result = await readResult(jobId);
      if (!result) return json(response, 404, { error: "result is not available yet", user_id: claims.user_id }, restrictedCors);
      if (String(result.request_hash).toLowerCase() !== String(job.request_hash).toLowerCase()) {
        return json(response, 409, { error: "stored result does not match the funded request" }, restrictedCors);
      }
      return json(response, 200, result, restrictedCors);
    } catch (error) {
      return json(
        response,
        /Privy|token|authentication/i.test(error?.message || "") ? 401 : 400,
        { error: error instanceof Error ? error.message : "result access failed" },
        restrictedCors,
      );
    }
  }

  if (request.method === "GET" && url.pathname.startsWith("/evidence/")) {
    const segments = url.pathname.slice("/evidence/".length).split("/");
    const scope = segments.length === 1 ? "" : decodeSegment(segments[0]);
    const jobId = decodeSegment(segments.at(-1));
    try {
      if (segments.length > 2) throw new HttpError(400, "invalid evidence path");
      const packet = await readPacket(jobId, scope);
      return packet
        ? json(response, 200, packet, publicCors)
        : json(response, 404, { error: "evidence not found" }, publicCors);
    } catch (error) {
      return json(
        response,
        400,
        { error: error instanceof Error ? error.message : "invalid evidence id" },
        publicCors,
      );
    }
  }

  if (request.method === "POST" && url.pathname === "/evidence") {
    if (!authorized(request)) {
      return json(response, 401, { error: "monitor authorization required" }, restrictedCors);
    }
    try {
      const payload = parseObject(await readBody(request));
      const core = parseEvidencePayload(payload);
      const receiptHash = createHash("sha256").update(canonicalJson(core)).digest("hex");
      const signature = String(payload.receipt_signature || "");
      const signatureValid = await verifyMessage({
        address: core.provider,
        message: { raw: `0x${receiptHash}` },
        signature,
      });
      if (!signatureValid) {
        return json(response, 422, { error: "receipt signature is invalid" }, restrictedCors);
      }
      let job;
      let receipt;
      try {
        [job, receipt] = await Promise.all([
          readChainJson("get_job", [core.job_id]),
          readChainJson("get_receipt", [core.job_id]),
        ]);
      } catch (error) {
        return json(response, 503, {
          error: error instanceof Error ? error.message : "Studio Next evidence verification is unavailable",
        }, restrictedCors);
      }
      if (!evidenceMatchesChain(core, signature, job, receipt)) {
        return json(response, 422, {
          error: "evidence does not match the onchain job and signed receipt",
        }, restrictedCors);
      }
      const packet = {
        ...core,
        receipt_signature: signature,
        receipt_hash: receiptHash,
        request_json: assertString(payload.request_json, "request_json", 1, 65536),
        output_json: assertString(payload.output_json, "output_json", 1, 65536),
      };
      await verifyEvidencePacket(packet, job);
      const existing = await readPacket(core.job_id);
      if (existing && existing.receipt_hash !== receiptHash) {
        return json(
          response,
          409,
          { error: "evidence already exists for this job with a different receipt" },
          restrictedCors,
        );
      }
      if (!existing) await writePacket(core.job_id, packet);
      const evidenceUrl = `${requestBaseUrl(request)}/evidence/${STORAGE_SCOPE}/${encodeURIComponent(core.job_id)}`;
      return json(
        response,
        existing ? 200 : 201,
        { evidence_url: evidenceUrl, receipt_hash: receiptHash },
        restrictedCors,
      );
    } catch (error) {
      return json(
        response,
        error instanceof HttpError ? error.status : 400,
        { error: error instanceof Error ? error.message : "invalid JSON" },
        restrictedCors,
      );
    }
  }

  if (request.method === "POST" && url.pathname === "/x402/request") {
    let body = {};
    try {
      const raw = await readBody(request);
      if (raw.trim()) body = parseObject(raw);
    } catch (error) {
      return json(response, error instanceof HttpError ? error.status : 400, { error: error.message || "invalid request body" }, publicCors);
    }
    const capabilityId = request.headers["x-recourse-capability-id"] ?? body.capability_id ?? "";
    if (capabilityId !== "") parseId(capabilityId, "capability_id");
    const requirement = await paymentRequirement(capabilityId);
    if (!request.headers["x-payment"]) {
      const encoded = Buffer.from(JSON.stringify(requirement)).toString("base64");
      return json(
        response,
        402,
        { error: "payment required", accepts: [requirement] },
        { ...publicCors, "PAYMENT-REQUIRED": encoded },
      );
    }
    const jobId = String(request.headers["x-recourse-job-id"] || "").trim();
    if (!jobId) {
      return json(response, 422, {
        error: "native Studio Next payment verification requires x-recourse-job-id",
        accepts: [requirement],
      }, publicCors);
    }
    parseId(jobId);
    const paymentEnvelope = parsePaymentEnvelope(request.headers["x-payment"]);
    if (!paymentEnvelope) {
      return json(response, 422, {
        error: "x-payment must be a JSON or base64 JSON native-GEN payment envelope",
        accepts: [requirement],
      }, publicCors);
    }
    let job;
    let capability;
    try {
      job = await readChainJson("get_job", [jobId]);
      capability = job ? await readChainJson("get_capability", [String(job.capability_id)]) : null;
    } catch (error) {
      return json(response, 503, {
        error: error instanceof Error ? error.message : "Studio Next escrow verification is unavailable",
      }, publicCors);
    }
    if (!job || !capability || job.status !== "funded") {
      return json(response, 422, { error: "no currently funded native GEN escrow was found for this payment intent" }, publicCors);
    }
    if (String(job.escrow_wei) !== String(capability.price_wei)) {
      return json(response, 422, { error: "no matching native GEN escrow was found for this payment intent" }, publicCors);
    }
    if (capabilityId && String(job.capability_id) !== capabilityId) {
      return json(response, 422, { error: "payment intent capability does not match the funded job" }, publicCors);
    }
    if (!paymentEnvelopeMatches(paymentEnvelope, requirement, job, capability)) {
      return json(response, 422, {
        error: "x-payment does not match the funded native-GEN job and payment requirement",
        accepts: [requirement],
      }, publicCors);
    }
    return json(
      response,
      202,
      {
        status: "payment_intent_verified",
        network: "studio-next",
        chain_id: CHAIN_ID,
        job_id: jobId,
        verification: "native_gen_escrow",
        next: "provider_execution",
      },
      publicCors,
    );
  }

  return json(response, 404, { error: "not found" }, publicCors);
}

const server = createServer((request, response) => {
  limitRequests(() => handleRequest(request, response)).catch((error) => {
    if (!response.headersSent) json(response, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : "request could not be completed" }, corsHeaders(request, true));
    else response.end();
  });
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  workerTimer = setInterval(() => void recoverExecutions(), 30_000);
  workerTimer.unref();
  void recoverExecutions();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Recourse adapter listening on 0.0.0.0:${PORT}`);
  });
}

function shutdown(signal) {
  clearInterval(workerTimer);
  console.log(`${signal} received; closing Recourse adapter`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export {
  server,
  fetchWithTimeout,
  fetchPublicUrl,
  parseObject,
  parseChainJson,
  decodeGithubFileResponse,
  encryptResult,
  decryptResult,
  assertPublicUrl,
  evidenceMatchesChain,
  hashRequest,
  outputMatchesSchema,
  parsePaymentEnvelope,
  paymentEnvelopeMatches,
  privateIp,
  readTextLimited,
  storedResultMatchesJob,
};
