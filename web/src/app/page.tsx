"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  BadgeCheck,
  Check,
  CircleAlert,
  Clock3,
  ExternalLink,
  FileCheck2,
  Gavel,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { CHAIN_ID, CONTRACT_ADDRESS, EXPLORER_URL, formatDate, formatGen, MONITOR_ADDRESS, parseGen, shortAddress } from "@/lib/config";
import { connectWallet, loadState, readReputation, signReceipt, write, type AppState, type WalletProvider } from "@/lib/genlayer";
import type { Capability, Job, Reputation } from "@/lib/types";

type Panel = "market" | "jobs" | "disputes" | "provider";
type Modal = "register" | "job" | "receipt" | "evidence" | "dispute" | "none";

const emptyState: AppState = { capabilities: [], jobs: [], receipts: {}, evidence: [], disputes: [] };

function getProvider() {
  return typeof window !== "undefined" ? (window as Window & { ethereum?: WalletProvider }).ethereum : undefined;
}

function bps(value: number) {
  return `${(value / 100).toFixed(value % 100 === 0 ? 0 : 2)}%`;
}

function asWei(value: number | string | bigint) {
  return typeof value === "bigint" ? value : BigInt(value);
}

function statusTone(status: string) {
  if (status === "settled" || status === "active" || status === "resolved") return "good";
  if (status === "disputed" || status === "paused") return "warn";
  return "neutral";
}

function ModalShell({ title, eyebrow, onClose, children }: { title: string; eyebrow: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-head">
          <div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>
          <button className="icon-button" aria-label="Close dialog" title="Close dialog" onClick={onClose}><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, name, value, onChange, placeholder, type = "text", required = true }: { label: string; name: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string; required?: boolean }) {
  return <label className="field"><span>{label}</span><input name={name} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} type={type} required={required} /></label>;
}

function CapabilityCard({ capability, address, onBuy }: { capability: Capability; address: string; onBuy: (capability: Capability) => void }) {
  const available = asWei(capability.collateral_wei) - asWei(capability.reserved_collateral_wei);
  return (
    <article className="capability-card">
      <div className="card-topline"><span className={`status ${statusTone(capability.status)}`}>{capability.status}</span><span className="mono">CAP-{capability.capability_id}</span></div>
      <div className="card-title-row"><div><h3>{capability.name}</h3><p className="muted">{shortAddress(capability.provider)} · {capability.endpoint}</p></div><strong className="price">{formatGen(capability.price_wei)}</strong></div>
      <p className="terms">{capability.terms}</p>
      <div className="metric-row"><div><span>Deadline</span><strong>{capability.deadline_seconds}s</strong></div><div><span>Timeout</span><strong>{bps(capability.timeout_refund_bps)} back</strong></div><div><span>Malformed</span><strong>{bps(capability.malformed_refund_bps)} back</strong></div><div><span>Capacity</span><strong>{formatGen(available)}</strong></div></div>
      <div className="card-footer"><span className="muted">Schema-bound request rail</span>{capability.provider.toLowerCase() === address.toLowerCase() ? <span className="ownership"><BadgeCheck size={15} /> Your capability</span> : <button className="button primary small" disabled={capability.status !== "active"} onClick={() => onBuy(capability)}><LockKeyhole size={15} /> Fund request</button>}</div>
    </article>
  );
}

