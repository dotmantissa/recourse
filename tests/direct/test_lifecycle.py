import json

import pytest

from .conftest import (
    AFTER_DEADLINE, COMPLETED, INVALID_OUTPUT, PRICE, START, VALID_OUTPUT,
    accept_job, capability_args, create_job, evidence_body, mock_json_prompt, publish_evidence,
    register_capability, set_time, submit_receipt,
)


@pytest.fixture
def scenario(direct_vm, direct_deploy, direct_alice, direct_bob):
    direct_vm._chain_id = 61997
    contract = direct_deploy("contracts/Recourse.py")
    capability_id = register_capability(direct_vm, contract, direct_alice)
    job_id = create_job(direct_vm, contract, direct_bob, capability_id)
    return contract, capability_id, job_id


def deliver(direct_vm, contract, provider, job_id, output=VALID_OUTPUT, schema_valid=True):
    submit_receipt(direct_vm, contract, provider, job_id, output=output, schema_valid=schema_valid)
    job = json.loads(contract.get_job(job_id))
    receipt = json.loads(contract.get_receipt(job_id))
    return evidence_body(job, receipt, output=output)


def test_acceptance_is_provider_only_bounded_and_idempotent(scenario, direct_vm, direct_alice, direct_bob):
    contract, _, job_id = scenario
    direct_vm.value = 0
    with direct_vm.expect_revert("only provider"):
        contract.accept_job(job_id)
    accept_job(direct_vm, contract, direct_alice, job_id)
    job = json.loads(contract.get_job(job_id))
    assert job["status"] == "accepted"
    assert job["deadline_at"] - job["accepted_at"] == 330
    assert job["receipt_deadline_at"] - job["deadline_at"] == 300
    set_time(direct_vm, AFTER_DEADLINE)
    contract.accept_job(job_id)
    assert json.loads(contract.get_job(job_id)) == job


def test_expired_funding_cannot_be_accepted(scenario, direct_vm, direct_alice):
    contract, _, job_id = scenario
    with direct_vm.expect_revert("acceptance window"):
        accept_job(direct_vm, contract, direct_alice, job_id, "2026-01-01T00:30:00+00:00")


@pytest.mark.parametrize("accepted,expiry", [(False, "00:30:00"), (True, "00:10:30")])
def test_permissionless_delivery_recovery(scenario, direct_vm, direct_alice, direct_charlie, accepted, expiry):
    contract, capability_id, job_id = scenario
    if accepted:
        accept_job(direct_vm, contract, direct_alice, job_id)
    direct_vm.sender = direct_charlie
    direct_vm.value = 0
    with direct_vm.expect_revert("no expired recovery"):
        contract.recover_job(job_id)
    set_time(direct_vm, f"2026-01-01T{expiry}+00:00")
    contract.recover_job(job_id)
    job = json.loads(contract.get_job(job_id))
    assert job["refund_wei"] == PRICE
    assert job["provider_payout_wei"] == 0
    assert json.loads(contract.get_capability(capability_id))["reserved_collateral_wei"] == 0
    with direct_vm.expect_revert("no expired recovery"):
        contract.recover_job(job_id)


def test_missing_evidence_recovers_even_after_dispute(scenario, direct_vm, direct_alice, direct_bob, direct_charlie):
    contract, _, job_id = scenario
    submit_receipt(direct_vm, contract, direct_alice, job_id)
    direct_vm.sender = direct_bob
    dispute_id = contract.open_dispute(job_id, "quality", "No evidence available")
    set_time(direct_vm, "2026-01-01T00:10:10+00:00")
    direct_vm.sender = direct_charlie
    contract.recover_job(job_id)
    assert json.loads(contract.get_job(job_id))["refund_wei"] == PRICE
    assert json.loads(contract.get_dispute(dispute_id))["status"] == "resolved"
    assert json.loads(contract.get_job(job_id))["rule_ids"] == ["missing_evidence"]


