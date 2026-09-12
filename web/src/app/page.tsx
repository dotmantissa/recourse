"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import {
  ArrowDownRight,
  ArrowUpRight,
  BadgeCheck,
  BookOpen,
  Check,
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
  readReputation,
  signReceipt,
  write,
  type AppState,
  type WalletProvider,
} from "@/lib/genlayer";
import type { Capability, Job, Reputation } from "@/lib/types";

type View = "console" | "guide";
type Lens = "all" | "buyer" | "provider" | "disputes";
type Modal = "register" | "job" | "receipt" | "evidence" | "dispute" | "none";

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
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-head">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2>{title}</h2>
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
  onAction,
}: {
  job: Job;
  capability?: Capability;
  address: string;
  monitorAddress: string;
  onAction: (action: string, job: Job) => void;
}) {
  const isBuyer = job.buyer.toLowerCase() === address.toLowerCase();
  const isProvider = job.provider.toLowerCase() === address.toLowerCase();
  const isMonitor = Boolean(monitorAddress) && monitorAddress.toLowerCase() === address.toLowerCase();
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
        {isBuyer && job.status === "funded" && <button className="button button-line small" onClick={() => onAction("timeout", job)}><Clock3 size={14} /> Claim timeout</button>}
        {isBuyer && job.status === "receipt_submitted" && <button className="button button-line small" onClick={() => onAction("dispute", job)}><Gavel size={14} /> Dispute</button>}
        {job.status === "receipt_submitted" && <button className="button button-dark small" onClick={() => onAction("settle", job)}><ShieldCheck size={14} /> Settle</button>}
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
      <div className="guide-footer-callout">
        <div className="stamp"><KeyRound size={18} /> no blind payment</div>
        <p>Recourse is not a marketplace and it is not an uptime dashboard. It is the request-level contract that gives agents a credible reason to transact.</p>
        <button className="button button-acid" onClick={() => document.getElementById("console")?.scrollIntoView({ behavior: "smooth" })}>Open the console <ArrowDownRight size={15} /></button>
      </div>
    </section>
  );
}

