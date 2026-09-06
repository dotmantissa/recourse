# { "Depends": "py-genlayer:1zr6nqk597d97kg0dyxg0shhrykx5v02zjgnyrajapy4wlqvfvwh" }

import hashlib
import json
from datetime import datetime, timezone

from genlayer import *


ERROR_EXPECTED = "[EXPECTED]"
ERROR_EXTERNAL = "[EXTERNAL]"
ERROR_TRANSIENT = "[TRANSIENT]"

CAPABILITY_ACTIVE = "active"
CAPABILITY_PAUSED = "paused"
JOB_FUNDED = "funded"
JOB_RECEIPT_SUBMITTED = "receipt_submitted"
JOB_DISPUTED = "disputed"
JOB_SETTLED = "settled"
DISPUTE_OPEN = "open"
DISPUTE_RESOLVED = "resolved"

ALLOWED_RECEIPT_STATUS = ("success", "timeout", "malformed")
ALLOWED_DISPUTE_TYPES = ("quality", "terms")
ALLOWED_DECISIONS = ("release", "partial_refund", "full_refund")
CHALLENGE_WINDOW_SECONDS = 120


class Recourse(gl.Contract):
    """Request-level escrow and GenLayer chargeback settlement."""

    owner: Address
    monitor_operator: Address
    capability_seq: u256
    job_seq: u256
    evidence_seq: u256
    dispute_seq: u256
    capabilities: TreeMap[str, str]
    capability_order: DynArray[str]
    jobs: TreeMap[str, str]
    job_order: DynArray[str]
    receipts: TreeMap[str, str]
    evidence: TreeMap[str, str]
    evidence_order: DynArray[str]
    disputes: TreeMap[str, str]
    dispute_order: DynArray[str]
    reputation: TreeMap[str, str]

    def __init__(self):
        self.owner = gl.message.sender_address
        self.monitor_operator = gl.message.sender_address
        self.capability_seq = u256(0)
        self.job_seq = u256(0)
        self.evidence_seq = u256(0)
        self.dispute_seq = u256(0)

    def _now_epoch(self) -> u256:
        try:
            raw = getattr(gl, "message_raw", None)
            if raw is None:
                raw = getattr(gl.message, "raw", {})
            if isinstance(raw, dict) and raw.get("datetime"):
                value = str(raw["datetime"]).replace("Z", "+00:00")
                parsed = datetime.fromisoformat(value)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                return u256(int(parsed.timestamp()))
            return u256(int(datetime.now(timezone.utc).timestamp()))
        except Exception:
            return u256(0)

    def _date_epoch(self, value: str, field: str) -> u256:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return u256(int(parsed.timestamp()))
        except Exception:
            raise gl.vm.UserError(ERROR_EXPECTED + f" {field} is not an ISO date")

    def _validate_url(self, value: str, field: str) -> str:
        url = str(value).strip()
        if not (url.startswith("https://") or url.startswith("http://")):
            raise gl.vm.UserError(ERROR_EXPECTED + f" {field} must be an http URL")
        if len(url) > 512:
            raise gl.vm.UserError(ERROR_EXPECTED + f" {field} is too long")
        return url

    def _load(self, table: TreeMap, key: str, label: str) -> dict:
        encoded = table.get(str(key).strip(), "")
        if not encoded:
            raise gl.vm.UserError(ERROR_EXPECTED + f" {label} does not exist")
        try:
            value = json.loads(encoded)
        except Exception:
            raise gl.vm.UserError(ERROR_EXPECTED + f" {label} is corrupt")
        if not isinstance(value, dict):
            raise gl.vm.UserError(ERROR_EXPECTED + f" {label} is invalid")
        return value

    def _save(self, table: TreeMap, key: str, value: dict) -> None:
        table[str(key)] = json.dumps(value, sort_keys=True)

    def _hash(self, value: dict) -> str:
        return hashlib.sha256(
            json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()

    def _send_value(self, recipient: Address, amount: u256) -> None:
        if amount > u256(0):
            gl.get_contract_at(recipient).emit_transfer(
                value=amount,
                on="finalized",
            )

    def _address(self, value: str) -> Address:
        text = str(value).lower().replace("0x", "", 1)
        if len(text) != 40:
            raise gl.vm.UserError(ERROR_EXPECTED + " stored address is invalid")
        try:
            return Address(bytes.fromhex(text))
        except Exception:
            raise gl.vm.UserError(ERROR_EXPECTED + " stored address is invalid")

    def _provider_reputation(self, provider: str) -> dict:
        encoded = self.reputation.get(provider, "")
        if encoded:
            return json.loads(encoded)
        return {
            "provider": provider,
            "jobs": 0,
            "successful_jobs": 0,
            "breached_jobs": 0,
            "disputed_jobs": 0,
            "refunded_wei": 0,
            "reliability_bps": 10000,
        }

    def _record_reputation(
        self, provider: str, refund_bps: int, payout_wei: int, disputed: bool
    ) -> None:
        record = self._provider_reputation(provider)
        record["jobs"] = int(record["jobs"]) + 1
        if disputed:
            record["disputed_jobs"] = int(record["disputed_jobs"]) + 1
        if refund_bps == 0:
            record["successful_jobs"] = int(record["successful_jobs"]) + 1
        else:
            record["breached_jobs"] = int(record["breached_jobs"]) + 1
            penalty = max(100, int(refund_bps) // 10)
            record["reliability_bps"] = max(
                0, int(record["reliability_bps"]) - penalty
            )
            record["refunded_wei"] = int(record["refunded_wei"]) + int(payout_wei)
        self.reputation[provider] = json.dumps(record, sort_keys=True)

    def _receipt_core(self, job: dict, receipt: dict) -> dict:
        return {
            "job_id": str(job["job_id"]),
            "request_hash": str(receipt["request_hash"]),
            "output_hash": str(receipt["output_hash"]),
            "response_status": str(receipt["response_status"]),
            "response_code": int(receipt["response_code"]),
            "latency_ms": int(receipt["latency_ms"]),
            "schema_valid": bool(receipt["schema_valid"]),
            "completed_at": str(receipt["completed_at"]),
            "provider": str(job["provider"]),
        }

    def _normalize_evidence(self, url: str) -> dict:
        evidence_url = self._validate_url(url, "evidence_url")

        def fetch() -> dict:
            try:
                response = gl.nondet.web.get(
                    evidence_url,
                    headers={"Accept": "application/json"},
                )
                if response.status >= 500:
                    raise gl.vm.UserError(
                        ERROR_TRANSIENT + f" evidence returned {response.status}"
                    )
                if response.status >= 400:
                    raise gl.vm.UserError(
                        ERROR_EXTERNAL + f" evidence returned {response.status}"
                    )
                body = response.body
                if isinstance(body, str):
                    body = body.encode("utf-8")
                parsed = json.loads(body.decode("utf-8", errors="replace"))
                if not isinstance(parsed, dict):
                    raise gl.vm.UserError(
                        ERROR_EXTERNAL + " evidence must be a JSON object"
                    )
                normalized = {
                    "job_id": str(parsed.get("job_id", "")),
                    "request_hash": str(parsed.get("request_hash", "")),
                    "output_hash": str(parsed.get("output_hash", "")),
                    "response_status": str(parsed.get("response_status", "")),
                    "response_code": int(parsed.get("response_code", -1)),
                    "latency_ms": int(parsed.get("latency_ms", -1)),
                    "schema_valid": bool(parsed.get("schema_valid", False)),
                    "completed_at": str(parsed.get("completed_at", "")),
                    "provider": str(parsed.get("provider", "")),
                    "receipt_signature": str(parsed.get("receipt_signature", "")),
                    "receipt_hash": str(parsed.get("receipt_hash", "")),
                }
                return normalized
            except gl.vm.UserError:
                raise
            except Exception:
                raise gl.vm.UserError(
                    ERROR_EXTERNAL + " evidence could not be parsed"
                )

        return gl.eq_principle.strict_eq(fetch)

    def _verify_evidence(self, job: dict, receipt: dict, evidence_url: str) -> dict:
        evidence = self._normalize_evidence(evidence_url)
        expected_core = self._receipt_core(job, receipt)
        expected_hash = self._hash(expected_core)
        expected = dict(expected_core)
        expected["receipt_signature"] = str(receipt["receipt_signature"])
        expected["receipt_hash"] = expected_hash
        if evidence != expected:
            raise gl.vm.UserError(
                ERROR_EXTERNAL + " evidence does not match the signed receipt"
            )
        return evidence

    def _objective_refund(self, capability: dict, job: dict, evidence: dict) -> tuple:
        completed_epoch = self._date_epoch(
            str(evidence["completed_at"]), "completed_at"
        )
        deadline_missed = int(evidence["latency_ms"]) > int(
            capability["deadline_seconds"]
        ) * 1000
        if (
            evidence["response_status"] == "timeout"
            or deadline_missed
            or completed_epoch > u256(int(job["deadline_at"]))
        ):
            return "timeout", int(capability["timeout_refund_bps"])
        if (
            evidence["response_status"] == "malformed"
            or not bool(evidence["schema_valid"])
            or int(evidence["response_code"]) < 200
            or int(evidence["response_code"]) >= 300
        ):
            return "malformed", int(capability["malformed_refund_bps"])
        if (
            evidence["response_status"] == "success"
            and int(evidence["latency_ms"])
            <= int(capability["deadline_seconds"]) * 1000
        ):
            return "success", 0
        return "breach", 10000

    def _leader_error_agrees(self, leader_result, leader_fn) -> bool:
        if isinstance(leader_result, gl.vm.Return):
            return False
        leader_message = str(getattr(leader_result, "message", ""))
        try:
            leader_fn()
            return False
        except gl.vm.UserError as error:
            validator_message = str(getattr(error, "message", error))
            deterministic = (ERROR_EXPECTED, ERROR_EXTERNAL)
            if validator_message.startswith(deterministic):
                return validator_message == leader_message
            if validator_message.startswith(ERROR_TRANSIENT):
                return leader_message.startswith(ERROR_TRANSIENT)
            return False
        except Exception:
            return False

    def _normalize_decision(self, raw: object, max_refund_bps: int) -> dict:
        if not isinstance(raw, dict):
            raise gl.vm.UserError(ERROR_EXTERNAL + " adjudicator returned non-JSON")
        decision = str(raw.get("decision", "")).lower()
        if decision not in ALLOWED_DECISIONS:
            raise gl.vm.UserError(ERROR_EXTERNAL + " adjudicator decision is invalid")
        refund_bps = int(raw.get("refund_bps", -1))
        if refund_bps < 0 or refund_bps > max_refund_bps:
            raise gl.vm.UserError(ERROR_EXTERNAL + " adjudicator refund is invalid")
        raw_rules = raw.get("rule_ids", [])
        if not isinstance(raw_rules, list):
            raise gl.vm.UserError(ERROR_EXTERNAL + " adjudicator rules are invalid")
        rule_ids = []
        for rule_id in raw_rules:
            value = str(rule_id).strip()
            if value and len(value) <= 48 and value not in rule_ids:
                rule_ids.append(value)
        if decision == "release" and refund_bps != 0:
            raise gl.vm.UserError(ERROR_EXTERNAL + " release must refund zero")
        if decision == "full_refund" and refund_bps != 10000:
            raise gl.vm.UserError(ERROR_EXTERNAL + " full refund must be 100 percent")
        return {
            "decision": decision,
            "refund_bps": refund_bps,
            "rule_ids": rule_ids[:8],
        }

    def _adjudicate(self, capability: dict, job: dict, dispute: dict, evidence: dict):
        prompt = f"""
You are the GenLayer adjudicator for a request-level service escrow.

Decide only from the canonical terms, evidence, and buyer complaint below.
Do not invent facts. A release pays the provider in full. A partial_refund
must use the exact refund percentage justified by a violated rule. A full_refund
uses 10000 basis points. Return JSON only:
{{
  "decision": "release" | "partial_refund" | "full_refund",
  "refund_bps": integer from 0 to 10000,
  "rule_ids": ["short stable rule identifiers"]
}}

Terms:
{json.dumps(capability, sort_keys=True)}

Job:
{json.dumps(job, sort_keys=True)}

Evidence:
{json.dumps(evidence, sort_keys=True)}

Buyer complaint:
{dispute["complaint"]}
"""

        def decide() -> dict:
            raw = gl.nondet.exec_prompt(prompt, response_format="json")
            return self._normalize_decision(raw, 10000)

        def validate(leader_result) -> bool:
            if not isinstance(leader_result, gl.vm.Return):
                return self._leader_error_agrees(leader_result, decide)
            try:
                own = decide()
            except Exception:
                return False
            proposed = leader_result.calldata
            if not isinstance(proposed, dict):
                return False
            return (
                own["decision"] == proposed.get("decision")
                and int(own["refund_bps"]) == int(proposed.get("refund_bps", -1))
                and own["rule_ids"] == proposed.get("rule_ids")
            )

        result = gl.vm.run_nondet_unsafe(decide, validate)
        if isinstance(result, dict):
            return result
        if hasattr(result, "get"):
            try:
                return result.get()
            except TypeError:
                pass
        return result

    def _settle(
        self,
        job: dict,
        capability: dict,
        refund_bps: int,
        outcome: str,
        dispute_id: str,
        rule_ids: list,
    ) -> None:
        amount = int(job["escrow_wei"])
        refund = amount * int(refund_bps) // 10000
        provider_payout = amount - refund
        reserved = int(capability["reserved_collateral_wei"])
        capability["reserved_collateral_wei"] = max(0, reserved - amount)
        self._save(
            self.capabilities,
            str(capability["capability_id"]),
            capability,
        )
        job["status"] = JOB_SETTLED
        job["outcome"] = outcome
        job["refund_bps"] = int(refund_bps)
        job["refund_wei"] = int(refund)
        job["provider_payout_wei"] = int(provider_payout)
        job["dispute_id"] = str(dispute_id)
        job["rule_ids"] = list(rule_ids)
        job["settled_at"] = int(self._now_epoch())
        self._save(self.jobs, job["job_id"], job)
        self._record_reputation(
            str(job["provider"]),
            int(refund_bps),
            int(refund),
            bool(dispute_id),
        )
        if refund > 0:
            self._send_value(self._address(str(job["buyer"])), u256(refund))
        if provider_payout > 0:
            self._send_value(self._address(str(job["provider"])), u256(provider_payout))

    @gl.public.write
    def set_monitor_operator(self, operator: Address) -> None:
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError(ERROR_EXPECTED + " only owner can set monitor")
        self.monitor_operator = operator

    @gl.public.write.payable
    def register_capability(
        self,
        name: str,
        endpoint: str,
        terms: str,
        deadline_seconds: u256,
        output_schema: str,
        timeout_refund_bps: u256,
        malformed_refund_bps: u256,
        price_wei: u256,
    ) -> str:
        clean_name = str(name).strip()
        if not clean_name or len(clean_name) > 120:
            raise gl.vm.UserError(ERROR_EXPECTED + " capability name is required")
        clean_endpoint = self._validate_url(endpoint, "endpoint")
        clean_terms = str(terms).strip()
        if not clean_terms or len(clean_terms) > 2400:
            raise gl.vm.UserError(ERROR_EXPECTED + " capability terms are required")
        clean_schema = str(output_schema).strip()
        if not clean_schema or len(clean_schema) > 6000:
            raise gl.vm.UserError(ERROR_EXPECTED + " output schema is required")
        if deadline_seconds < u256(1) or deadline_seconds > u256(3600):
            raise gl.vm.UserError(
                ERROR_EXPECTED + " deadline must be between 1 and 3600 seconds"
            )
        if timeout_refund_bps > u256(10000) or malformed_refund_bps > u256(10000):
            raise gl.vm.UserError(ERROR_EXPECTED + " refund must be at most 100 percent")
        if price_wei <= u256(0) or gl.message.value < price_wei:
            raise gl.vm.UserError(
                ERROR_EXPECTED + " collateral must cover one request price"
            )

        self.capability_seq += u256(1)
        capability_id = str(int(self.capability_seq))
        capability = {
            "capability_id": capability_id,
            "provider": str(gl.message.sender_address),
            "name": clean_name,
            "endpoint": clean_endpoint,
            "terms": clean_terms,
            "deadline_seconds": int(deadline_seconds),
            "output_schema": clean_schema,
            "timeout_refund_bps": int(timeout_refund_bps),
            "malformed_refund_bps": int(malformed_refund_bps),
            "price_wei": int(price_wei),
            "collateral_wei": int(gl.message.value),
            "reserved_collateral_wei": 0,
            "status": CAPABILITY_ACTIVE,
            "created_at": int(self._now_epoch()),
            "request_count": 0,
        }
        self._save(self.capabilities, capability_id, capability)
        self.capability_order.append(capability_id)
        return capability_id

    @gl.public.write.payable
    def add_collateral(self, capability_id: str) -> None:
        capability = self._load(self.capabilities, capability_id, "capability")
        if str(gl.message.sender_address) != capability["provider"]:
            raise gl.vm.UserError(ERROR_EXPECTED + " only provider can add collateral")
        if gl.message.value <= u256(0):
            raise gl.vm.UserError(ERROR_EXPECTED + " collateral must be positive")
        capability["collateral_wei"] = int(capability["collateral_wei"]) + int(
            gl.message.value
        )
        self._save(self.capabilities, capability_id, capability)

    @gl.public.write
    def withdraw_collateral(self, capability_id: str, amount_wei: u256) -> None:
        capability = self._load(self.capabilities, capability_id, "capability")
        if str(gl.message.sender_address) != capability["provider"]:
            raise gl.vm.UserError(
                ERROR_EXPECTED + " only provider can withdraw collateral"
            )
        amount = int(amount_wei)
        available = int(capability["collateral_wei"]) - int(
            capability["reserved_collateral_wei"]
        )
        if amount <= 0 or amount > available:
            raise gl.vm.UserError(
                ERROR_EXPECTED + " collateral amount is not available"
            )
        capability["collateral_wei"] = int(capability["collateral_wei"]) - amount
        self._save(self.capabilities, capability_id, capability)
        self._send_value(gl.message.sender_address, u256(amount))

    @gl.public.write
    def pause_capability(self, capability_id: str) -> None:
        capability = self._load(self.capabilities, capability_id, "capability")
        if str(gl.message.sender_address) != capability["provider"]:
            raise gl.vm.UserError(ERROR_EXPECTED + " only provider can pause capability")
        if capability["status"] not in (CAPABILITY_ACTIVE, CAPABILITY_PAUSED):
            raise gl.vm.UserError(ERROR_EXPECTED + " capability is closed")
        capability["status"] = (
            CAPABILITY_PAUSED
            if capability["status"] == CAPABILITY_ACTIVE
            else CAPABILITY_ACTIVE
        )
        self._save(self.capabilities, capability_id, capability)

    @gl.public.write.payable
    def create_job(
        self, capability_id: str, request_hash: str, request_label: str
    ) -> str:
        capability = self._load(self.capabilities, capability_id, "capability")
        if capability["status"] != CAPABILITY_ACTIVE:
            raise gl.vm.UserError(ERROR_EXPECTED + " capability is not accepting jobs")
        if str(gl.message.sender_address) == capability["provider"]:
            raise gl.vm.UserError(ERROR_EXPECTED + " provider cannot buy own capability")
        clean_request_hash = str(request_hash).strip().lower()
        if not clean_request_hash or len(clean_request_hash) > 128:
            raise gl.vm.UserError(ERROR_EXPECTED + " request hash is required")
        if gl.message.value != u256(int(capability["price_wei"])):
            raise gl.vm.UserError(ERROR_EXPECTED + " escrow must equal capability price")
        available_collateral = int(capability["collateral_wei"]) - int(
            capability["reserved_collateral_wei"]
        )
        if available_collateral < int(gl.message.value):
            raise gl.vm.UserError(
                ERROR_EXPECTED + " provider collateral is fully reserved"
            )
        label = str(request_label).strip()
        if not label or len(label) > 240:
            raise gl.vm.UserError(ERROR_EXPECTED + " request label is required")

        self.job_seq += u256(1)
        job_id = str(int(self.job_seq))
        now = int(self._now_epoch())
        job = {
            "job_id": job_id,
            "capability_id": str(capability_id),
            "buyer": str(gl.message.sender_address),
            "provider": capability["provider"],
            "request_hash": clean_request_hash,
            "request_label": label,
            "escrow_wei": int(gl.message.value),
            "funded_at": now,
            "deadline_at": now + int(capability["deadline_seconds"]),
            "status": JOB_FUNDED,
            "receipt_hash": "",
            "evidence_id": "",
            "dispute_id": "",
            "outcome": "",
            "refund_bps": 0,
            "refund_wei": 0,
            "provider_payout_wei": 0,
            "rule_ids": [],
        }
        capability["request_count"] = int(capability["request_count"]) + 1
        capability["reserved_collateral_wei"] = int(
            capability["reserved_collateral_wei"]
        ) + int(gl.message.value)
        self._save(self.capabilities, capability_id, capability)
        self._save(self.jobs, job_id, job)
        self.job_order.append(job_id)
        return job_id

    @gl.public.write
    def submit_receipt(
        self,
        job_id: str,
        request_hash: str,
        output_hash: str,
        response_status: str,
        response_code: u256,
        latency_ms: u256,
        schema_valid: bool,
        completed_at: str,
        receipt_signature: str,
    ) -> str:
        job = self._load(self.jobs, job_id, "job")
        if str(gl.message.sender_address) != job["provider"]:
            raise gl.vm.UserError(ERROR_EXPECTED + " only provider can submit receipt")
        if job["status"] != JOB_FUNDED:
            raise gl.vm.UserError(ERROR_EXPECTED + " job is not awaiting a receipt")
        if str(request_hash).strip().lower() != str(job["request_hash"]):
            raise gl.vm.UserError(ERROR_EXPECTED + " receipt request hash is incorrect")
        status = str(response_status).strip().lower()
        if status not in ALLOWED_RECEIPT_STATUS:
            raise gl.vm.UserError(ERROR_EXPECTED + " receipt status is invalid")
        output = str(output_hash).strip().lower()
        signature = str(receipt_signature).strip()
        if not output or len(output) > 128:
            raise gl.vm.UserError(ERROR_EXPECTED + " output hash is required")
        if not signature or len(signature) > 1024:
            raise gl.vm.UserError(ERROR_EXPECTED + " signed receipt is required")
        if response_code > u256(599) or latency_ms > u256(86400000):
            raise gl.vm.UserError(ERROR_EXPECTED + " receipt measurements are invalid")
        completed_epoch = self._date_epoch(completed_at, "completed_at")
        if completed_epoch < u256(int(job["funded_at"])):
            raise gl.vm.UserError(ERROR_EXPECTED + " receipt predates the job")
        if completed_epoch > self._now_epoch():
            raise gl.vm.UserError(ERROR_EXPECTED + " receipt completion is in the future")

        receipt = {
            "job_id": str(job_id),
            "request_hash": str(request_hash).strip().lower(),
            "output_hash": output,
            "response_status": status,
            "response_code": int(response_code),
            "latency_ms": int(latency_ms),
            "schema_valid": bool(schema_valid),
            "completed_at": str(completed_at).strip(),
            "receipt_signature": signature,
        }
        receipt_hash = self._hash(self._receipt_core(job, receipt))
        receipt["receipt_hash"] = receipt_hash
        self._save(self.receipts, str(job_id), receipt)
        job["status"] = JOB_RECEIPT_SUBMITTED
        job["receipt_hash"] = receipt_hash
        job["receipt_submitted_at"] = int(self._now_epoch())
        job["challenge_deadline_at"] = int(self._now_epoch()) + CHALLENGE_WINDOW_SECONDS
        self._save(self.jobs, str(job_id), job)
        return receipt_hash

    @gl.public.write
    def claim_timeout(self, job_id: str) -> None:
        job = self._load(self.jobs, job_id, "job")
        if str(gl.message.sender_address) != job["buyer"]:
            raise gl.vm.UserError(ERROR_EXPECTED + " only buyer can claim timeout")
        if job["status"] != JOB_FUNDED:
            raise gl.vm.UserError(ERROR_EXPECTED + " job is not awaiting a receipt")
        if int(self._now_epoch()) < int(job["deadline_at"]):
            raise gl.vm.UserError(ERROR_EXPECTED + " job deadline has not passed")
        capability = self._load(
            self.capabilities, job["capability_id"], "capability"
        )
        self._settle(
            job,
            capability,
            10000,
            "timeout",
            "",
            ["response_deadline"],
        )

    @gl.public.write
    def publish_evidence(self, job_id: str, evidence_url: str) -> str:
        if gl.message.sender_address != self.monitor_operator:
            raise gl.vm.UserError(ERROR_EXPECTED + " only monitor can publish evidence")
        job = self._load(self.jobs, job_id, "job")
        if job["status"] != JOB_RECEIPT_SUBMITTED:
            raise gl.vm.UserError(ERROR_EXPECTED + " job has no submitted receipt")
        self._validate_url(evidence_url, "evidence_url")
        self.evidence_seq += u256(1)
        evidence_id = str(int(self.evidence_seq))
        record = {
            "evidence_id": evidence_id,
            "job_id": str(job_id),
            "evidence_url": str(evidence_url).strip(),
            "published_at": int(self._now_epoch()),
            "publisher": str(gl.message.sender_address),
        }
        self._save(self.evidence, evidence_id, record)
        self.evidence_order.append(evidence_id)
        job["evidence_id"] = evidence_id
        self._save(self.jobs, str(job_id), job)
        return evidence_id

    @gl.public.write
    def settle_job(self, job_id: str) -> None:
        job = self._load(self.jobs, job_id, "job")
        if job["status"] != JOB_RECEIPT_SUBMITTED:
            raise gl.vm.UserError(ERROR_EXPECTED + " job is not ready to settle")
        if int(self._now_epoch()) < int(job["deadline_at"]):
            raise gl.vm.UserError(ERROR_EXPECTED + " job deadline has not passed")
        evidence_record = self._load(self.evidence, job["evidence_id"], "evidence")
        receipt = self._load(self.receipts, job_id, "receipt")
        capability = self._load(
            self.capabilities, job["capability_id"], "capability"
        )
        evidence = self._verify_evidence(
            job, receipt, evidence_record["evidence_url"]
        )
        outcome, refund_bps = self._objective_refund(capability, job, evidence)
        if (
            refund_bps == 0
            and str(gl.message.sender_address) != str(job["buyer"])
            and int(self._now_epoch()) < int(job["challenge_deadline_at"])
        ):
            raise gl.vm.UserError(
                ERROR_EXPECTED + " buyer challenge window has not ended"
            )
        self._settle(job, capability, refund_bps, outcome, "", [])

    @gl.public.write
    def open_dispute(self, job_id: str, dispute_type: str, complaint: str) -> str:
        job = self._load(self.jobs, job_id, "job")
        if str(gl.message.sender_address) != job["buyer"]:
            raise gl.vm.UserError(ERROR_EXPECTED + " only buyer can open a dispute")
        if job["status"] not in (JOB_RECEIPT_SUBMITTED,):
            raise gl.vm.UserError(ERROR_EXPECTED + " job cannot be disputed")
        kind = str(dispute_type).strip().lower()
        if kind not in ALLOWED_DISPUTE_TYPES:
            raise gl.vm.UserError(ERROR_EXPECTED + " dispute type is invalid")
        text = str(complaint).strip()
        if not text or len(text) > 2400:
            raise gl.vm.UserError(ERROR_EXPECTED + " complaint is required")
        if not job["evidence_id"]:
            raise gl.vm.UserError(ERROR_EXPECTED + " evidence is required first")

        self.dispute_seq += u256(1)
        dispute_id = str(int(self.dispute_seq))
        dispute = {
            "dispute_id": dispute_id,
            "job_id": str(job_id),
            "buyer": job["buyer"],
            "provider": job["provider"],
            "dispute_type": kind,
            "complaint": text,
            "status": DISPUTE_OPEN,
            "decision": "",
            "refund_bps": 0,
            "rule_ids": [],
            "opened_at": int(self._now_epoch()),
            "resolved_at": 0,
        }
        self._save(self.disputes, dispute_id, dispute)
        self.dispute_order.append(dispute_id)
        job["status"] = JOB_DISPUTED
        job["dispute_id"] = dispute_id
        self._save(self.jobs, str(job_id), job)
        return dispute_id

    @gl.public.write
    def resolve_dispute(self, dispute_id: str) -> None:
        dispute = self._load(self.disputes, dispute_id, "dispute")
        if dispute["status"] != DISPUTE_OPEN:
            raise gl.vm.UserError(ERROR_EXPECTED + " dispute is already resolved")
        job = self._load(self.jobs, dispute["job_id"], "job")
        evidence_record = self._load(self.evidence, job["evidence_id"], "evidence")
        receipt = self._load(self.receipts, job["job_id"], "receipt")
        capability = self._load(
            self.capabilities, job["capability_id"], "capability"
        )
        evidence = self._verify_evidence(
            job, receipt, evidence_record["evidence_url"]
        )
        decision = self._adjudicate(capability, job, dispute, evidence)
        if not isinstance(decision, dict):
            raise gl.vm.UserError(ERROR_EXTERNAL + " dispute decision is invalid")
        refund_bps = int(decision["refund_bps"])
        if decision["decision"] == "release":
            refund_bps = 0
        elif decision["decision"] == "full_refund":
            refund_bps = 10000
        dispute["status"] = DISPUTE_RESOLVED
        dispute["decision"] = decision["decision"]
        dispute["refund_bps"] = refund_bps
        dispute["rule_ids"] = decision["rule_ids"]
        dispute["resolved_at"] = int(self._now_epoch())
        self._save(self.disputes, dispute_id, dispute)
        self._settle(
            job,
            capability,
            refund_bps,
            decision["decision"],
            dispute_id,
            decision["rule_ids"],
        )

    @gl.public.view
    def get_capability(self, capability_id: str) -> str:
        return self.capabilities.get(str(capability_id), "")

    @gl.public.view
    def get_capabilities(self) -> str:
        return json.dumps(
            [json.loads(self.capabilities[item]) for item in self.capability_order],
            sort_keys=True,
        )

    @gl.public.view
    def get_job(self, job_id: str) -> str:
        return self.jobs.get(str(job_id), "")

    @gl.public.view
    def get_jobs(self) -> str:
        return json.dumps(
            [json.loads(self.jobs[item]) for item in self.job_order],
            sort_keys=True,
        )

    @gl.public.view
    def get_receipt(self, job_id: str) -> str:
        return self.receipts.get(str(job_id), "")

    @gl.public.view
    def get_evidence(self, evidence_id: str) -> str:
        return self.evidence.get(str(evidence_id), "")

    @gl.public.view
    def get_evidence_records(self) -> str:
        return json.dumps(
            [json.loads(self.evidence[item]) for item in self.evidence_order],
            sort_keys=True,
        )

    @gl.public.view
    def get_dispute(self, dispute_id: str) -> str:
        return self.disputes.get(str(dispute_id), "")

    @gl.public.view
    def get_disputes(self) -> str:
        return json.dumps(
            [json.loads(self.disputes[item]) for item in self.dispute_order],
            sort_keys=True,
        )

    @gl.public.view
    def get_reputation(self, provider: str) -> str:
        return json.dumps(self._provider_reputation(str(provider)), sort_keys=True)

    @gl.public.view
    def get_counts(self) -> str:
        return json.dumps(
            {
                "capabilities": int(self.capability_seq),
                "jobs": int(self.job_seq),
                "evidence": int(self.evidence_seq),
                "disputes": int(self.dispute_seq),
            },
            sort_keys=True,
        )
