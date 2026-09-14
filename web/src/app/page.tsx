"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import {
  ArrowDownRight,
  ArrowUpRight,
  BadgeCheck,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  ExternalLink,
  FileCheck2,
  Gavel,
  KeyRound,
  Layers3,
  Link2,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Orbit,
  Plus,
  RefreshCw,
  ScanLine,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  WalletCards,
  X,
} from "lucide-react";
import {
  ADAPTER_URL,
  CHAIN_ID,
  CONTRACT_ADDRESS,
  EXPLORER_URL,
  formatDate,
  formatGen,
  MONITOR_ADDRESS,
  parseGen,
  shortAddress,
} from "@/lib/config";
import {
  loadState,
  clearReadCache,
  executeFundedCapability,
  fetchJobResult,
  fundStudioAccount,
  hashRequest,
  readBalance,
  readJob,
  readJobs,
  readReputation,
  signReceipt,
  write,
  type AppState,
  type WalletProvider,
} from "@/lib/genlayer";
import type { Capability, CapabilityRequest, Job, JobResult, Reputation } from "@/lib/types";

type View = "console" | "guide" | "dashboard";
type Lens = "all" | "buyer" | "provider" | "disputes";
type Modal = "register" | "job" | "receipt" | "evidence" | "dispute" | "logout" | "none";

const emptyState: AppState = {
  capabilities: [],
  jobs: [],
  receipts: {},
  evidence: [],
  disputes: [],
};

function bps(value: number) {
  return `${(value / 100).toFixed(value % 100 === 0 ? 0 : 2)}%`;
}

function asWei(value: number | string | bigint) {
  return typeof value === "bigint" ? value : BigInt(value);
}

function statusTone(status: string) {
  if (["settled", "active", "resolved", "success"].includes(status)) return "good";
  if (["disputed", "paused", "timeout", "malformed", "open"].includes(status)) return "warn";
  return "neutral";
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ");
}

function requestStorageKey(jobId: string) {
  return `recourse:request:${jobId}`;
}

function pendingRequestStorageKey(requestHash: string) {
  return `recourse:pending:${requestHash}`;
}

function saveRequestContext(jobId: string, request: CapabilityRequest | null, nonce: string) {
  window.localStorage.setItem(requestStorageKey(jobId), JSON.stringify({ request, nonce }));
}

function savePendingRequest(
  requestHash: string,
  value: {
    buyer: string;
    capabilityId: string;
    requestLabel: string;
    request: CapabilityRequest | null;
    nonce: string;
  },
) {
  window.localStorage.setItem(
    pendingRequestStorageKey(requestHash),
    JSON.stringify({ ...value, createdAt: Date.now() }),
  );
}

function clearPendingRequest(requestHash: string) {
  window.localStorage.removeItem(pendingRequestStorageKey(requestHash));
}

function recoverPendingRequestContexts(jobs: Job[]) {
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key?.startsWith("recourse:pending:")) continue;
    try {
      const pending = JSON.parse(window.localStorage.getItem(key) || "null");
      if (Date.now() - Number(pending?.createdAt || 0) > 86_400_000) {
        window.localStorage.removeItem(key);
        index -= 1;
        continue;
      }
      const job = jobs.find((item) =>
        item.request_hash.toLowerCase() === key.slice("recourse:pending:".length).toLowerCase()
        && item.buyer.toLowerCase() === String(pending?.buyer || "").toLowerCase(),
      );
      if (!job || typeof pending?.nonce !== "string") continue;
      saveRequestContext(job.job_id, pending.request ?? null, pending.nonce);
      clearPendingRequest(job.request_hash);
      index -= 1;
    } catch {}
  }
}

function loadRequestContext(jobId: string): { request: CapabilityRequest | null; nonce: string } | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(requestStorageKey(jobId)) || "null");
    return value && typeof value.nonce === "string" ? value : null;
  } catch {
    return null;
  }
}

function capabilitySlug(capability: Capability) {
  return capability.endpoint.split("/agents/")[1]?.split("/")[0] ?? "";
}

function requestPayload(capability: Capability, form: typeof defaultJobForm): CapabilityRequest | null {
  const slug = capabilitySlug(capability);
  if (slug === "research-sources") return { query: form.query.trim() };
  if (slug === "citation-validator") {
    return {
      claim: form.claim.trim(),
      sources: form.sources.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean),
    };
  }
  if (slug === "json-repair") {
    let document: unknown = form.document;
    try {
      document = JSON.parse(form.document);
    } catch {}
    return {
      document,
      required_keys: form.requiredKeys.split(",").map((item) => item.trim()).filter(Boolean),
    };
  }
  if (slug === "code-policy") return { language: form.language, code: form.code };
  if (slug === "page-brief") return { url: form.url.trim() };
  try {
    return JSON.parse(form.raw || "{}") as CapabilityRequest;
  } catch {
    throw new Error("Advanced request JSON must be valid JSON.");
  }
}

const defaultJobForm = {
  label: "Return five verified sources in JSON",
  query: "How can autonomous agents verify external sources?",
  claim: "The cited sources support the supplied claim.",
  sources: "https://genlayer.com\nhttps://docs.genlayer.com",
  document: '{"title":"Recourse","url":"https://recourse-gamma.vercel.app"}',
  requiredKeys: "title,url,citation",
  language: "javascript",
  code: "export function safe(value) { return value; }",
  url: "https://docs.genlayer.com/",
  raw: "{}",
};

function ModalShell({
  title,
  eyebrow,
  onClose,
  children,
}: {
  title: string;
  eyebrow: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const selector = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]';
    dialog?.querySelector<HTMLElement>(selector)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key !== "Tab") return;
      const targets = Array.from(dialog?.querySelectorAll<HTMLElement>(selector) ?? []);
      const first = targets[0];
      const last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop">
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-head">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button className="icon-button" aria-label="Close dialog" title="Close dialog" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  name,
  value,
  onChange,
  placeholder,
  type = "text",
  required = true,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input name={name} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} type={type} required={required} />
    </label>
  );
}

function SignalField({ active }: { active: boolean }) {
  return (
    <div className={`signal-field ${active ? "is-active" : ""}`} aria-hidden="true">
      <div className="signal-grid" />
      <div className="signal-ring ring-one" />
      <div className="signal-ring ring-two" />
      <div className="signal-ring ring-three" />
      <span className="signal-node node-one" />
      <span className="signal-node node-two" />
      <span className="signal-node node-three" />
      <span className="signal-node node-four" />
      <span className="signal-beam beam-one" />
      <span className="signal-beam beam-two" />
      <div className="signal-caption"><Orbit size={13} /> evidence is moving</div>
    </div>
  );
}

function StatusMark({ status }: { status: string }) {
  return <span className={`status-mark ${statusTone(status)}`}><span />{statusLabel(status)}</span>;
}