def test_adjudication_failure_has_bounded_recovery(scenario, direct_vm, direct_alice, direct_bob, direct_charlie):
    contract, _, job_id = scenario
    body = deliver(direct_vm, contract, direct_alice, job_id)
    publish_evidence(direct_vm, contract, direct_charlie, job_id, "https://evidence.recourse.example/1", body)
    direct_vm.sender = direct_bob
    dispute_id = contract.open_dispute(job_id, "quality", "The citation is insufficient")
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("no expired recovery"):
        contract.recover_job(job_id)
    set_time(direct_vm, "2026-01-01T00:36:00+00:00")
    contract.recover_job(job_id)
    assert json.loads(contract.get_dispute(dispute_id))["rule_ids"] == ["adjudication_timeout"]
    assert json.loads(contract.get_job(job_id))["refund_wei"] == PRICE
    with direct_vm.expect_revert("already resolved"):
        contract.resolve_dispute(dispute_id)


@pytest.mark.parametrize("field,value", [
    ("request_json", "{}"), ("output_json", "[]"), ("chain_id", 1),
    ("contract_address", "0x" + "11" * 20), ("capability_id", "2"),
    ("schema_valid", 1), pytest.param("request_json", "x" * 65537, id="oversize-request"),
])
def test_evidence_rejects_tampered_content_or_domain(scenario, direct_vm, direct_alice, direct_charlie, field, value):
    contract, _, job_id = scenario
    packet = json.loads(deliver(direct_vm, contract, direct_alice, job_id))
    packet[field] = value
    with direct_vm.expect_revert():
        publish_evidence(direct_vm, contract, direct_charlie, job_id, "https://evidence.recourse.example/1", json.dumps(packet))
    assert json.loads(contract.get_job(job_id))["evidence_id"] == ""


def test_evidence_is_permissionless_immutable_and_cached(scenario, direct_vm, direct_alice, direct_charlie):
    contract, _, job_id = scenario
    body = deliver(direct_vm, contract, direct_alice, job_id)
    url = "https://evidence.recourse.example/1"
    evidence_id = publish_evidence(direct_vm, contract, direct_charlie, job_id, url, body)
    assert "packet" not in json.loads(contract.get_evidence_page(0, 100))["items"][0]
    assert json.loads(contract.get_evidence(evidence_id))["packet"]["output_json"]
    direct_vm.clear_mocks()
    assert contract.publish_evidence(job_id, url) == evidence_id
    with direct_vm.expect_revert("immutable"):
        contract.publish_evidence(job_id, url + "-changed")
    set_time(direct_vm, "2026-01-01T00:08:00+00:00")
    contract.settle_job(job_id)
    assert json.loads(contract.get_job(job_id))["outcome"] == "success"


@pytest.mark.parametrize("output,assertion,refund", [(INVALID_OUTPUT, True, 7500), (VALID_OUTPUT, False, 0)])
def test_schema_is_verified_from_content_not_provider_assertion(scenario, direct_vm, direct_alice, direct_bob, output, assertion, refund):
    contract, _, job_id = scenario
    body = deliver(direct_vm, contract, direct_alice, job_id, output, assertion)
    publish_evidence(direct_vm, contract, direct_bob, job_id, "https://evidence.recourse.example/1", body)
    contract.settle_job(job_id)
    assert json.loads(contract.get_job(job_id))["refund_bps"] == refund


@pytest.mark.parametrize("refund", [0, 2500, 5000, 7500, 10000])
@pytest.mark.parametrize("caller", ["provider", "stranger"])
def test_every_partial_payout_protects_buyer_challenge(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, refund, caller):
    contract = direct_deploy("contracts/Recourse.py")
    args = capability_args()
    args[6] = refund
    set_time(direct_vm, START)
    direct_vm.sender = direct_alice
    direct_vm.value = PRICE
    capability_id = contract.register_capability(*args)
    job_id = create_job(direct_vm, contract, direct_bob, capability_id)
    body = deliver(direct_vm, contract, direct_alice, job_id, INVALID_OUTPUT)
    publish_evidence(direct_vm, contract, direct_charlie, job_id, "https://evidence.recourse.example/1", body)
    direct_vm.sender = direct_alice if caller == "provider" else direct_charlie
    if refund < 10000:
        with direct_vm.expect_revert("challenge window"):
            contract.settle_job(job_id)
        set_time(direct_vm, "2026-01-01T00:08:00+00:00")
    transfers = []

    def capture_transfer(vm, request):
        if "EmitInternalMessage" in request:
            transfers.append(request["EmitInternalMessage"])
            return {"ok": None}

    direct_vm._gl_call_hook = capture_transfer
    contract.settle_job(job_id)
    expected = {}
    if refund:
        expected[bytes(direct_bob)] = PRICE * refund // 10000
    if refund < 10000:
        expected[bytes(direct_alice)] = PRICE - PRICE * refund // 10000
    assert {item["address"].as_bytes: item["value"] for item in transfers} == expected
    assert all(item["on"] == "finalized" for item in transfers)
    assert sum(item["value"] for item in transfers) == PRICE
    with direct_vm.expect_revert("not ready"):
        contract.settle_job(job_id)
    assert len(transfers) == len(expected)