function JobRow({ job, capability, address, monitorAddress, onAction }: { job: Job; capability?: Capability; address: string; monitorAddress: string; onAction: (action: string, job: Job) => void }) {
  const isBuyer = job.buyer.toLowerCase() === address.toLowerCase();
  const isProvider = job.provider.toLowerCase() === address.toLowerCase();
  const isMonitor = Boolean(monitorAddress) && monitorAddress.toLowerCase() === address.toLowerCase();
  return (
    <article className="job-row">
      <div className="job-main"><div className="job-id mono">JOB-{job.job_id}</div><h3>{job.request_label}</h3><p>{capability?.name ?? `Capability ${job.capability_id}`} · {formatGen(job.escrow_wei)} escrow</p></div>
      <div className="job-fact"><span>Status</span><strong className={`status-text ${statusTone(job.status)}`}>{job.status.replace("_", " ")}</strong></div>
      <div className="job-fact"><span>Deadline</span><strong>{formatDate(job.deadline_at)}</strong></div>
      <div className="job-actions">
        {isProvider && job.status === "funded" && <button className="icon-button" title="Submit provider receipt" aria-label="Submit provider receipt" onClick={() => onAction("receipt", job)}><FileCheck2 size={16} /></button>}
        {isMonitor && job.status === "receipt_submitted" && <button className="icon-button" title="Publish evidence packet" aria-label="Publish evidence packet" onClick={() => onAction("evidence", job)}><Activity size={16} /></button>}
        {isBuyer && job.status === "funded" && <button className="button ghost small" onClick={() => onAction("timeout", job)}><Clock3 size={14} /> Claim timeout</button>}
        {isBuyer && job.status === "receipt_submitted" && <button className="button ghost small" onClick={() => onAction("dispute", job)}><Gavel size={14} /> Dispute</button>}
        {job.status === "receipt_submitted" && <button className="button dark small" onClick={() => onAction("settle", job)}><ShieldCheck size={14} /> Settle</button>}
        {job.status === "settled" && <span className={`status ${statusTone(job.outcome)}`}>{job.outcome} · {bps(job.refund_bps)} refund</span>}
      </div>
    </article>
  );
}

