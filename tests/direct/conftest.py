import hashlib
import json
import sys


PRICE = 2 * 10**18
COLLATERAL = 10 * 10**18
START = "2026-01-01T00:00:00+00:00"
AFTER_DEADLINE = "2026-01-01T00:01:00+00:00"
COMPLETED = "2026-01-01T00:00:10+00:00"


def set_time(direct_vm, value):
    direct_vm.warp(value)
    gl_module = sys.modules.get("genlayer.gl")
    if gl_module is not None and getattr(gl_module, "message_raw", None) is not None:
        gl_module.message_raw["datetime"] = value


def capability_args(endpoint="https://research.example.com/v1/sources"):
    return [
        "Verified sources",
        endpoint,
        "Return five verified sources in JSON within the deadline.",
        30,
        '{"type":"array","items":{"type":"object","required":["title","url","citation"]}}',
        10000,
        7500,
        PRICE,
    ]


def register_capability(direct_vm, contract, provider, value=COLLATERAL):
    set_time(direct_vm, START)
    direct_vm.sender = provider
    direct_vm.value = value
    return contract.register_capability(*capability_args())


def create_job(direct_vm, contract, buyer, capability_id, value=PRICE):
    set_time(direct_vm, START)
    direct_vm.sender = buyer
    direct_vm.value = value
    return contract.create_job(capability_id, "request_hash_1", "Find five sources")


def submit_receipt(
    direct_vm,
    contract,
    provider,
    job_id,
    status="success",
    response_code=200,
    latency_ms=1200,
    schema_valid=True,
    now=COMPLETED,
    completed_at=COMPLETED,
):
    set_time(direct_vm, now)
    direct_vm.sender = provider
    direct_vm.value = 0
    return contract.submit_receipt(
        job_id,
        "request_hash_1",
        "output_hash_1",
        status,
        response_code,
        latency_ms,
        schema_valid,
        completed_at,
        "provider-signature-1",
    )


def receipt_core(job, receipt):
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


def receipt_hash(job, receipt):
    encoded = json.dumps(
        receipt_core(job, receipt),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def evidence_body(job, receipt):
    payload = receipt_core(job, receipt)
    payload["receipt_signature"] = receipt["receipt_signature"]
    payload["receipt_hash"] = receipt_hash(job, receipt)
    return json.dumps(payload, sort_keys=True)


def publish_evidence(
    direct_vm, contract, monitor, job_id, evidence_url, body, now=AFTER_DEADLINE
):
    set_time(direct_vm, now)
    direct_vm.sender = monitor
    direct_vm.value = 0
    direct_vm.mock_web(
        r"https://evidence\.recourse\.example/.*",
        {"status": 200, "body": body},
    )
    return contract.publish_evidence(job_id, evidence_url)
