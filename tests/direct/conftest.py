import hashlib
import json
import sys


PRICE = 2 * 10**18
COLLATERAL = 10 * 10**18
START = "2026-01-01T00:00:00+00:00"
AFTER_DEADLINE = "2026-01-01T00:06:00+00:00"
COMPLETED = "2026-01-01T00:00:10+00:00"
VALID_OUTPUT = [{"title": "Verified source", "url": "https://example.com/source", "citation": "Supporting passage"}]
INVALID_OUTPUT = {"error": "No sources returned"}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def document_hash(value):
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def mock_json_prompt(direct_vm, pattern, value):
    direct_vm.mock_llm(pattern, json.dumps(json.dumps(value)))


def request_document(chain_id, contract_address, capability_id, label="Find five sources"):
    return canonical({
        "version": "recourse-request-v3", "chain_id": chain_id,
        "contract_address": contract_address, "capability_id": capability_id,
        "request_label": label, "nonce": "fixture-nonce-1", "request": {"query": "Find five sources"},
        "disclosure": "public",
    })


def set_time(direct_vm, value):
    direct_vm.warp(value)
    gl_module = sys.modules.get("genlayer.gl")
    if gl_module is not None and getattr(gl_module, "message_raw", None) is not None:
        gl_module.message_raw["datetime"] = value
    message_module = sys.modules.get("genlayer.message")
    if message_module is not None and isinstance(getattr(message_module, "raw", None), dict):
        message_module.raw["datetime"] = value


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
    request = request_document(direct_vm._chain_id, "0x" + bytes(direct_vm._contract_address).hex(), capability_id)
    return contract.create_job(capability_id, document_hash(request), "Find five sources")


def accept_job(direct_vm, contract, provider, job_id, now=START):
    set_time(direct_vm, now)
    direct_vm.sender = provider
    direct_vm.value = 0
    contract.accept_job(job_id)


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
    output=None,
):
    if json.loads(contract.get_job(job_id))["status"] == "funded":
        accept_job(direct_vm, contract, provider, job_id)
    set_time(direct_vm, now)
    direct_vm.sender = provider
    direct_vm.value = 0
    return contract.submit_receipt(
        job_id,
        json.loads(contract.get_job(job_id))["request_hash"],
        document_hash(canonical(output if output is not None else (VALID_OUTPUT if schema_valid else INVALID_OUTPUT))),
        status,
        response_code,
        latency_ms,
        schema_valid,
        completed_at,
        "provider-signature-1",
    )


def receipt_core(job, receipt):
    return {
        "version": "recourse-receipt-v2",
        "chain_id": job["chain_id"],
        "contract_address": job["contract_address"],
        "capability_id": job["capability_id"],
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


def evidence_body(job, receipt, output=None):
    payload = receipt_core(job, receipt)
    payload["receipt_signature"] = receipt["receipt_signature"]
    payload["receipt_hash"] = receipt_hash(job, receipt)
    payload["request_json"] = request_document(job["chain_id"], job["contract_address"], job["capability_id"], job["request_label"])
    payload["output_json"] = canonical(output if output is not None else (VALID_OUTPUT if receipt["schema_valid"] else INVALID_OUTPUT))
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
