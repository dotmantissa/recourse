import { randomUUID } from "node:crypto";
import Ajv from "ajv";
import { canonicalJson, deploymentScope, digest, requestCommitment, verifyEvidencePacket } from "./protocol.mjs";

function money(value, label) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= 2n ** 256n) throw new Error(`${label} must be an unsigned wei decimal string`);
  return BigInt(value);
}

export function validateBuyerPlan(plan) {
  const allowed = ["runId", "chainId", "contractAddress", "buyer", "capabilityIds", "requestLabel", "request", "publicEvidence", "maxSpendWei", "maxFeeWei", "maxFeePerTransactionWei", "maxTransactions", "qualityChecks"];
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || Object.keys(plan).some((key) => !allowed.includes(key))) throw new Error("Invalid buyer plan fields");
  deploymentScope(plan.chainId, plan.contractAddress);
  if (!Number.isSafeInteger(plan.chainId) || !/^0x[0-9a-f]{40}$/i.test(plan.buyer) || typeof plan.runId !== "string" || !/^[a-z0-9_-]{1,64}$/i.test(plan.runId)) throw new Error("Invalid buyer identity or run ID");
  if (plan.publicEvidence !== true) throw new Error("Explicit consent to public request/output evidence is required");
  if (!Array.isArray(plan.capabilityIds) || plan.capabilityIds.length < 1 || plan.capabilityIds.length > 5
    || plan.capabilityIds.some((id) => typeof id !== "string" || !/^[1-9][0-9]{0,19}$/.test(id))
    || new Set(plan.capabilityIds).size !== plan.capabilityIds.length) throw new Error("Choose one to five distinct capability IDs in replacement order");
  for (const field of ["maxSpendWei", "maxFeeWei", "maxFeePerTransactionWei"]) if (money(plan[field], field) <= 0n) throw new Error(`${field} must be positive`);
  if (money(plan.maxFeePerTransactionWei, "fee cap") > money(plan.maxFeeWei, "fee budget")) throw new Error("Per-transaction fee cap exceeds total fee budget");
  if (!Number.isSafeInteger(plan.maxTransactions) || plan.maxTransactions < 1 || plan.maxTransactions > 30) throw new Error("maxTransactions must be between 1 and 30");
  const checks = plan.qualityChecks ?? [];
  if (!Array.isArray(checks) || checks.length > 10 || checks.some((check) => !check || Object.keys(check).some((key) => !["path", "equals"].includes(key))
    || !Array.isArray(check.path) || check.path.length < 1 || check.path.length > 10
    || check.path.some((key) => typeof key !== "string" || key.length > 100 || ["__proto__", "prototype", "constructor"].includes(key))
    || !("equals" in check) || (check.equals !== null && !["string", "number", "boolean"].includes(typeof check.equals))
    || (typeof check.equals === "number" && !Number.isFinite(check.equals))
    || (typeof check.equals === "string" && check.equals.length > 1000))) throw new Error("Invalid bounded quality checks");
  const normalized = { ...plan, buyer: plan.buyer.toLowerCase(), contractAddress: plan.contractAddress.toLowerCase(), qualityChecks: checks };
  requestCommitment({ ...normalized, capabilityId: plan.capabilityIds[0], nonce: "plan-validation" });
  return JSON.parse(canonicalJson(normalized));
}

function qualityVerdict(output, checks) {
  const failed = checks.filter((check) => {
    let value = output;
    for (const key of check.path) value = value && typeof value === "object" && Object.hasOwn(value, key) ? value[key] : undefined;
    return value !== check.equals;
  });
  return { accept: failed.length === 0, complaint: `Delivered output failed the buyer's requested acceptance checks for: ${failed.map((check) => check.path.join(".")).join(", ")}. Assess this against the committed request and provider terms.` };
}