function CapabilitySpecimen({
  capability,
  address,
  onBuy,
}: {
  capability: Capability;
  address: string;
  onBuy: (capability: Capability) => void;
}) {
  const available = asWei(capability.collateral_wei) - asWei(capability.reserved_collateral_wei);
  const isOwn = Boolean(address) && capability.provider.toLowerCase() === address.toLowerCase();
  return (
    <article className="specimen">
      <div className="specimen-index">CAP / {capability.capability_id.padStart(2, "0")}</div>
      <div className="specimen-head">
        <div>
          <StatusMark status={capability.status} />
          <h3>{capability.name}</h3>
        </div>
        <strong className="specimen-price">{formatGen(capability.price_wei)}</strong>
      </div>
      <p className="specimen-provider"><span className="provider-dot" /> {shortAddress(capability.provider)} <span>publishes</span> {capability.endpoint}</p>
      <p className="specimen-terms">{capability.terms}</p>
      <details className="specimen-schema">
        <summary>Required output schema</summary>
        <pre><code>{capability.output_schema}</code></pre>
      </details>
      <div className="specimen-data">
        <div><span>response window</span><strong>{capability.deadline_seconds}s</strong></div>
        <div><span>timeout recourse</span><strong>{bps(capability.timeout_refund_bps)}</strong></div>
        <div><span>bad schema</span><strong>{bps(capability.malformed_refund_bps)}</strong></div>
        <div><span>collateral free</span><strong>{formatGen(available)}</strong></div>
      </div>
      <div className="specimen-foot">
        <span className="mono">schema-bound request</span>
        {isOwn ? (
          <span className="ownership"><BadgeCheck size={14} /> yours</span>
        ) : (
          <button className="button button-acid" disabled={capability.status !== "active"} onClick={() => onBuy(capability)}>
            Fund a request <ArrowUpRight size={15} />
          </button>
        )}
      </div>
    </article>
  );
}

function JobLedgerRow({
  job,
  capability,
  address,
  monitorAddress,
  now,
  onAction,
}: {
  job: Job;
  capability?: Capability;
  address: string;
  monitorAddress: string;
  now: number;
  onAction: (action: string, job: Job) => void;
}) {
  const isBuyer = job.buyer.toLowerCase() === address.toLowerCase();
  const isProvider = job.provider.toLowerCase() === address.toLowerCase();
  const isMonitor = Boolean(monitorAddress) && monitorAddress.toLowerCase() === address.toLowerCase();
  const settlementAt = isBuyer
    ? Number(job.deadline_at)
    : Math.max(Number(job.deadline_at), Number(job.challenge_deadline_at || 0));
  const settlementReady = settlementAt * 1000 <= now;
  const timeoutReady = settlementReady;
  const hasEvidence = Boolean(job.evidence_id);
  return (
    <article className="ledger-row">
      <div className="ledger-number">0{job.job_id}</div>
      <div className="ledger-main">
        <div className="ledger-label"><span className="mono">request / {job.request_hash.slice(0, 15)}</span><StatusMark status={job.status} /></div>
        <h3>{job.request_label}</h3>
        <p>{capability?.name ?? `Capability ${job.capability_id}`} · {formatGen(job.escrow_wei)} protected</p>
      </div>
      <div className="ledger-date"><span>deadline</span><strong>{formatDate(job.deadline_at)}</strong></div>
      <div className="ledger-actions">
        {isProvider && job.status === "funded" && <button className="icon-button" title="Submit provider receipt" aria-label="Submit provider receipt" onClick={() => onAction("receipt", job)}><FileCheck2 size={16} /></button>}
        {isMonitor && job.status === "receipt_submitted" && <button className="icon-button" title="Publish evidence packet" aria-label="Publish evidence packet" onClick={() => onAction("evidence", job)}><ScanLine size={16} /></button>}
        {isBuyer && job.status === "funded" && <button className="button button-line small" disabled={!timeoutReady} title={timeoutReady ? "Claim the configured timeout refund" : `Available after ${formatDate(job.deadline_at)}`} onClick={() => onAction("timeout", job)}><Clock3 size={14} /> {timeoutReady ? "Claim timeout" : "Claim after deadline"}</button>}
        {isBuyer && job.status === "receipt_submitted" && <button className="button button-line small" disabled={!hasEvidence} title={hasEvidence ? "Open a quality or terms dispute" : "The public evidence packet must be published first"} onClick={() => onAction("dispute", job)}><Gavel size={14} /> {hasEvidence ? "Dispute" : "Waiting for evidence"}</button>}
        {job.status === "disputed" && <button className="button button-acid small" onClick={() => onAction("resolve", job)}><Gavel size={14} /> Resolve with validators</button>}
        {job.status === "receipt_submitted" && <button className="button button-dark small" disabled={!settlementReady || !hasEvidence} title={!hasEvidence ? "The public evidence packet must be published first" : settlementReady ? "Settle this escrow" : `Available after ${formatDate(settlementAt)}`} onClick={() => onAction("settle", job)}><ShieldCheck size={14} /> {!hasEvidence ? "Waiting for evidence" : settlementReady ? "Settle" : "Settlement pending"}</button>}
        {job.status === "settled" && <span className={`outcome ${statusTone(job.outcome)}`}>{statusLabel(job.outcome)} · {bps(job.refund_bps)} back</span>}
      </div>
    </article>
  );
}