function PrivyHome() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [view, setView] = useState<View>("console");
  const [lens, setLens] = useState<Lens>("all");
  const [state, setState] = useState<AppState>(emptyState);
  const [reputation, setReputation] = useState<Reputation | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [modal, setModal] = useState<Modal>("none");
  const [selectedCapability, setSelectedCapability] = useState<Capability | null>(null);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [registerForm, setRegisterForm] = useState({
    name: "Verified source research",
    endpoint: "https://api.example.com/research",
    terms: "Return five verified sources in JSON. Every item must include title, URL, and citation.",
    deadline: "30",
    schema: '{"type":"array","items":{"type":"object","required":["title","url","citation"]}}',
    timeout: "100",
    malformed: "75",
    price: "2",
    collateral: "10",
  });
  const [jobForm, setJobForm] = useState({ requestHash: "", label: "Return five verified sources in JSON" });
  const [receiptForm, setReceiptForm] = useState({ outputHash: "", status: "success", code: "200", latency: "1200", schemaValid: true, completedAt: "" });
  const [evidenceForm, setEvidenceForm] = useState({ url: "" });
  const [disputeForm, setDisputeForm] = useState({ type: "quality", complaint: "The returned sources do not support the requested claims." });

  const embeddedWallet = wallets.find((wallet) => wallet.walletClientType === "privy") ?? wallets[0];
  const address = embeddedWallet?.address ?? "";

  const refresh = useCallback(async () => {
    setError("");
    try {
      const next = await loadState();
      setState(next);
      if (address) setReputation(await readReputation(address));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The Studio Next state could not be loaded.");
    }
  }, [address]);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(timer);
    };
  }, [refresh]);

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

  async function action(label: string, fn: () => Promise<string>) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const hash = await fn();
      setNotice(`Finalized ${hash.slice(0, 12)}...`);
      setModal("none");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The transaction failed.");
    } finally {
      setBusy("");
    }
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

  async function register(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const context = await walletContext();
    await action("register", () => write(context.address, context.provider, "register_capability", [registerForm.name, registerForm.endpoint, registerForm.terms, BigInt(registerForm.deadline), registerForm.schema, BigInt(registerForm.timeout) * 100n, BigInt(registerForm.malformed) * 100n, parseGen(registerForm.price)], parseGen(registerForm.collateral)));
  }

  async function createJob(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCapability) return;
    const context = await walletContext();
    await action("job", () => write(context.address, context.provider, "create_job", [selectedCapability.capability_id, jobForm.requestHash || `request-${Date.now()}`, jobForm.label], asWei(selectedCapability.price_wei)));
  }

  async function submitReceipt(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedJob) return;
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
    await action("receipt", () => write(context.address, context.provider, "submit_receipt", [selectedJob.job_id, selectedJob.request_hash, outputHash, receiptForm.status, BigInt(receiptForm.code), BigInt(receiptForm.latency), receiptForm.schemaValid, completedAt, signed.signature]));
  }

  async function publishEvidence(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedJob) return;
    const context = await walletContext();
    await action("evidence", () => write(context.address, context.provider, "publish_evidence", [selectedJob.job_id, evidenceForm.url]));
  }

  async function openDispute(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedJob) return;
    const context = await walletContext();
    await action("dispute", () => write(context.address, context.provider, "open_dispute", [selectedJob.job_id, disputeForm.type, disputeForm.complaint]));
  }

  async function runJobAction(actionName: string, job: Job) {
    if (["receipt", "evidence", "dispute"].includes(actionName)) {
      setSelectedJob(job);
      setModal(actionName as Modal);
      return;
    }
    const context = await walletContext();
    if (actionName === "timeout") await action(`timeout-${job.job_id}`, () => write(context.address, context.provider, "claim_timeout", [job.job_id], 0n, [job.buyer]));
    if (actionName === "settle") await action(`settle-${job.job_id}`, () => write(context.address, context.provider, "settle_job", [job.job_id], 0n, [job.buyer, job.provider]));
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
          <button className={view === "guide" ? "nav-link selected" : "nav-link"} onClick={() => setView("guide")}><BookOpen size={15} /> Field guide</button>
        </div>
        <div className="nav-right">
          <span className="network-chip"><span className="pulse-dot" /> Studio Next <span className="mono">{CHAIN_ID}</span></span>
          {authenticated && address ? (
            <button className="wallet-chip" onClick={() => void logout()} title="Sign out of Privy">
              <WalletCards size={15} /> {shortAddress(address)} <LogOut size={13} />
            </button>
          ) : (
            <button className="wallet-chip wallet-chip-acid" onClick={() => void connect()} disabled={!ready}>
              <KeyRound size={15} /> {ready ? "Create wallet" : "Loading wallet"}
            </button>
          )}
        </div>
      </header>

      {view === "guide" ? <Guide /> : (
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
            <div className="capability-layout">
              <div className="capability-list">
                {state.capabilities.length ? state.capabilities.map((item) => <CapabilitySpecimen key={item.capability_id} capability={item} address={address} onBuy={(capability) => { setSelectedCapability(capability); setModal("job"); }} />) : (
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
              {visibleJobs.length ? [...visibleJobs].reverse().map((job) => <JobLedgerRow key={job.job_id} job={job} capability={state.capabilities.find((item) => item.capability_id === job.capability_id)} address={address} monitorAddress={MONITOR_ADDRESS} onAction={(name, item) => void runJobAction(name, item)} />) : (
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
      {modal === "job" && selectedCapability && <ModalShell eyebrow="Buyer escrow" title={`Fund ${selectedCapability.name}`} onClose={() => setModal("none")}><form className="form" onSubmit={(event) => void createJob(event)}><div className="escrow-callout"><LockKeyhole size={18} /><div><strong>{formatGen(selectedCapability.price_wei)} moves into escrow.</strong><span>Provider receives it only after evidence and the challenge window.</span></div></div><Field label="Request label" name="label" value={jobForm.label} onChange={(value) => setJobForm({ ...jobForm, label: value })} /><Field label="Request hash" name="requestHash" value={jobForm.requestHash} onChange={(value) => setJobForm({ ...jobForm, requestHash: value })} placeholder="sha256:..." required={false} /><div className="modal-actions"><span className="modal-note">Privy signs this Studio Next transaction.</span><button className="button button-acid" disabled={busy === "job"} type="submit">{busy === "job" ? <LoaderCircle className="spin" size={15} /> : <LockKeyhole size={15} />} Fund escrow</button></div></form></ModalShell>}
      {modal === "receipt" && selectedJob && <ModalShell eyebrow="Provider execution" title={`Submit receipt for Job ${selectedJob.job_id}`} onClose={() => setModal("none")}><form className="form" onSubmit={(event) => void submitReceipt(event)}><Field label="Output hash" name="outputHash" value={receiptForm.outputHash} onChange={(value) => setReceiptForm({ ...receiptForm, outputHash: value })} placeholder="sha256:..." /><div className="form-grid"><label className="field"><span>Response status</span><select value={receiptForm.status} onChange={(event) => setReceiptForm({ ...receiptForm, status: event.target.value })}><option value="success">Success</option><option value="timeout">Timeout</option><option value="malformed">Malformed</option></select></label><Field label="HTTP status" name="code" type="number" value={receiptForm.code} onChange={(value) => setReceiptForm({ ...receiptForm, code: value })} /><Field label="Latency (ms)" name="latency" type="number" value={receiptForm.latency} onChange={(value) => setReceiptForm({ ...receiptForm, latency: value })} /></div><label className="check-field"><input type="checkbox" checked={receiptForm.schemaValid} onChange={(event) => setReceiptForm({ ...receiptForm, schemaValid: event.target.checked })} /> Output matched the required schema</label><div className="modal-actions"><span className="modal-note">Your embedded wallet signs the canonical receipt.</span><button className="button button-acid" disabled={busy === "receipt"} type="submit">{busy === "receipt" ? <LoaderCircle className="spin" size={15} /> : <FileCheck2 size={15} />} Sign and commit</button></div></form></ModalShell>}
      {modal === "evidence" && selectedJob && <ModalShell eyebrow="Monitor evidence" title={`Publish evidence for Job ${selectedJob.job_id}`} onClose={() => setModal("none")}><form className="form" onSubmit={(event) => void publishEvidence(event)}><Field label="Public evidence URL" name="url" value={evidenceForm.url} onChange={(value) => setEvidenceForm({ url: value })} placeholder="https://adapter.example.com/evidence/..." /><div className="evidence-callout"><ScanLine size={18} /><span>Validators fetch this JSON themselves. It must match the provider’s signed receipt exactly.</span></div><div className="modal-actions"><span className="modal-note">Monitor access is enforced by the contract.</span><button className="button button-acid" disabled={busy === "evidence"} type="submit">{busy === "evidence" ? <LoaderCircle className="spin" size={15} /> : <ScanLine size={15} />} Publish evidence</button></div></form></ModalShell>}
      {modal === "dispute" && selectedJob && <ModalShell eyebrow="Onchain justice" title={`Open recourse for Job ${selectedJob.job_id}`} onClose={() => setModal("none")}><form className="form" onSubmit={(event) => void openDispute(event)}><label className="field"><span>Dispute type</span><select value={disputeForm.type} onChange={(event) => setDisputeForm({ ...disputeForm, type: event.target.value })}><option value="quality">Quality</option><option value="terms">Terms</option></select></label><label className="field"><span>Complaint</span><textarea value={disputeForm.complaint} onChange={(event) => setDisputeForm({ ...disputeForm, complaint: event.target.value })} required /></label><div className="modal-actions"><span className="modal-note">Validators receive the signed evidence and complaint.</span><button className="button button-acid" disabled={busy === "dispute"} type="submit">{busy === "dispute" ? <LoaderCircle className="spin" size={15} /> : <Gavel size={15} />} Open dispute</button></div></form></ModalShell>}
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