export function createBuyerWorkflow({ plan: input, journal, transport, now = Date.now }) {
  const plan = validateBuyerPlan(input);
  const planHash = digest(plan);
  const snapshot = (state, waiting) => ({ status: state.status, waiting: waiting ?? null, spentWei: state.spentWei, feesWei: state.feesWei,
    writes: state.writes, attempts: state.attempts, jobId: state.current?.jobId ?? null, pendingHash: state.pending?.hash ?? null, result: state.result ?? null });

  return { step: () => journal.withLock(async () => {
    let state = await journal.read();
    if (!state) {
      state = { version: 1, planHash, status: "running", spentWei: "0", feesWei: "0", writes: 0, attempts: [], current: null, pending: null, transactions: [] };
      await journal.write(state);
    }
    if (state.version !== 1 || state.planHash !== planHash || !Array.isArray(state.attempts) || state.attempts.length > plan.capabilityIds.length
      || !Number.isSafeInteger(state.writes) || state.writes < 0 || state.writes > plan.maxTransactions
      || money(state.spentWei, "journal spend") > money(plan.maxSpendWei, "spend limit")
      || money(state.feesWei, "journal fees") > money(plan.maxFeeWei, "fee limit")) throw new Error("Buyer journal does not match the authorized plan");
    if (state.status !== "running") return snapshot(state);
    const save = () => journal.write(state);
    const stop = async (status) => { state.status = status; await save(); return snapshot(state); };

    async function submit(method, args, value = "0", recipients = []) {
      const current = state.current;
      if ((current.actions[method] ?? 0) >= 2) return snapshot(state, "action retry limit reached; waiting for recovery deadline or operator");
      const estimate = await transport.estimate({ method, args, value, recipients });
      const fee = money(estimate.feeWei, "estimated fee");
      if (state.writes >= plan.maxTransactions || fee > money(plan.maxFeePerTransactionWei, "fee cap")
        || money(state.feesWei, "spent fees") + fee > money(plan.maxFeeWei, "fee budget")
        || money(state.spentWei, "spent escrow") + money(value, "value") > money(plan.maxSpendWei, "escrow budget")) return stop("budget_exhausted");
      current.actions[method] = (current.actions[method] ?? 0) + 1;
      state.writes += 1;
      state.feesWei = String(money(state.feesWei, "spent fees") + fee);
      state.spentWei = String(money(state.spentWei, "spent escrow") + money(value, "value"));
      state.pending = { method, hash: null, feeWei: String(fee), valueWei: value, createdAt: now() };
      await save();
      let hash;
      try {
        hash = await transport.send({ method, args, value, recipients, estimate });
      } catch {
        return stop("needs_reconciliation");
      }
      if (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(hash)) return stop("needs_reconciliation");
      state.pending.hash = hash;
      await save();
      return snapshot(state, "transaction finality");
    }

    if (state.pending) {
      if (!state.pending.hash) return stop("needs_reconciliation");
      const result = await transport.transaction(state.pending.hash);
      if (result.hash?.toLowerCase() !== state.pending.hash.toLowerCase() || result.sender?.toLowerCase() !== plan.buyer
        || result.recipient?.toLowerCase() !== plan.contractAddress) throw new Error("Transaction identity mismatch");
      if (!["FINALIZED", "CANCELED"].includes(result.status)) return snapshot(state, "transaction finality");
      const successful = result.status === "FINALIZED" && result.successful === true;
      state.transactions.push({ ...state.pending, successful });
      if (state.pending.method === "create_job") state.current.phase = successful ? "locating" : "funding_failed";
      if (successful && ["settle_job", "resolve_dispute", "recover_job"].includes(state.pending.method)) state.current.awaitingSettlement = true;
      if (successful && state.pending.method === "open_dispute") state.current.awaitingDispute = true;
      state.pending = null;
      await save();
      return snapshot(state, "refreshing job state");
    }

    if (!state.current) {
      if (state.attempts.length >= plan.capabilityIds.length) return stop("exhausted");
      const capabilityId = plan.capabilityIds[state.attempts.length];
      const capability = await transport.read("get_capability", [capabilityId]);
      if (!capability || capability.capability_id !== capabilityId) throw new Error("The next authorized capability could not be verified");
      if (capability.status !== "active" || capability.provider.toLowerCase() === plan.buyer) {
        state.attempts.push({ capabilityId, outcome: "unavailable", accepted: false });
        await save();
        return snapshot(state, "next authorized capability");
      }
      const price = String(capability.price_wei);
      if (typeof capability.price_wei === "number" && !Number.isSafeInteger(capability.price_wei)) throw new Error("Unsafe capability price");
      if (money(price, "capability price") <= 0n) throw new Error("Capability price must be positive");
      if (money(state.spentWei, "spend") + money(price, "price") > money(plan.maxSpendWei, "spend cap")) return stop("budget_exhausted");
      const counts = await transport.read("get_counts", []);
      if (!Number.isSafeInteger(counts.jobs) || counts.jobs < 0) throw new Error("Invalid job counter");
      const nonce = randomUUID();
      const requestJson = requestCommitment({ ...plan, capabilityId, nonce });
      state.current = { capability, price, nonce, requestHash: `sha256:${digest(requestJson)}`, phase: "ready", searchCursor: counts.jobs,
        actions: {}, executed: false, jobId: null, verdict: null };
      await save();
    }
    const current = state.current;
    if (current.phase === "funding_failed") {
      state.attempts.push({ capabilityId: current.capability.capability_id, outcome: "funding_failed", accepted: false });
      state.current = null;
      await save();
      return snapshot(state, "replacement");
    }
    if (current.phase === "ready") return submit("create_job", [current.capability.capability_id, current.requestHash, plan.requestLabel.trim()], current.price);
    if (!current.jobId) {
      const page = await transport.read("get_jobs_page", [current.searchCursor, 50]);
      if (!Array.isArray(page.items) || page.items.length > 50 || !Number.isSafeInteger(page.next_cursor) || page.next_cursor < current.searchCursor) throw new Error("Invalid job search page");
      const job = page.items.find((item) => item.buyer.toLowerCase() === plan.buyer && item.request_hash === current.requestHash);
      current.searchCursor = page.next_cursor;
      if (job) current.jobId = job.job_id;
      await save();
      return snapshot(state, "locating funded job");
    }
    const job = await transport.read("get_job", [current.jobId]);
    if (!job || job.protocol_version !== 2 || job.chain_id !== plan.chainId || job.contract_address !== plan.contractAddress || job.buyer.toLowerCase() !== plan.buyer
      || job.provider.toLowerCase() !== current.capability.provider.toLowerCase() || job.request_hash !== current.requestHash
      || job.job_id !== current.jobId || String(job.escrow_wei) !== current.price
      || job.capability_id !== current.capability.capability_id || job.request_label !== plan.requestLabel.trim()) throw new Error("Funded job does not match the authorized request");
    async function inspectEvidence() {
      if (current.verdict || !job.evidence_id) return;
      const evidence = await transport.read("get_evidence", [job.evidence_id]);
      await verifyEvidencePacket(evidence.packet, job);
      const output = JSON.parse(evidence.packet.output_json);
      const validSchema = new Ajv({ strict: false }).compile(JSON.parse(current.capability.output_schema))(output);
      const packet = evidence.packet;
      const objectiveFailure = !validSchema || packet.response_status !== "success" || packet.response_code < 200 || packet.response_code >= 300
        || packet.latency_ms > current.capability.deadline_seconds * 1000 || Date.parse(packet.completed_at) > Number(job.deadline_at) * 1000;
      current.verdict = objectiveFailure ? { accept: false, objectiveFailure: true } : qualityVerdict(output, plan.qualityChecks);
      current.output = output;
      await save();
    }
    if (job.status === "settled") {
      await inspectEvidence();
      const accepted = current.verdict?.accept === true && Number(job.refund_bps) === 0;
      state.attempts.push({ capabilityId: job.capability_id, jobId: job.job_id, outcome: job.outcome, refundWei: String(job.refund_wei), accepted });
      state.current = null;
      if (accepted) { state.status = "completed"; state.result = current.output; }
      await save();
      return snapshot(state, accepted ? null : "replacement after confirmed settlement");
    }
    const seconds = Math.floor(now() / 1000);
    if (current.awaitingSettlement) return snapshot(state, "settlement indexing");
    if ((["funded", "accepted"].includes(job.status) && seconds >= Number(job.receipt_deadline_at))
      || (["receipt_submitted", "disputed"].includes(job.status) && !job.evidence_id && seconds >= Number(job.evidence_deadline_at))
      || (job.status === "disputed" && seconds >= Number(job.resolution_deadline_at))) return submit("recover_job", [job.job_id], "0", [job.buyer]);
    if (["funded", "accepted"].includes(job.status)) {
      if (current.executed || seconds >= Number(job.deadline_at)) return snapshot(state, "provider delivery or recovery deadline");
      current.executed = true;
      await save();
      try {
        await transport.execute({ capability: current.capability, job, request: plan.request ?? null, nonce: current.nonce });
      } catch {
        current.executionUncertain = true;
        await save();
      }
      return snapshot(state, "provider delivery; execution will not be repeated");
    }
    if (job.status === "disputed") {
      if (!job.evidence_id) return snapshot(state, "evidence publication");
      return submit("resolve_dispute", [job.dispute_id], "0", [job.buyer, job.provider]);
    }
    if (job.status !== "receipt_submitted" || !job.evidence_id || current.awaitingDispute) return snapshot(state, "evidence or dispute indexing");
    await inspectEvidence();
    if (!current.verdict.accept && !current.verdict.objectiveFailure && seconds < Number(job.challenge_deadline_at)) {
      return submit("open_dispute", [job.job_id, "quality", current.verdict.complaint]);
    }
    if (seconds < Number(job.deadline_at)) return snapshot(state, "objective settlement deadline");
    return submit("settle_job", [job.job_id], "0", [job.buyer, job.provider]);
  }) };
}