function Guide() {
  return (
    <section className="guide-view">
      <div className="guide-intro">
        <div>
          <span className="eyebrow">Field guide / 01</span>
          <h1>A refund rail for the agent economy.</h1>
        </div>
        <p>Recourse lets an autonomous buyer purchase a single capability with terms that can be checked later. The provider earns when the promise is met. When it is not, the request carries its own way back.</p>
      </div>
      <div className="guide-map">
        <div className="guide-map-line" />
        {[
          ["01", "Set terms", "A provider publishes an endpoint, response schema, deadline, refund rules, and collateral."],
          ["02", "Fund work", "A buyer selects a capability and puts the exact request price into native GEN escrow."],
          ["03", "Prove execution", "The provider signs a receipt. A monitor publishes the evidence packet in public."],
          ["04", "Resolve cleanly", "Good work settles. A timeout refunds. A disputed quality claim goes to GenLayer."],
        ].map(([number, title, copy]) => (
          <article className="guide-step" key={number}>
            <span className="guide-number">{number}</span>
            <h2>{title}</h2>
            <p>{copy}</p>
          </article>
        ))}
      </div>
      <div className="guide-columns">
        <div className="guide-block">
          <span className="eyebrow">For buyers / agents</span>
          <h2>Hire a capability without trusting the happy path.</h2>
          <ol>
            <li><strong>Sign in.</strong> Privy creates an embedded Ethereum wallet on Studio Next.</li>
            <li><strong>Read the promise.</strong> Compare price, deadline, output schema, and recourse before funding.</li>
            <li><strong>Send the request.</strong> Create a job with a request hash and fund the exact price.</li>
            <li><strong>Watch the rail.</strong> Inspect the provider receipt and public evidence.</li>
            <li><strong>Choose the outcome.</strong> Settle valid work, claim a timeout, or open a dispute.</li>
          </ol>
        </div>
        <div className="guide-block dark-block">
          <span className="eyebrow">For providers / agents</span>
          <h2>Turn a service promise into a callable capability.</h2>
          <ol>
            <li><strong>Register.</strong> Publish your endpoint, terms, required JSON schema, deadline, and compensation rules.</li>
            <li><strong>Back it.</strong> Deposit collateral that covers the request price.</li>
            <li><strong>Execute.</strong> Return the result and sign the canonical receipt with your wallet.</li>
            <li><strong>Expose evidence.</strong> Give the monitor a public JSON packet that validators can fetch.</li>
            <li><strong>Build trust.</strong> Settlements update your reliability record onchain.</li>
          </ol>
        </div>
      </div>
      <div className="agent-protocol">
        <div className="protocol-heading">
          <span className="eyebrow">Agent integration / x402-compatible</span>
          <h2>A request can begin as HTTP and end as enforceable settlement.</h2>
          <p>The adapter advertises a Studio Next payment requirement. After the buyer funds a job, the provider executes against the declared terms and returns a signed receipt.</p>
        </div>
        <pre><code>{`POST /x402/request

402 Payment Required
{
  "scheme": "genlayer-native",
  "network": "studio-next",
  "chain_id": 61997,
  "asset": "GEN",
  "action": "create_job"
}

// fund the request onchain
// execute the capability
// publish receipt + evidence
// settle or open recourse`}</code></pre>
      </div>
      <div className="agent-runbook">
        <div>
          <span className="eyebrow">How agents use Recourse</span>
          <h2>Buy work in six messages.</h2>
          <p>Agents can use the console for a human-guided run, or call the same contract and adapter surfaces from their own runtime.</p>
        </div>
        <ol>
          <li><strong>Discover.</strong> Read <code>get_capabilities()</code> on the Studio Next contract and choose an active capability whose price, deadline, schema, and refund rules fit the task.</li>
          <li><strong>Commit.</strong> Create the exact structured request and a fresh nonce. Recourse hashes the capability ID, trimmed label, request, nonce, and <code>recourse-request-v2</code> version. The hash is generated for you in the funding form.</li>
          <li><strong>Fund.</strong> Call <code>create_job(capability_id, request_hash, request_label)</code> with the listed GEN price as native value. The funded job and request hash appear in <strong>My escrows</strong>.</li>
          <li><strong>Execute.</strong> POST the request to the capability endpoint with the funded job ID, request hash, label, capability ID, and nonce headers. The adapter rejects mismatched commitments and cannot switch to another capability.</li>
          <li><strong>Collect.</strong> The provider returns a signed receipt and public evidence. The buyer opens <strong>My escrows</strong>, signs a one-time access message, and reveals the authenticated result there.</li>
          <li><strong>Resolve.</strong> Settle after the response deadline when the evidence meets the terms. If the provider times out, claim the configured timeout refund. If quality or terms are disputed, open recourse and GenLayer resolves the semantic claim.</li>
        </ol>
      </div>
      <div className="agent-integration">
        <div>
          <span className="eyebrow">Bring your own agent</span>
          <h2>Your agent can be the buyer.</h2>
          <p>Privy powers the human-facing embedded wallet in this app. A server-side or autonomous buyer should use its own encrypted EOA or managed signer, call the same Studio Next contract, and keep its private key out of the browser. The adapter response contains the result directly; the dashboard reveal route is for authenticated browser retrieval and recovery.</p>
        </div>
        <pre><code>{`// 1. Read capabilities and choose one
const capability = capabilities.find((item) => item.status === "active");

// 2. Commit the exact request before sending it.
// hashRequest is SHA-256 over sorted-key JSON containing these five fields.
const nonce = crypto.randomUUID();
const request = { query: "verifiable credentials" };
const requestHash = await hashRequest(
  capability.capability_id,
  "Agent research request",
  request,
  nonce
); // returns sha256:<hex>

// 3. Sign create_job with capability.price_wei as native GEN
await genlayer.writeContract({
  functionName: "create_job",
  args: [capability.capability_id, requestHash, "Agent research request"],
  value: BigInt(capability.price_wei)
});

// 4. Execute only after the funded job is readable
const response = await fetch(capability.endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-recourse-job-id": job.job_id,
    "x-recourse-request-hash": requestHash,
    "x-recourse-request-label": "Agent research request",
    "x-recourse-capability-id": capability.capability_id,
    "x-recourse-request-nonce": nonce
  },
  body: JSON.stringify({
    capability_id: capability.capability_id,
    request_label: "Agent research request",
    nonce,
    request
  })
});
if (!response.ok) throw new Error(await response.text());
const delivery = await response.json();
// delivery.output, delivery.receipt, delivery.evidence_url, transaction hashes
// A retry with the same job, request, and nonce returns the stored delivery.`}</code></pre>
      </div>
      <div className="guide-footer-callout">
        <div className="stamp"><KeyRound size={18} /> no blind payment</div>
        <p>Recourse is not a marketplace and it is not an uptime dashboard. It is the request-level contract that gives agents a credible reason to transact.</p>
        <button className="button button-acid" onClick={() => document.getElementById("console")?.scrollIntoView({ behavior: "smooth" })}>Open the console <ArrowDownRight size={15} /></button>
      </div>
    </section>
  );
}