def test_bounded_pagination_and_empty_history(scenario, direct_vm):
    contract, _, _ = scenario
    page = json.loads(contract.get_jobs_page(0, 1))
    assert len(page["items"]) == 1
    assert page["next_cursor"] == page["total"] == 1
    assert json.loads(contract.get_jobs_page(100, 1))["items"] == []
    assert json.loads(contract.get_evidence_page(0, 10))["total"] == 0
    for limit in (0, 101):
        with direct_vm.expect_revert("page limit"):
            contract.get_jobs_page(0, limit)


@pytest.mark.parametrize("schema", [{"type": "number"}, {"pattern": ".*"}, {"items": {"type": "number"}}, {"minItems": -1}])
def test_unsupported_schema_rejected(direct_vm, direct_deploy, direct_alice, schema):
    contract = direct_deploy("contracts/Recourse.py")
    args = capability_args()
    args[4] = json.dumps(schema)
    set_time(direct_vm, START)
    direct_vm.sender = direct_alice
    direct_vm.value = PRICE
    with direct_vm.expect_revert():
        contract.register_capability(*args)


def semantic_decision():
    return {
        "decision": "partial_refund", "refund_bps": 5000, "rule_ids": ["quality_support"],
        "rationale": "The delivered passage does not substantiate the requested sources.",
        "supporting_quotes": [{"source": "output", "quote": "Supporting passage"}],
    }


@pytest.fixture
def semantic_scenario(scenario, direct_vm, direct_alice, direct_bob):
    contract, capability_id, job_id = scenario
    body = deliver(direct_vm, contract, direct_alice, job_id)
    publish_evidence(direct_vm, contract, direct_bob, job_id, "https://evidence.recourse.example/1", body)
    dispute_id = contract.open_dispute(job_id, "quality", "The sources do not support the claim")
    return contract, capability_id, job_id, dispute_id


def test_semantic_validator_independently_checks_decision_and_explanation(semantic_scenario, direct_vm):
    contract, _, _, dispute_id = semantic_scenario
    mock_json_prompt(direct_vm, "GenLayer adjudicator", semantic_decision())
    contract.resolve_dispute(dispute_id)
    direct_vm.clear_mocks()
    mock_json_prompt(direct_vm, "Independently check", {"approve": True})
    mock_json_prompt(direct_vm, "GenLayer adjudicator", semantic_decision())
    assert direct_vm.run_validator() is True
    changed = {**semantic_decision(), "refund_bps": 7500}
    assert direct_vm.run_validator(leader_result=changed) is False
    changed = {**semantic_decision(), "supporting_quotes": [{"source": "output", "quote": "fabricated quote"}]}
    assert direct_vm.run_validator(leader_result=changed) is False
    direct_vm.clear_mocks()
    mock_json_prompt(direct_vm, "Independently check", {"approve": False})
    mock_json_prompt(direct_vm, "GenLayer adjudicator", semantic_decision())
    assert direct_vm.run_validator() is False


@pytest.mark.parametrize("change", [
    {"refund_bps": 3500}, {"refund_bps": True}, {"rule_ids": ["invented"]},
    {"rationale": ""}, {"supporting_quotes": []},
    {"supporting_quotes": [{"source": "output", "quote": "fabrication"}]},
])
def test_semantic_decisions_fail_closed(semantic_scenario, direct_vm, change):
    contract, _, job_id, dispute_id = semantic_scenario
    mock_json_prompt(direct_vm, "GenLayer adjudicator", {**semantic_decision(), **change})
    with direct_vm.expect_revert():
        contract.resolve_dispute(dispute_id)
    assert json.loads(contract.get_job(job_id))["status"] == "disputed"