export default function Home() {
  const [panel, setPanel] = useState<Panel>("market");
  const [modal, setModal] = useState<Modal>("none");
  const [state, setState] = useState<AppState>(emptyState);
  const [address, setAddress] = useState("");
  const [reputation, setReputation] = useState<Reputation | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [selectedCapability, setSelectedCapability] = useState<Capability | null>(null);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [registerForm, setRegisterForm] = useState({ name: "Verified source research", endpoint: "https://api.example.com/research", terms: "Return five verified sources in JSON. Every item must include title, URL, and citation.", deadline: "30", schema: '{"type":"array","items":{"type":"object","required":["title","url","citation"]}}', timeout: "100", malformed: "75", price: "2", collateral: "10" });
  const [jobForm, setJobForm] = useState({ requestHash: "", label: "Return five verified sources in JSON" });
  const [receiptForm, setReceiptForm] = useState({ outputHash: "", status: "success", code: "200", latency: "1200", schemaValid: true, completedAt: "" , signature: ""});
  const [evidenceForm, setEvidenceForm] = useState({ url: "" });
  const [disputeForm, setDisputeForm] = useState({ type: "quality", complaint: "The returned sources do not support the requested claims." });

  const refresh = useCallback(async () => {
    setError("");
    try {
      const next = await loadState();
      setState(next);
      if (address) setReputation(await readReputation(address));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The Studio Dev state could not be loaded.");
    }
  }, [address]);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const ownCapabilities = useMemo(() => state.capabilities.filter((item) => item.provider.toLowerCase() === address.toLowerCase()), [state.capabilities, address]);
  const visibleJobs = useMemo(() => state.jobs.filter((item) => !address || item.buyer.toLowerCase() === address.toLowerCase() || item.provider.toLowerCase() === address.toLowerCase()).reverse(), [state.jobs, address]);
  const openDisputes = state.disputes.filter((item) => item.status === "open").length;

  async function action(label: string, fn: () => Promise<string>) {
    setBusy(label); setError(""); setNotice("");
    try { const hash = await fn(); setNotice(`Finalized ${hash.slice(0, 12)}...`); setModal("none"); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The transaction failed."); }
    finally { setBusy(""); }
  }

  async function connect() {
    const provider = getProvider();
    if (!provider) { setError("Install or unlock a browser wallet connected to Studio Next."); return; }
    try {
      const chainId = await provider.request({ method: "eth_chainId" });
      if (typeof chainId !== "string" || Number.parseInt(chainId, 16) !== CHAIN_ID) {
        throw new Error(`Switch the wallet to Studio Dev chain ${CHAIN_ID} before continuing.`);
      }
      setAddress(await connectWallet(provider)); setNotice(`Connected to Studio Dev chain ${CHAIN_ID}.`);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Wallet connection failed."); }
  }

  function requireWallet() {
    const provider = getProvider();
    if (!address || !provider) throw new Error("Connect a browser wallet first.");
    return provider;
  }

  async function register(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const provider = requireWallet();
    await action("register", () => write(address, provider, "register_capability", [registerForm.name, registerForm.endpoint, registerForm.terms, BigInt(registerForm.deadline), registerForm.schema, BigInt(registerForm.timeout) * 100n, BigInt(registerForm.malformed) * 100n, parseGen(registerForm.price)], parseGen(registerForm.collateral)));
  }

  async function createJob(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCapability) return;
    const provider = requireWallet();
    await action("job", () => write(address, provider, "create_job", [selectedCapability.capability_id, jobForm.requestHash || `request-${Date.now()}`, jobForm.label], asWei(selectedCapability.price_wei)));
  }

  async function submitReceipt(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedJob) return;
    const provider = requireWallet();
    const completedAt = receiptForm.completedAt || new Date().toISOString();
    const outputHash = receiptForm.outputHash.trim().toLowerCase();
    const signed = await signReceipt(provider, address, {
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
    await action("receipt", () => write(address, provider, "submit_receipt", [selectedJob.job_id, selectedJob.request_hash, outputHash, receiptForm.status, BigInt(receiptForm.code), BigInt(receiptForm.latency), receiptForm.schemaValid, completedAt, signed.signature]));
  }

  async function publishEvidence(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedJob) return;
    const provider = requireWallet();
    await action("evidence", () => write(address, provider, "publish_evidence", [selectedJob.job_id, evidenceForm.url]));
  }

  async function openDispute(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedJob) return;
    const provider = requireWallet();
    await action("dispute", () => write(address, provider, "open_dispute", [selectedJob.job_id, disputeForm.type, disputeForm.complaint]));
  }

  async function runJobAction(actionName: string, job: Job) {
    const provider = requireWallet();
    if (actionName === "timeout") await action(`timeout-${job.job_id}`, () => write(address, provider, "claim_timeout", [job.job_id], 0n, [job.buyer]));
    if (actionName === "settle") await action(`settle-${job.job_id}`, () => write(address, provider, "settle_job", [job.job_id], 0n, [job.buyer, job.provider]));
    if (actionName === "receipt") { setSelectedJob(job); setModal("receipt"); }
    if (actionName === "evidence") { setSelectedJob(job); setModal("evidence"); }
    if (actionName === "dispute") { setSelectedJob(job); setModal("dispute"); }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">R</span><div><strong>Recourse</strong><span>agent commerce with a way back</span></div></div>
        <div className="network"><span className="network-dot" /> Studio Next / Dev · {CHAIN_ID}</div>
        <button className="wallet-button" onClick={() => void connect()}><Wallet size={16} /> {address ? shortAddress(address) : "Connect wallet"}</button>
      </header>
      <section className="hero">
        <div><span className="eyebrow">Request-level protection</span><h1>Pay an agent. Keep a way back.</h1><p>Recourse holds a single request in escrow, checks the signed execution record, and lets GenLayer resolve the chargeback when the service promise breaks.</p><div className="hero-actions"><button className="button primary" onClick={() => setPanel("market")}><ArrowUpRight size={16} /> Browse capabilities</button><a className="button ghost" href={`${EXPLORER_URL}${CONTRACT_ADDRESS}`} target="_blank" rel="noreferrer">Inspect contract <ExternalLink size={15} /></a></div></div>
        <div className="hero-proof"><div className="proof-kicker">Live rail</div><div className="proof-number">{state.jobs.length}</div><p>requests recorded on Studio Dev</p><div className="proof-line"><Check size={15} /> escrow before execution</div><div className="proof-line"><Check size={15} /> signed receipt after execution</div><div className="proof-line"><Check size={15} /> validator decision for disputes</div></div>
      </section>
      <section className="stats"><div><span>Capabilities</span><strong>{state.capabilities.length}</strong></div><div><span>Protected requests</span><strong>{state.jobs.length}</strong></div><div><span>Open disputes</span><strong>{openDisputes}</strong></div><div><span>Your reliability</span><strong>{reputation ? bps(reputation.reliability_bps) : "—"}</strong></div></section>
      <nav className="tabs" aria-label="Recourse workspaces">
        {([["market", "Capability market"], ["jobs", "Your requests"], ["disputes", "Dispute desk"], ["provider", "Provider tools"]] as const).map(([id, label]) => <button key={id} className={panel === id ? "selected" : ""} onClick={() => setPanel(id)}>{label}{id === "disputes" && openDisputes > 0 ? <span className="tab-count">{openDisputes}</span> : null}</button>)}
        <button className="refresh-tab" aria-label="Refresh state" title="Refresh state" onClick={() => void refresh()}><RefreshCw size={15} /></button>
      </nav>
      {notice && <div className="notice success"><Check size={16} /> {notice}</div>}
      {error && <div className="notice error"><CircleAlert size={16} /> {error}</div>}
      {!CONTRACT_ADDRESS && <div className="notice error"><CircleAlert size={16} /> Deploy Recourse first. The dashboard has no contract address configured.</div>}
      <section className="workspace">
        {panel === "market" && <><div className="section-heading"><div><span className="eyebrow">Buy a capability</span><h2>Explicit terms before the request moves.</h2></div><span className="muted">{state.capabilities.length} registered capabilities</span></div><div className="capability-grid">{state.capabilities.length ? state.capabilities.map((item) => <CapabilityCard key={item.capability_id} capability={item} address={address} onBuy={(item) => { setSelectedCapability(item); setModal("job"); }} />) : <div className="empty"><Activity size={22} /><h3>No capabilities yet</h3><p>A provider can publish the first request-level service from Provider tools.</p></div>}</div></>}
        {panel === "jobs" && <><div className="section-heading"><div><span className="eyebrow">Escrow activity</span><h2>Your requests, receipts, and settlements.</h2></div><span className="muted">{visibleJobs.length} visible jobs</span></div><div className="job-list">{visibleJobs.length ? visibleJobs.map((job) => <JobRow key={job.job_id} job={job} capability={state.capabilities.find((item) => item.capability_id === job.capability_id)} address={address} monitorAddress={MONITOR_ADDRESS} onAction={(name, item) => void runJobAction(name, item)} />) : <div className="empty"><LockKeyhole size={22} /><h3>Nothing in your rail yet</h3><p>Fund a capability request and the receipt lifecycle will appear here.</p></div>}</div></>}
        {panel === "disputes" && <><div className="section-heading"><div><span className="eyebrow">Onchain justice</span><h2>Disputes resolved from public evidence.</h2></div><span className="muted">{state.disputes.length} recorded disputes</span></div><div className="dispute-list">{state.disputes.length ? [...state.disputes].reverse().map((item) => <article className="dispute-card" key={item.dispute_id}><div className="card-topline"><span className={`status ${statusTone(item.status)}`}>{item.status}</span><span className="mono">DISPUTE-{item.dispute_id}</span></div><h3>Job {item.job_id} · {item.dispute_type} review</h3><p>{item.complaint}</p><div className="dispute-footer"><span>Opened {formatDate(item.opened_at)}</span>{item.status === "resolved" ? <strong>{item.decision} · {bps(item.refund_bps)} refund</strong> : <span className="status warn">Awaiting validator decision</span>}</div></article>) : <div className="empty"><Gavel size={22} /><h3>No disputes opened</h3><p>When a receipt or output is challenged, GenLayer records the complaint and decision here.</p></div>}</div></>}
        {panel === "provider" && <><div className="section-heading"><div><span className="eyebrow">Provider tools</span><h2>Put collateral behind a precise promise.</h2></div><button className="button primary small" onClick={() => setModal("register")}><Plus size={15} /> Register capability</button></div><div className="provider-grid"><div className="panel"><div className="panel-heading"><BadgeCheck size={18} /><div><h3>Your capabilities</h3><p>Capacity is reserved as jobs enter escrow.</p></div></div>{ownCapabilities.length ? ownCapabilities.map((item) => <div className="mini-row" key={item.capability_id}><div><strong>{item.name}</strong><span>{formatGen(asWei(item.collateral_wei) - asWei(item.reserved_collateral_wei))} available</span></div><span className={`status ${statusTone(item.status)}`}>{item.status}</span></div>) : <div className="mini-empty">No capabilities owned by this wallet.</div>}</div><div className="panel"><div className="panel-heading"><ShieldCheck size={18} /><div><h3>Provider reputation</h3><p>Reliability changes when a job settles.</p></div></div>{reputation ? <div className="reputation"><strong>{bps(reputation.reliability_bps)}</strong><span>{reputation.jobs} jobs · {reputation.disputed_jobs} disputed · {formatGen(reputation.refunded_wei)} refunded</span></div> : <div className="mini-empty">Connect the provider wallet to view its score.</div>}</div></div></>}
      </section>
      <footer><span>Recourse protocol · native GEN escrow · Studio Dev chain {CHAIN_ID}</span><span className="mono">{CONTRACT_ADDRESS ? shortAddress(CONTRACT_ADDRESS) : "not deployed"}</span></footer>

      {modal === "register" && <ModalShell eyebrow="Provider tools" title="Register a capability" onClose={() => setModal("none")}><form className="form" onSubmit={(event) => void register(event)}><div className="form-grid"><Field label="Capability name" name="name" value={registerForm.name} onChange={(value) => setRegisterForm({ ...registerForm, name: value })} /><Field label="Public endpoint" name="endpoint" value={registerForm.endpoint} onChange={(value) => setRegisterForm({ ...registerForm, endpoint: value })} /><Field label="Deadline (seconds)" name="deadline" type="number" value={registerForm.deadline} onChange={(value) => setRegisterForm({ ...registerForm, deadline: value })} /><Field label="Price (GEN)" name="price" value={registerForm.price} onChange={(value) => setRegisterForm({ ...registerForm, price: value })} /><Field label="Collateral (GEN)" name="collateral" value={registerForm.collateral} onChange={(value) => setRegisterForm({ ...registerForm, collateral: value })} /><Field label="Timeout refund (%)" name="timeout" type="number" value={registerForm.timeout} onChange={(value) => setRegisterForm({ ...registerForm, timeout: value })} /><Field label="Malformed refund (%)" name="malformed" type="number" value={registerForm.malformed} onChange={(value) => setRegisterForm({ ...registerForm, malformed: value })} /></div><label className="field"><span>Terms</span><textarea value={registerForm.terms} onChange={(event) => setRegisterForm({ ...registerForm, terms: event.target.value })} /></label><label className="field"><span>Required output schema</span><textarea value={registerForm.schema} onChange={(event) => setRegisterForm({ ...registerForm, schema: event.target.value })} /></label><div className="modal-actions"><span className="muted">Collateral is held by the contract.</span><button className="button primary" disabled={busy === "register"} type="submit">{busy === "register" ? <RefreshCw className="spin" size={15} /> : <Plus size={15} />} Register</button></div></form></ModalShell>}
      {modal === "job" && selectedCapability && <ModalShell eyebrow="Buyer escrow" title={`Fund ${selectedCapability.name}`} onClose={() => setModal("none")}><form className="form" onSubmit={(event) => void createJob(event)}><div className="escrow-callout"><LockKeyhole size={18} /><div><strong>{formatGen(selectedCapability.price_wei)} moves into escrow.</strong><span>Provider receives it only after evidence and the challenge window.</span></div></div><Field label="Request label" name="label" value={jobForm.label} onChange={(value) => setJobForm({ ...jobForm, label: value })} /><Field label="Request hash" name="requestHash" value={jobForm.requestHash} onChange={(value) => setJobForm({ ...jobForm, requestHash: value })} placeholder="sha256:..." required={false} /><div className="modal-actions"><span className="muted">Exact price required: {formatGen(selectedCapability.price_wei)}</span><button className="button primary" disabled={busy === "job"} type="submit">{busy === "job" ? <RefreshCw className="spin" size={15} /> : <LockKeyhole size={15} />} Fund escrow</button></div></form></ModalShell>}
      {modal === "receipt" && selectedJob && <ModalShell eyebrow="Provider execution" title={`Submit receipt for Job ${selectedJob.job_id}`} onClose={() => setModal("none")}><form className="form" onSubmit={(event) => void submitReceipt(event)}><Field label="Output hash" name="outputHash" value={receiptForm.outputHash} onChange={(value) => setReceiptForm({ ...receiptForm, outputHash: value })} placeholder="sha256:..." /><div className="form-grid"><label className="field"><span>Response status</span><select value={receiptForm.status} onChange={(event) => setReceiptForm({ ...receiptForm, status: event.target.value })}><option value="success">Success</option><option value="timeout">Timeout</option><option value="malformed">Malformed</option></select></label><Field label="HTTP status" name="code" type="number" value={receiptForm.code} onChange={(value) => setReceiptForm({ ...receiptForm, code: value })} /><Field label="Latency (ms)" name="latency" type="number" value={receiptForm.latency} onChange={(value) => setReceiptForm({ ...receiptForm, latency: value })} /></div><label className="check-field"><input type="checkbox" checked={receiptForm.schemaValid} onChange={(event) => setReceiptForm({ ...receiptForm, schemaValid: event.target.checked })} /> Output matched the required schema</label><div className="modal-actions"><span className="muted">Your wallet signs the canonical receipt before it is committed.</span><button className="button primary" disabled={busy === "receipt"} type="submit">{busy === "receipt" ? <RefreshCw className="spin" size={15} /> : <FileCheck2 size={15} />} Sign and commit</button></div></form></ModalShell>}
      {modal === "evidence" && selectedJob && <ModalShell eyebrow="Monitor evidence" title={`Publish evidence for Job ${selectedJob.job_id}`} onClose={() => setModal("none")}><form className="form" onSubmit={(event) => void publishEvidence(event)}><Field label="Public evidence URL" name="url" value={evidenceForm.url} onChange={(value) => setEvidenceForm({ url: value })} placeholder="https://..." /><div className="evidence-callout"><Activity size={18} /><span>This action is restricted to the configured monitor operator. Validators fetch the URL and compare its canonical fields to the signed receipt.</span></div><div className="modal-actions"><span className="muted">Evidence must be public and JSON.</span><button className="button primary" disabled={busy === "evidence"} type="submit">{busy === "evidence" ? <RefreshCw className="spin" size={15} /> : <Activity size={15} />} Publish evidence</button></div></form></ModalShell>}
      {modal === "dispute" && selectedJob && <ModalShell eyebrow="Onchain justice" title={`Open a dispute for Job ${selectedJob.job_id}`} onClose={() => setModal("none")}><form className="form" onSubmit={(event) => void openDispute(event)}><label className="field"><span>Dispute type</span><select value={disputeForm.type} onChange={(event) => setDisputeForm({ ...disputeForm, type: event.target.value })}><option value="quality">Quality</option><option value="terms">Terms</option></select></label><label className="field"><span>Complaint</span><textarea value={disputeForm.complaint} onChange={(event) => setDisputeForm({ ...disputeForm, complaint: event.target.value })} required /></label><div className="modal-actions"><span className="muted">Validators receive the signed evidence and this complaint.</span><button className="button primary" disabled={busy === "dispute"} type="submit">{busy === "dispute" ? <RefreshCw className="spin" size={15} /> : <Gavel size={15} />} Open dispute</button></div></form></ModalShell>}
    </main>
  );
}