function BuyerDashboard({
  authenticated,
  address,
  balance,
  jobs,
  capabilities,
  evidence,
  results,
  resultBusy,
  executeBusy,
  faucetBusy,
  now,
  onConnect,
  onFund,
  onResult,
  onExecute,
  onAction,
}: {
  authenticated: boolean;
  address: string;
  balance: bigint;
  jobs: Job[];
  capabilities: Capability[];
  evidence: AppState["evidence"];
  results: Record<string, JobResult | null>;
  resultBusy: string;
  executeBusy: string;
  faucetBusy: boolean;
  now: number;
  onConnect: () => void;
  onFund: () => void;
  onResult: (job: Job) => void;
  onExecute: (job: Job) => void;
  onAction: (action: string, job: Job) => void;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | Job["status"]>("all");
  const [page, setPage] = useState(0);
  const [hiddenResults, setHiddenResults] = useState<Record<string, boolean>>({});
  const buyerJobs = useMemo(() => jobs
    .filter((job) => job.buyer.toLowerCase() === address.toLowerCase())
    .filter((job) => {
      if (statusFilter !== "all" && job.status !== statusFilter) return false;
      const capability = capabilities.find((item) => item.capability_id === job.capability_id);
      const haystack = `${job.job_id} ${job.request_hash} ${job.request_label} ${capability?.name ?? ""}`.toLowerCase();
      return haystack.includes(query.trim().toLowerCase());
    })
    .sort((a, b) => Number(b.job_id) - Number(a.job_id)), [address, capabilities, jobs, query, statusFilter]);
  const pageCount = Math.max(1, Math.ceil(buyerJobs.length / 2));
  const safePage = Math.min(page, pageCount - 1);
  const visibleBuyerJobs = buyerJobs.slice(safePage * 2, safePage * 2 + 2);
  if (!authenticated || !address) {
    return (
      <section className="dashboard-view">
        <div className="dashboard-empty">
          <span className="eyebrow">Private workspace</span>
          <h1>Your escrows, from funding to result.</h1>
          <p>Sign in with an embedded Studio Next wallet to see only the requests you funded, their receipts, public evidence, and final settlement.</p>
          <button className="button button-acid large" onClick={onConnect}><KeyRound size={16} /> Sign in to open dashboard</button>
        </div>
      </section>
    );
  }
  return (
    <section className="dashboard-view">
      <div className="dashboard-intro">
        <div>
          <span className="eyebrow">Buyer workspace / private</span>
          <h1>Every escrow has a visible next step.</h1>
        </div>
        <p>Results arrive here after the funded capability runs. The request hash is your portable receipt identity; the evidence link is what GenLayer validators inspect.</p>
      </div>
      <div className="dashboard-address"><WalletCards size={15} /><span className="mono dashboard-wallet">{address}</span><strong className="dashboard-balance">{formatGen(balance)}</strong><span className="dashboard-network">Studio Next / {CHAIN_ID}</span><button className="button button-line small" onClick={onFund} disabled={faucetBusy}>{faucetBusy ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />} {faucetBusy ? "Funding" : "Get test GEN"}</button></div>
      <div className="dashboard-filters">
        <label className="search-field"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your request history" aria-label="Search your request history" /></label>
        <div className="status-filters">
          {(["all", "funded", "receipt_submitted", "disputed", "settled"] as const).map((status) => <button key={status} className={statusFilter === status ? "selected" : ""} onClick={() => setStatusFilter(status)}>{status === "all" ? "All" : statusLabel(status)}</button>)}
        </div>
      </div>
      <div className="dashboard-list">
        {visibleBuyerJobs.length ? visibleBuyerJobs.map((job) => {
          const capability = capabilities.find((item) => item.capability_id === job.capability_id);
          const evidenceRecord = evidence.find((item) => item.evidence_id === job.evidence_id);
          const result = results[job.job_id];
          return (
            <article className="dashboard-job" key={job.job_id}>
              <div className="dashboard-job-top">
                <div>
                  <span className="mono dashboard-job-id">JOB {job.job_id} · {job.request_hash}</span>
                  <h2>{job.request_label}</h2>
                  <p>{capability?.name ?? `Capability ${job.capability_id}`} · {formatGen(job.escrow_wei)} protected</p>
                </div>
                <StatusMark status={job.status} />
              </div>
              <div className="dashboard-meta">
                <div><span>funded</span><strong>{formatDate(job.funded_at)}</strong></div>
                <div><span>deadline</span><strong>{formatDate(job.deadline_at)}</strong></div>
                <div><span>outcome</span><strong>{job.outcome ? `${statusLabel(job.outcome)} · ${bps(job.refund_bps)} back` : "awaiting settlement"}</strong></div>
              </div>
              <div className="dashboard-job-footer">
                <div className="dashboard-links">
                  {evidenceRecord && <a className="text-link" href={evidenceRecord.evidence_url} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Public evidence</a>}
                  <button className="text-link" aria-expanded={Boolean(result && !hiddenResults[job.job_id])} aria-controls={`result-${job.job_id}`} onClick={() => result ? setHiddenResults((current) => ({ ...current, [job.job_id]: !current[job.job_id] })) : onResult(job)} disabled={resultBusy === job.job_id}>{resultBusy === job.job_id ? <LoaderCircle className="spin" size={14} /> : <FileCheck2 size={14} />} {result && !hiddenResults[job.job_id] ? "Hide result" : "Reveal result"}</button>
                </div>
                <div className="dashboard-actions">
                  {job.status === "funded" && <button className="button button-acid small" onClick={() => onExecute(job)} disabled={executeBusy === job.job_id}>{executeBusy === job.job_id ? <LoaderCircle className="spin" size={14} /> : <Orbit size={14} />} {executeBusy === job.job_id ? "Running" : "Execute now"}</button>}
                  {job.status === "funded" && <button className="button button-line small" disabled={Number(job.deadline_at) * 1000 > now} title={Number(job.deadline_at) * 1000 > now ? `Available after ${formatDate(job.deadline_at)}` : "Claim the configured timeout refund"} onClick={() => onAction("timeout", job)}><Clock3 size={14} /> {Number(job.deadline_at) * 1000 > now ? "Claim after deadline" : "Claim timeout"}</button>}
                  {job.status === "receipt_submitted" && <button className="button button-line small" disabled={!job.evidence_id} title={job.evidence_id ? "Open a quality or terms dispute" : "The public evidence packet must be published first"} onClick={() => onAction("dispute", job)}><Gavel size={14} /> {job.evidence_id ? "Dispute" : "Waiting for evidence"}</button>}
                  {job.status === "disputed" && <button className="button button-acid small" onClick={() => onAction("resolve", job)}><Gavel size={14} /> Resolve with validators</button>}
                  {job.status === "receipt_submitted" && <button className="button button-dark small" disabled={!job.evidence_id || Number(job.deadline_at) * 1000 > now} title={!job.evidence_id ? "The public evidence packet must be published first" : Number(job.deadline_at) * 1000 > now ? `Available after ${formatDate(job.deadline_at)}` : "Settle this escrow"} onClick={() => onAction("settle", job)}><ShieldCheck size={14} /> {!job.evidence_id ? "Waiting for evidence" : Number(job.deadline_at) * 1000 > now ? "Settle after deadline" : "Settle"}</button>}
                </div>
              </div>
              {result && !hiddenResults[job.job_id] && (
                <div className="result-drawer" id={`result-${job.job_id}`}>
                  <div className="result-drawer-head"><span className="eyebrow">Delivered output</span><span className="mono">{result.receipt.output_hash}</span></div>
                  <pre><code>{JSON.stringify(result.output, null, 2)}</code></pre>
                  <div className="result-receipt"><span><BadgeCheck size={14} /> signed receipt verified by adapter</span><span>{result.receipt.latency_ms}ms · {result.receipt.response_status}</span></div>
                </div>
              )}
            </article>
          );
        }) : (
          <div className="dashboard-empty dashboard-empty-small">
            <LockKeyhole size={24} />
            <h2>No funded requests yet.</h2>
            <p>Choose a capability in the console. Once escrow finalizes, the request will appear here and its result will land in this workspace.</p>
          </div>
        )}
      </div>
      {buyerJobs.length > 2 && <div className="pagination-bar"><span className="mono">showing {safePage * 2 + 1}-{Math.min(safePage * 2 + 2, buyerJobs.length)} of {buyerJobs.length}</span><div><button className="icon-button" disabled={safePage === 0} onClick={() => setPage((current) => Math.max(0, current - 1))} title="Previous escrows" aria-label="Previous escrows"><ChevronLeft size={15} /></button><button className="icon-button" disabled={safePage >= pageCount - 1} onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))} title="Next escrows" aria-label="Next escrows"><ChevronRight size={15} /></button></div></div>}
    </section>
  );
}

function JobRequestFields({
  capability,
  form,
  onChange,
}: {
  capability: Capability;
  form: typeof defaultJobForm;
  onChange: (next: typeof defaultJobForm) => void;
}) {
  const slug = capabilitySlug(capability);
  if (slug === "research-sources") {
    return <Field label="Research question" name="query" value={form.query} onChange={(value) => onChange({ ...form, query: value })} placeholder="What should the source agent investigate?" />;
  }
  if (slug === "citation-validator") {
    return <><Field label="Claim to check" name="claim" value={form.claim} onChange={(value) => onChange({ ...form, claim: value })} /><label className="field"><span>Public source URLs</span><textarea value={form.sources} onChange={(event) => onChange({ ...form, sources: event.target.value })} placeholder="One URL per line" /></label></>;
  }
  if (slug === "json-repair") {
    return <><label className="field"><span>JSON document</span><textarea value={form.document} onChange={(event) => onChange({ ...form, document: event.target.value })} /></label><Field label="Required keys" name="requiredKeys" value={form.requiredKeys} onChange={(value) => onChange({ ...form, requiredKeys: value })} placeholder="title,url,citation" /></>;
  }
  if (slug === "code-policy") {
    return <><label className="field"><span>Language</span><select value={form.language} onChange={(event) => onChange({ ...form, language: event.target.value })}><option value="javascript">JavaScript</option><option value="typescript">TypeScript</option><option value="python">Python</option></select></label><label className="field"><span>Source code</span><textarea value={form.code} onChange={(event) => onChange({ ...form, code: event.target.value })} /></label></>;
  }
  if (slug === "page-brief") {
    return <Field label="Public page URL" name="url" value={form.url} onChange={(value) => onChange({ ...form, url: value })} placeholder="https://..." />;
  }
  return <label className="field"><span>Request JSON</span><textarea value={form.raw} onChange={(event) => onChange({ ...form, raw: event.target.value })} placeholder='{"input":"value"}' /></label>;
}

function PrivyHome() {
  const { ready, authenticated, login, logout, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const [view, setView] = useState<View>("console");
  const [lens, setLens] = useState<Lens>("all");
  const [state, setState] = useState<AppState>(emptyState);
  const [reputation, setReputation] = useState<Reputation | null>(null);
  const [balance, setBalance] = useState(0n);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [modal, setModal] = useState<Modal>("none");
  const [selectedCapability, setSelectedCapability] = useState<Capability | null>(null);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [results, setResults] = useState<Record<string, JobResult | null>>({});
  const [resultBusy, setResultBusy] = useState("");
  const [executeBusy, setExecuteBusy] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [capabilityQuery, setCapabilityQuery] = useState("");
  const [capabilityPage, setCapabilityPage] = useState(0);
  const [registerForm, setRegisterForm] = useState({
    name: "Verified source research",
    endpoint: ADAPTER_URL ? `${ADAPTER_URL}/agents/research-sources/execute` : "",
    terms: "Return five verified sources in JSON. Every item must include title, URL, and citation.",
    deadline: "30",
    schema: '{"type":"object","required":["query","sources"],"properties":{"query":{"type":"string"},"sources":{"type":"array","minItems":5,"maxItems":5}}}',
    timeout: "100",
    malformed: "75",
    price: "2",
    collateral: "10",
  });
  const [jobForm, setJobForm] = useState(defaultJobForm);
  const [receiptForm, setReceiptForm] = useState({ outputHash: "", status: "success", code: "200", latency: "1200", schemaValid: true, completedAt: "" });
  const [evidenceForm, setEvidenceForm] = useState({ url: "" });
  const [disputeForm, setDisputeForm] = useState({ type: "quality", complaint: "The returned sources do not support the requested claims." });

  const embeddedWallet = wallets.find((wallet) => wallet.walletClientType === "privy") ?? wallets[0];
  const address = embeddedWallet?.address ?? "";
  const refreshInFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const operation = (async () => {
      setError("");
      try {
        const next = await loadState();
        recoverPendingRequestContexts(next.jobs);
        setState(next);
        if (address) {
          const [nextReputation, nextBalance] = await Promise.all([
            readReputation(address),
            readBalance(address),
          ]);
          setReputation(nextReputation);
          setBalance(nextBalance);
        } else {
          setReputation(null);
          setBalance(0n);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The Studio Next state could not be loaded.");
      }
    })();
    refreshInFlight.current = operation;
    try {
      await operation;
    } finally {
      if (refreshInFlight.current === operation) refreshInFlight.current = null;
    }
    return operation;
  }, [address]);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const filteredCapabilities = useMemo(() => {
    const normalizedQuery = capabilityQuery.trim().toLowerCase();
    return state.capabilities.filter((capability) => {
      if (!normalizedQuery) return true;
      return `${capability.name} ${capability.terms} ${capability.endpoint} ${capability.output_schema}`.toLowerCase().includes(normalizedQuery);
    });
  }, [capabilityQuery, state.capabilities]);
  const capabilityPageCount = Math.max(1, Math.ceil(filteredCapabilities.length / 2));
  const safeCapabilityPage = Math.min(capabilityPage, capabilityPageCount - 1);
  const visibleCapabilities = filteredCapabilities.slice(safeCapabilityPage * 2, safeCapabilityPage * 2 + 2);

  const visibleJobs = useMemo(() => {
    const mine = state.jobs.filter((item) => !address || item.buyer.toLowerCase() === address.toLowerCase() || item.provider.toLowerCase() === address.toLowerCase());
    if (lens === "buyer") return mine.filter((item) => item.buyer.toLowerCase() === address.toLowerCase());
    if (lens === "provider") return mine.filter((item) => item.provider.toLowerCase() === address.toLowerCase());
    if (lens === "disputes") return mine.filter((item) => item.status === "disputed" || item.dispute_id);
    return mine;
  }, [state.jobs, address, lens]);
  const openDisputes = state.disputes.filter((item) => item.status === "open").length;
  const settledJobs = state.jobs.filter((item) => item.status === "settled").length;

  async function walletContext(): Promise<{ address: string; provider: WalletProvider }> {
    if (!authenticated || !embeddedWallet) throw new Error("Sign in with Privy to create your Studio Next wallet.");
    await embeddedWallet.switchChain(CHAIN_ID);
    const provider = await embeddedWallet.getEthereumProvider();
    return { address: embeddedWallet.address, provider };
  }

  async function action(
    label: string,
    fn: () => Promise<string>,
    refreshAfter = true,
  ): Promise<string | null> {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const hash = await fn();
      setNotice(`Finalized ${hash.slice(0, 12)}...`);
      setModal("none");
      if (refreshAfter) await refresh();
      return hash;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The transaction failed.");
      return null;
    } finally {
      setBusy("");
    }
  }

  async function waitForJobStatus(jobId: string, expectedStatus: Job["status"]) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        clearReadCache();
        const latest = await readJob(jobId);
        if (latest?.status === expectedStatus) return latest;
      } catch {}
      await new Promise((resolve) => window.setTimeout(resolve, 1800));
    }
    return null;
  }

  async function connect() {
    setError("");
    if (!ready) return;
    if (!authenticated) {
      login();
      return;
    }
    try {
      await walletContext();
      setNotice(`Embedded wallet ready on Studio Next / ${CHAIN_ID}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Privy wallet connection failed.");
    }
  }

  async function fundWallet() {
    setBusy("faucet");
    setError("");
    setNotice("");
    try {
      const context = await walletContext();
      await fundStudioAccount(context.address);
      const nextBalance = await readBalance(context.address);
      setBalance(nextBalance);
      setNotice(`Studio Next faucet funded ${shortAddress(context.address)}. Balance: ${formatGen(nextBalance)}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The Studio Next faucet request failed.");
    } finally {
      setBusy("");
    }
  }

  async function register(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await action("register", async () => {
      const context = await walletContext();
      return write(context.address, context.provider, "register_capability", [registerForm.name, registerForm.endpoint, registerForm.terms, BigInt(registerForm.deadline), registerForm.schema, BigInt(registerForm.timeout) * 100n, BigInt(registerForm.malformed) * 100n, parseGen(registerForm.price)], parseGen(registerForm.collateral));
    });
  }

  async function findJob(requestHash: string, buyer: string) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      clearReadCache();
      const jobs = await readJobs();
      const job = jobs.find((item) => item.request_hash.toLowerCase() === requestHash.toLowerCase() && item.buyer.toLowerCase() === buyer.toLowerCase());
      if (job) return job;
      await new Promise((resolve) => window.setTimeout(resolve, 1800));
    }
    throw new Error("The funded job finalized, but its job record was not readable yet. Refresh the dashboard to continue.");
  }

  async function createJob(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCapability) return;
    setBusy("job");
    setError("");
    setNotice("");
    let pendingHash = "";
    try {
      const context = await walletContext();
      const request = requestPayload(selectedCapability, jobForm);
      const nonce = crypto.randomUUID();
      pendingHash = await hashRequest(selectedCapability.capability_id, jobForm.label, request, nonce);
      savePendingRequest(pendingHash, {
        buyer: context.address,
        capabilityId: selectedCapability.capability_id,
        requestLabel: jobForm.label,
        request,
        nonce,
      });
      await write(context.address, context.provider, "create_job", [selectedCapability.capability_id, pendingHash, jobForm.label], asWei(selectedCapability.price_wei));
      setView("dashboard");
      setModal("none");
      setNotice("Escrow funded. Locating the onchain job and starting the capability...");
      const job = await findJob(pendingHash, context.address);
      saveRequestContext(job.job_id, request, nonce);
      clearPendingRequest(pendingHash);
      try {
        const result = await executeFundedCapability(selectedCapability, job, request, nonce);
        setResults((current) => ({ ...current, [job.job_id]: result }));
        setNotice(`Job ${job.job_id} executed. Your result is ready in My escrows.`);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The capability was funded, but execution is still pending.");
        setNotice(`Job ${job.job_id} is funded. Open My escrows to retry execution or claim recourse after the deadline.`);
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The funded request could not be completed.");
    } finally {
      setBusy("");
    }
  }

  async function submitReceipt(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedJob) return;
    await action("receipt", async () => {
    const context = await walletContext();
    const completedAt = receiptForm.completedAt || new Date().toISOString();
    const outputHash = receiptForm.outputHash.trim().toLowerCase();
    const signed = await signReceipt(context.provider, context.address, {
      job_id: selectedJob.job_id,
      request_hash: selectedJob.request_hash,
      output_hash: outputHash,
      response_status: receiptForm.status,
      response_code: Number(receiptForm.code),
      latency_ms: Number(receiptForm.latency),
      schema_valid: receiptForm.schemaValid,
      completed_at: completedAt,
      provider: selectedJob.provider,
    });
    return write(context.address, context.provider, "submit_receipt", [selectedJob.job_id, selectedJob.request_hash, outputHash, receiptForm.status, BigInt(receiptForm.code), BigInt(receiptForm.latency), receiptForm.schemaValid, completedAt, signed.signature]);
    });
  }

  async function publishEvidence(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedJob) return;
    await action("evidence", async () => {
      const context = await walletContext();
      return write(context.address, context.provider, "publish_evidence", [selectedJob.job_id, evidenceForm.url]);
    });
  }

  async function openDispute(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedJob) return;
    await action("dispute", async () => {
      const context = await walletContext();
      return write(context.address, context.provider, "open_dispute", [selectedJob.job_id, disputeForm.type, disputeForm.complaint]);
    });
  }

  async function revealResult(job: Job) {
    if (!authenticated) {
      setModal("none");
      login();
      return;
    }
    setResultBusy(job.job_id);
    setError("");
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Privy did not return an access token.");
      const context = await walletContext();
      const result = await fetchJobResult(job, token, context.provider, context.address);
      setResults((current) => ({ ...current, [job.job_id]: result }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The result could not be retrieved.");
    } finally {
      setResultBusy("");
    }
  }

  async function executeExistingJob(job: Job) {
    const capability = state.capabilities.find((item) => item.capability_id === job.capability_id);
    const context = loadRequestContext(job.job_id);
    if (!capability || !context) {
      setError("This funded request has no local input commitment available. It can still be claimed after its deadline.");
      return;
    }
    setExecuteBusy(job.job_id);
    setError("");
    setNotice("");
    try {
      const result = await executeFundedCapability(capability, job, context.request, context.nonce);
      setResults((current) => ({ ...current, [job.job_id]: result }));
      setNotice(`Job ${job.job_id} executed. The result is ready below.`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The funded request could not be executed.");
    } finally {
      setExecuteBusy("");
    }
  }

  async function runJobAction(actionName: string, job: Job) {
    try {
      if (["receipt", "evidence", "dispute"].includes(actionName)) {
        setSelectedJob(job);
        if (actionName === "evidence" && ADAPTER_URL) {
          setEvidenceForm({ url: `${ADAPTER_URL}/evidence/${job.job_id}` });
        }
        setModal(actionName as Modal);
        return;
      }
      const context = await walletContext();
      if (actionName === "timeout") {
        if (Number(job.deadline_at) * 1000 > Date.now()) {
          setError(`Timeout recourse opens after the response deadline: ${formatDate(job.deadline_at)}.`);
          return;
        }
        await action(`timeout-${job.job_id}`, () => write(context.address, context.provider, "claim_timeout", [job.job_id], 0n, [job.buyer]));
      }
      if (actionName === "settle") {
        if (Number(job.deadline_at) * 1000 > Date.now()) {
          setError(`Settlement opens after the response deadline: ${formatDate(job.deadline_at)}.`);
          return;
        }
        const hash = await action(`settle-${job.job_id}`, () => write(context.address, context.provider, "settle_job", [job.job_id], 0n, [job.buyer, job.provider]), false);
        if (!hash) return;
        const latest = await waitForJobStatus(job.job_id, "settled");
        if (latest) {
          setState((current) => ({ ...current, jobs: current.jobs.map((item) => item.job_id === latest.job_id ? latest : item) }));
          setNotice(`Job ${job.job_id} is settled. The escrow outcome is now recorded onchain.`);
        } else {
          setNotice(`Settlement transaction finalized for Job ${job.job_id}. Studio Next is still indexing the updated escrow state.`);
        }
        await refresh();
      }
      if (actionName === "resolve") {
        if (!job.dispute_id) {
          setError(`Job ${job.job_id} has no dispute record to resolve.`);
          return;
        }
        const hash = await action(`resolve-${job.job_id}`, () => write(context.address, context.provider, "resolve_dispute", [job.dispute_id], 0n, [job.buyer, job.provider]), false);
        if (!hash) return;
        const latest = await waitForJobStatus(job.job_id, "settled");
        if (latest) {
          setState((current) => ({ ...current, jobs: current.jobs.map((item) => item.job_id === latest.job_id ? latest : item) }));
          setNotice(`Dispute for Job ${job.job_id} resolved. The validator-backed outcome is recorded onchain.`);
        } else {
          setNotice(`Dispute resolution finalized for Job ${job.job_id}. Studio Next is still indexing the updated escrow state.`);
        }
        await refresh();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The escrow action could not be completed.");
    }
  }

  return (
    <main className="app-shell">
      <header className="site-nav">
        <button className="wordmark" onClick={() => setView("console")} aria-label="Open Recourse console">
          <span className="wordmark-symbol"><Orbit size={19} /></span>
          <span><strong>recourse</strong><small>a way back for agents</small></span>
        </button>
        <div className="nav-center">
          <button className={view === "console" ? "nav-link selected" : "nav-link"} onClick={() => setView("console")}><Layers3 size={15} /> Console</button>
          <button className={view === "dashboard" ? "nav-link selected" : "nav-link"} onClick={() => setView("dashboard")}><WalletCards size={15} /> My escrows</button>
          <button className={view === "guide" ? "nav-link selected" : "nav-link"} onClick={() => setView("guide")}><BookOpen size={15} /> Field guide</button>
        </div>
        <div className="nav-right">
          <span className="network-chip"><span className="pulse-dot" /> Studio Next <span className="mono">{CHAIN_ID}</span></span>
          {authenticated && address ? (
            <button className="wallet-chip" onClick={() => setModal("logout")} title="Sign out of Privy">
              <WalletCards size={15} /> {shortAddress(address)} <LogOut size={13} />
            </button>
          ) : (
            <button className="wallet-chip wallet-chip-acid" onClick={() => void connect()} disabled={!ready}>
              <KeyRound size={15} /> {ready ? "Create wallet" : "Loading wallet"}
            </button>
          )}
        </div>
      </header>

      {view === "guide" ? <Guide /> : view === "dashboard" ? (
        <BuyerDashboard
          authenticated={authenticated}
          address={address}
          balance={balance}
          jobs={state.jobs}
          capabilities={state.capabilities}
          evidence={state.evidence}
          results={results}
          resultBusy={resultBusy}
          executeBusy={executeBusy}
          faucetBusy={busy === "faucet"}
          onConnect={() => void connect()}
          onFund={() => void fundWallet()}
          onResult={(job) => void revealResult(job)}
          onExecute={(job) => void executeExistingJob(job)}
          onAction={(name, job) => void runJobAction(name, job)}
          now={now}
        />
      ) : (
        <section id="console" className="console-view">
          <div className="console-hero">
            <div className="hero-copy">
              <div className="hero-kicker"><span>01</span> request-level protection / live network</div>
              <h1>Pay an agent.<br /><em>Keep a way back.</em></h1>
              <p>Recourse holds a single request in escrow, checks the signed execution record, and lets GenLayer resolve the chargeback when the service promise breaks.</p>
              <div className="hero-cta-row">
                <button className="button button-acid large" onClick={() => document.getElementById("capabilities")?.scrollIntoView({ behavior: "smooth" })}><Send size={16} /> Hire a capability</button>
                <button className="button button-ghost large" onClick={() => setView("guide")}><BookOpen size={16} /> Learn the protocol</button>
              </div>
              <div className="hero-note"><Sparkles size={14} /> Native GEN escrow · signed receipts · validator-backed recourse</div>
            </div>
            <SignalField active={state.jobs.length > 0} />
            <div className="hero-aside">
              <span className="aside-label">The promise</span>
              <strong>One request.<br />One clear outcome.</strong>
              <div className="aside-rule"><Check size={13} /> money waits before work starts</div>
              <div className="aside-rule"><Check size={13} /> evidence is inspectable</div>
              <div className="aside-rule"><Check size={13} /> broken terms have consequences</div>
              <a href={`${EXPLORER_URL}${CONTRACT_ADDRESS}`} target="_blank" rel="noreferrer" className="text-link">Inspect the contract <ExternalLink size={13} /></a>
            </div>
          </div>

          <div className="pulse-strip">
            <div><span className="strip-label">capabilities in orbit</span><strong>{state.capabilities.length.toString().padStart(2, "0")}</strong></div>
            <div><span className="strip-label">protected requests</span><strong>{state.jobs.length.toString().padStart(2, "0")}</strong></div>
            <div><span className="strip-label">settled cleanly</span><strong>{settledJobs.toString().padStart(2, "0")}</strong></div>
            <div><span className="strip-label">open recourse</span><strong className={openDisputes ? "acid-number" : ""}>{openDisputes.toString().padStart(2, "0")}</strong></div>
            <div className="strip-status"><span className="pulse-dot" /> chain online</div>
          </div>

          {notice && <div className="notice notice-success"><Check size={16} /> {notice}</div>}
          {error && <div className="notice notice-error"><CircleAlert size={16} /> {error}</div>}
          {!CONTRACT_ADDRESS && <div className="notice notice-error"><CircleAlert size={16} /> Studio Next contract address is not configured.</div>}

          <section id="capabilities" className="section-block capability-zone">
            <div className="section-marker"><span>02</span><span>capability market</span><span className="marker-line" /></div>
            <div className="section-heading-wide">
              <div><h2>Services with a<br /><em>defined way back.</em></h2></div>
              <div className="section-heading-copy"><p>Agents do not need another directory. They need a credible boundary around each request.</p><button className="text-link" onClick={() => setView("guide")}>How capabilities work <ChevronRight size={14} /></button></div>
            </div>
            <div className="capability-toolbar">
              <label className="search-field"><Search size={15} /><input value={capabilityQuery} onChange={(event) => setCapabilityQuery(event.target.value)} placeholder="Search capabilities, terms, or schema" aria-label="Search capabilities" /></label>
              {filteredCapabilities.length > 2 && <div className="pagination-bar capability-pagination"><span className="mono">showing {safeCapabilityPage * 2 + 1}-{Math.min(safeCapabilityPage * 2 + 2, filteredCapabilities.length)} of {filteredCapabilities.length}</span><div><button className="icon-button" disabled={safeCapabilityPage === 0} onClick={() => setCapabilityPage((current) => Math.max(0, current - 1))} title="Previous capabilities" aria-label="Previous capabilities"><ChevronLeft size={15} /></button><button className="icon-button" disabled={safeCapabilityPage >= capabilityPageCount - 1} onClick={() => setCapabilityPage((current) => Math.min(capabilityPageCount - 1, current + 1))} title="View more capabilities" aria-label="View more capabilities"><ChevronRight size={15} /></button></div></div>}
            </div>
            <div className="capability-layout">
                <div className="capability-list">
                {visibleCapabilities.length ? visibleCapabilities.map((item) => <CapabilitySpecimen key={item.capability_id} capability={item} address={address} onBuy={(capability) => { setSelectedCapability(capability); setJobForm({ ...defaultJobForm, label: `Run ${capability.name} request` }); setModal("job"); }} />) : (
                  <div className="empty-state"><Orbit size={23} /><h3>The rail is waiting for its first capability.</h3><p>Register an agent service below, then make its promise specific enough to verify.</p></div>
                )}
              </div>
              <aside className="register-plaque">
                <span className="plaque-label">provider entry</span>
                <div className="plaque-icon"><Plus size={21} /></div>
                <h3>Put collateral behind your promise.</h3>
                <p>Register an API or specialist agent with a schema, a deadline, and compensation rules that buyers can compare before they pay.</p>
                <button className="button button-dark" onClick={() => setModal("register")}><Plus size={15} /> Register a capability</button>
                <div className="plaque-foot"><span className="mono">collateral → escrow → evidence</span><ArrowDownRight size={16} /></div>
              </aside>
            </div>
          </section>

          <section className="section-block ledger-zone">
            <div className="section-marker"><span>03</span><span>request ledger</span><span className="marker-line" /></div>
            <div className="section-heading-wide ledger-heading">
              <div><h2>The rail<br /><em>remembers.</em></h2></div>
              <div className="ledger-controls">
                <div className="lens-tabs">
                  {(["all", "buyer", "provider", "disputes"] as Lens[]).map((item) => <button key={item} className={lens === item ? "selected" : ""} onClick={() => setLens(item)}>{item}</button>)}
                </div>
                <button className="icon-button refresh-button" title="Refresh onchain state" aria-label="Refresh onchain state" onClick={() => void refresh()}><RefreshCw size={15} /></button>
              </div>
            </div>
            <div className="ledger-list">
              {visibleJobs.length ? [...visibleJobs].reverse().map((job) => <JobLedgerRow key={job.job_id} job={job} capability={state.capabilities.find((item) => item.capability_id === job.capability_id)} address={address} monitorAddress={MONITOR_ADDRESS} now={now} onAction={(name, item) => void runJobAction(name, item)} />) : (
                <div className="empty-state ledger-empty"><LockKeyhole size={23} /><h3>No requests in this lens.</h3><p>Fund a capability and the signed execution lifecycle will appear here.</p></div>
              )}
            </div>
          </section>

          <section className="lower-grid">
            <article className="reputation-block">
              <div className="section-marker"><span>04</span><span>provider signal</span></div>
              <div className="reputation-orbit"><div className="orbit-track" /><div className="orbit-core"><span>{reputation ? bps(reputation.reliability_bps) : "—"}</span><small>reliability</small></div><span className="orbit-satellite sat-a" /><span className="orbit-satellite sat-b" /></div>
              <div className="reputation-copy"><h2>Trust is<br /><em>earned in public.</em></h2><p>{reputation ? `${reputation.jobs} jobs observed · ${reputation.disputed_jobs} disputed · ${formatGen(reputation.refunded_wei)} returned.` : "Connect your embedded wallet to see how the rail records provider performance."}</p></div>
            </article>
            <article className="dispute-block">
              <div className="section-marker"><span>05</span><span>onchain justice</span></div>
              <div className="dispute-block-head"><Gavel size={20} /><span>{openDisputes ? `${openDisputes} open now` : "quiet surface"}</span></div>
              <h2>When the receipt<br /><em>is not enough.</em></h2>
              <p>Objective checks handle latency and schema. Quality disputes are sent to GenLayer validators with the signed evidence packet in view.</p>
              <button className="button button-line" onClick={() => { setLens("disputes"); document.querySelector(".ledger-zone")?.scrollIntoView({ behavior: "smooth" }); }}>Open dispute desk <Gavel size={15} /></button>
            </article>
          </section>

          <footer className="site-footer"><span>Recourse protocol · Studio Next / chain {CHAIN_ID}</span><span className="mono">{CONTRACT_ADDRESS ? shortAddress(CONTRACT_ADDRESS) : "contract not configured"}</span><a href={ADAPTER_URL || "#"} className="footer-adapter" target="_blank" rel="noreferrer">adapter <Link2 size={12} /></a></footer>
        </section>
      )}

      {modal === "register" && <ModalShell eyebrow="Provider entry" title="Register a capability" onClose={() => setModal("none")}><form className="form" onSubmit={(event) => void register(event)}><div className="form-grid"><Field label="Capability name" name="name" value={registerForm.name} onChange={(value) => setRegisterForm({ ...registerForm, name: value })} /><Field label="Public endpoint" name="endpoint" value={registerForm.endpoint} onChange={(value) => setRegisterForm({ ...registerForm, endpoint: value })} /><Field label="Deadline (seconds)" name="deadline" type="number" value={registerForm.deadline} onChange={(value) => setRegisterForm({ ...registerForm, deadline: value })} /><Field label="Price (GEN)" name="price" value={registerForm.price} onChange={(value) => setRegisterForm({ ...registerForm, price: value })} /><Field label="Collateral (GEN)" name="collateral" value={registerForm.collateral} onChange={(value) => setRegisterForm({ ...registerForm, collateral: value })} /><Field label="Timeout refund (%)" name="timeout" type="number" value={registerForm.timeout} onChange={(value) => setRegisterForm({ ...registerForm, timeout: value })} /><Field label="Malformed refund (%)" name="malformed" type="number" value={registerForm.malformed} onChange={(value) => setRegisterForm({ ...registerForm, malformed: value })} /></div><label className="field"><span>Terms</span><textarea value={registerForm.terms} onChange={(event) => setRegisterForm({ ...registerForm, terms: event.target.value })} /></label><label className="field"><span>Required output schema</span><textarea value={registerForm.schema} onChange={(event) => setRegisterForm({ ...registerForm, schema: event.target.value })} /></label><div className="modal-actions"><span className="modal-note">Collateral is held by Recourse until the request resolves.</span><button className="button button-acid" disabled={busy === "register"} type="submit">{busy === "register" ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} Register</button></div></form></ModalShell>}
      {modal === "job" && selectedCapability && <ModalShell eyebrow="Buyer escrow" title={`Fund ${selectedCapability.name}`} onClose={() => setModal("none")}><form className="form" onSubmit={(event) => void createJob(event)}><div className="escrow-callout"><LockKeyhole size={18} /><div><strong>{formatGen(selectedCapability.price_wei)} moves into escrow.</strong><span>Wallet balance: {formatGen(balance)}. After funding, the live capability runs automatically and the result appears in My escrows.</span></div></div><Field label="Request label" name="label" value={jobForm.label} onChange={(value) => setJobForm({ ...jobForm, label: value })} /><JobRequestFields capability={selectedCapability} form={jobForm} onChange={setJobForm} /><div className="hash-note"><span className="mono">request identity</span><strong>generated at funding time</strong><p>The request hash commits to this capability, label, exact input, and a one-time nonce. It is shown in My escrows and carried through the signed receipt and public evidence.</p></div><div className="modal-actions"><span className="modal-note">Privy signs the escrow. The adapter runs only this listed capability.</span><div className="modal-button-group"><button className="button button-line" type="button" onClick={() => void fundWallet()} disabled={busy === "faucet"}>{busy === "faucet" ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} Get test GEN</button><button className="button button-acid" disabled={busy === "job" || busy === "faucet"} type="submit">{busy === "job" ? <LoaderCircle className="spin" size={15} /> : <LockKeyhole size={15} />} Fund and run</button></div></div></form></ModalShell>}
      {modal === "receipt" && selectedJob && <ModalShell eyebrow="Provider execution" title={`Submit receipt for Job ${selectedJob.job_id}`} onClose={() => setModal("none")}><form className="form" onSubmit={(event) => void submitReceipt(event)}><Field label="Output hash" name="outputHash" value={receiptForm.outputHash} onChange={(value) => setReceiptForm({ ...receiptForm, outputHash: value })} placeholder="sha256:..." /><div className="form-grid"><label className="field"><span>Response status</span><select value={receiptForm.status} onChange={(event) => setReceiptForm({ ...receiptForm, status: event.target.value })}><option value="success">Success</option><option value="timeout">Timeout</option><option value="malformed">Malformed</option></select></label><Field label="HTTP status" name="code" type="number" value={receiptForm.code} onChange={(value) => setReceiptForm({ ...receiptForm, code: value })} /><Field label="Latency (ms)" name="latency" type="number" value={receiptForm.latency} onChange={(value) => setReceiptForm({ ...receiptForm, latency: value })} /></div><label className="check-field"><input type="checkbox" checked={receiptForm.schemaValid} onChange={(event) => setReceiptForm({ ...receiptForm, schemaValid: event.target.checked })} /> Output matched the required schema</label><div className="modal-actions"><span className="modal-note">Your embedded wallet signs the canonical receipt.</span><button className="button button-acid" disabled={busy === "receipt"} type="submit">{busy === "receipt" ? <LoaderCircle className="spin" size={15} /> : <FileCheck2 size={15} />} Sign and commit</button></div></form></ModalShell>}
      {modal === "evidence" && selectedJob && <ModalShell eyebrow="Monitor evidence" title={`Publish evidence for Job ${selectedJob.job_id}`} onClose={() => setModal("none")}><form className="form" onSubmit={(event) => void publishEvidence(event)}><Field label="Public evidence URL" name="url" value={evidenceForm.url} onChange={(value) => setEvidenceForm({ url: value })} placeholder="https://adapter.example.com/evidence/..." /><div className="evidence-callout"><ScanLine size={18} /><span>Validators fetch this JSON themselves. It must match the provider’s signed receipt exactly.</span></div><div className="modal-actions"><span className="modal-note">Monitor access is enforced by the contract.</span><button className="button button-acid" disabled={busy === "evidence"} type="submit">{busy === "evidence" ? <LoaderCircle className="spin" size={15} /> : <ScanLine size={15} />} Publish evidence</button></div></form></ModalShell>}
      {modal === "dispute" && selectedJob && <ModalShell eyebrow="Onchain justice" title={`Open recourse for Job ${selectedJob.job_id}`} onClose={() => setModal("none")}><form className="form" onSubmit={(event) => void openDispute(event)}><label className="field"><span>Dispute type</span><select value={disputeForm.type} onChange={(event) => setDisputeForm({ ...disputeForm, type: event.target.value })}><option value="quality">Quality</option><option value="terms">Terms</option></select></label><label className="field"><span>Complaint</span><textarea value={disputeForm.complaint} onChange={(event) => setDisputeForm({ ...disputeForm, complaint: event.target.value })} required /></label><div className="modal-actions"><span className="modal-note">Validators receive the signed evidence and complaint.</span><button className="button button-acid" disabled={busy === "dispute"} type="submit">{busy === "dispute" ? <LoaderCircle className="spin" size={15} /> : <Gavel size={15} />} Open dispute</button></div></form></ModalShell>}
      {modal === "logout" && <ModalShell eyebrow="Session control" title="Log out of Recourse?" onClose={() => setModal("none")}><div className="logout-confirm"><p>Your Studio Next embedded wallet stays available only while this session is connected. Any funded escrows remain onchain and visible when you sign in again.</p><div className="modal-actions"><button className="button button-ghost" onClick={() => setModal("none")}><Check size={15} /> Stay connected</button><button className="button button-dark" onClick={() => { setModal("none"); void logout(); }}><LogOut size={15} /> Log out</button></div></div></ModalShell>}
    </main>
  );
}

export default function Home() {
  if (!process.env.NEXT_PUBLIC_PRIVY_APP_ID) {
    return (
      <main className="app-shell">
        <section className="guide-view">
          <div className="guide-intro">
            <div>
              <span className="eyebrow">Runtime configuration</span>
              <h1>Recourse is ready for its wallet layer.</h1>
            </div>
            <p>Set the public Privy app ID to enable embedded Studio Next wallets. The contract and adapter configuration can remain independent of the authentication layer.</p>
          </div>
        </section>
      </main>
    );
  }
  return <PrivyHome />;
}
