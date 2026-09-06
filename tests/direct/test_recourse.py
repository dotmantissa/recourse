import json

import pytest

from .conftest import (
    AFTER_DEADLINE,
    PRICE,
    capability_args,
    create_job,
    evidence_body,
    publish_evidence,
    receipt_hash,
    register_capability,
    set_time,
    submit_receipt,
)


def test_registers_capability_with_request_terms(
    direct_vm, direct_deploy, direct_alice
):
    contract = direct_deploy("contracts/Recourse.py")
    capability_id = register_capability(direct_vm, contract, direct_alice)

    capability = json.loads(contract.get_capability(capability_id))
    assert capability["name"] == "Verified sources"
    assert capability["deadline_seconds"] == 30
    assert capability["price_wei"] == PRICE
    assert capability["collateral_wei"] == 10 * 10**18
    assert capability["reserved_collateral_wei"] == 0


def test_registration_rejects_collateral_below_request_price(
    direct_vm, direct_deploy, direct_alice
):
    contract = direct_deploy("contracts/Recourse.py")
    set_time(direct_vm, "2026-01-01T00:00:00+00:00")
    direct_vm.sender = direct_alice
    direct_vm.value = PRICE - 1
    with direct_vm.expect_revert("collateral must cover"):
        contract.register_capability(*capability_args())


def test_buyer_funds_job_and_provider_receipt_is_committed(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_owner
):
    contract = direct_deploy("contracts/Recourse.py")
    capability_id = register_capability(direct_vm, contract, direct_alice)
    job_id = create_job(direct_vm, contract, direct_bob, capability_id)
    receipt_id = submit_receipt(direct_vm, contract, direct_alice, job_id)

    job = json.loads(contract.get_job(job_id))
    receipt = json.loads(contract.get_receipt(job_id))
    assert job["status"] == "receipt_submitted"
    assert job["escrow_wei"] == PRICE
    assert receipt["receipt_hash"] == receipt_id
    assert receipt_id == receipt_hash(job, receipt)


def test_job_requires_exact_price_and_provider_cannot_buy_own_capability(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = direct_deploy("contracts/Recourse.py")
    capability_id = register_capability(direct_vm, contract, direct_alice)

    set_time(direct_vm, "2026-01-01T00:00:00+00:00")
    direct_vm.sender = direct_bob
    direct_vm.value = PRICE - 1
    with direct_vm.expect_revert("escrow must equal"):
        contract.create_job(capability_id, "request_hash_1", "Find five sources")

    direct_vm.sender = direct_alice
    direct_vm.value = PRICE
    with direct_vm.expect_revert("cannot buy own"):
        contract.create_job(capability_id, "request_hash_1", "Find five sources")


def test_only_provider_can_submit_receipt(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = direct_deploy("contracts/Recourse.py")
    capability_id = register_capability(direct_vm, contract, direct_alice)
    job_id = create_job(direct_vm, contract, direct_bob, capability_id)
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("only provider"):
        contract.submit_receipt(
            job_id,
            "request_hash_1",
            "output_hash_1",
            "success",
            200,
            1200,
            True,
            "2026-01-01T00:00:10+00:00",
            "fake",
        )

def test_missing_receipt_can_be_refunded_after_deadline(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = direct_deploy("contracts/Recourse.py")
    capability_id = register_capability(direct_vm, contract, direct_alice)
    job_id = create_job(direct_vm, contract, direct_bob, capability_id)
    capability = json.loads(contract.get_capability(capability_id))
    assert capability["reserved_collateral_wei"] == PRICE

    set_time(direct_vm, AFTER_DEADLINE)
    direct_vm.sender = direct_bob
    direct_vm.value = 0
    contract.claim_timeout(job_id)

    job = json.loads(contract.get_job(job_id))
    capability = json.loads(contract.get_capability(capability_id))
    assert job["status"] == "settled"
    assert job["refund_bps"] == 10000
    assert job["rule_ids"] == ["response_deadline"]
    assert capability["reserved_collateral_wei"] == 0


def test_collateral_capacity_limits_open_jobs(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = direct_deploy("contracts/Recourse.py")
    capability_id = register_capability(
        direct_vm, contract, direct_alice, value=PRICE
    )
    create_job(direct_vm, contract, direct_bob, capability_id)

    set_time(direct_vm, "2026-01-01T00:00:00+00:00")
    direct_vm.sender = direct_charlie
    direct_vm.value = PRICE
    with direct_vm.expect_revert("fully reserved"):
        contract.create_job(capability_id, "request_hash_2", "Another request")


def test_evidence_mismatch_reverts_before_settlement(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_owner
):
    contract = direct_deploy("contracts/Recourse.py")
    capability_id = register_capability(direct_vm, contract, direct_alice)
    job_id = create_job(direct_vm, contract, direct_bob, capability_id)
    submit_receipt(direct_vm, contract, direct_alice, job_id)
    evidence_id = publish_evidence(
        direct_vm,
        contract,
        direct_owner,
        job_id,
        "https://evidence.recourse.example/job-1",
        json.dumps(
            {
                "job_id": job_id,
                "request_hash": "wrong",
                "output_hash": "output_hash_1",
                "response_status": "success",
                "response_code": 200,
                "latency_ms": 1200,
                "schema_valid": True,
                "completed_at": "2026-01-01T00:00:10+00:00",
                "provider": "wrong-provider",
                "receipt_signature": "provider-signature-1",
                "receipt_hash": "wrong",
            }
        ),
    )

    set_time(direct_vm, AFTER_DEADLINE)
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("does not match"):
        contract.settle_job(job_id)
    assert json.loads(contract.get_job(job_id))["status"] == "receipt_submitted"
    assert json.loads(contract.get_evidence(evidence_id))["evidence_id"] == evidence_id


@pytest.mark.parametrize(
    ("status", "response_code", "latency_ms", "schema_valid", "refund_bps"),
    [
        ("success", 200, 1200, True, 0),
        ("timeout", 504, 31000, False, 10000),
        ("malformed", 200, 1200, False, 7500),
    ],
)
def test_objective_settlement_applies_terms(
    direct_vm,
    direct_deploy,
    direct_alice,
    direct_bob,
    direct_owner,
    status,
    response_code,
    latency_ms,
    schema_valid,
    refund_bps,
):
    contract = direct_deploy("contracts/Recourse.py")
    capability_id = register_capability(direct_vm, contract, direct_alice)
    job_id = create_job(direct_vm, contract, direct_bob, capability_id)
    receipt_id = submit_receipt(
        direct_vm,
        contract,
        direct_alice,
        job_id,
        status,
        response_code,
        latency_ms,
        schema_valid,
    )
    job = json.loads(contract.get_job(job_id))
    receipt = json.loads(contract.get_receipt(job_id))
    assert receipt["receipt_hash"] == receipt_id
    publish_evidence(
        direct_vm,
        contract,
        direct_owner,
        job_id,
        "https://evidence.recourse.example/job-1",
        evidence_body(job, receipt),
    )

    set_time(direct_vm, AFTER_DEADLINE)
    direct_vm.sender = direct_bob
    contract.settle_job(job_id)

    settled = json.loads(contract.get_job(job_id))
    assert settled["status"] == "settled"
    assert settled["refund_bps"] == refund_bps
    assert settled["refund_wei"] == PRICE * refund_bps // 10000
    assert settled["provider_payout_wei"] == PRICE - settled["refund_wei"]


def test_dispute_consensus_decision_refunds_and_marks_reputation(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_owner
):
    contract = direct_deploy("contracts/Recourse.py")
    capability_id = register_capability(direct_vm, contract, direct_alice)
    job_id = create_job(direct_vm, contract, direct_bob, capability_id)
    submit_receipt(direct_vm, contract, direct_alice, job_id)
    job = json.loads(contract.get_job(job_id))
    receipt = json.loads(contract.get_receipt(job_id))
    publish_evidence(
        direct_vm,
        contract,
        direct_owner,
        job_id,
        "https://evidence.recourse.example/job-1",
        evidence_body(job, receipt),
    )

    set_time(direct_vm, AFTER_DEADLINE)
    direct_vm.sender = direct_bob
    dispute_id = contract.open_dispute(
        job_id,
        "quality",
        "The response cites sources that do not support the requested claim.",
    )
    direct_vm.mock_llm(
        r".*GenLayer adjudicator for a request-level service escrow.*",
        json.dumps(
            {
                "decision": "partial_refund",
                "refund_bps": 5000,
                "rule_ids": ["quality_support"],
            }
        ),
    )
    contract.resolve_dispute(dispute_id)

    dispute = json.loads(contract.get_dispute(dispute_id))
    settled = json.loads(contract.get_job(job_id))
    reputation = json.loads(contract.get_reputation(settled["provider"]))
    assert dispute["status"] == "resolved"
    assert dispute["decision"] == "partial_refund"
    assert settled["status"] == "settled"
    assert settled["refund_bps"] == 5000
    assert reputation["disputed_jobs"] == 1
    assert reputation["breached_jobs"] == 1
    assert reputation["reliability_bps"] < 10000


def test_success_receipt_completed_after_deadline_is_a_timeout(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_owner
):
    contract = direct_deploy("contracts/Recourse.py")
    capability_id = register_capability(direct_vm, contract, direct_alice)
    job_id = create_job(direct_vm, contract, direct_bob, capability_id)
    submit_receipt(
        direct_vm,
        contract,
        direct_alice,
        job_id,
        "success",
        200,
        1200,
        True,
        now=AFTER_DEADLINE,
        completed_at=AFTER_DEADLINE,
    )
    job = json.loads(contract.get_job(job_id))
    receipt = json.loads(contract.get_receipt(job_id))
    publish_evidence(
        direct_vm,
        contract,
        direct_owner,
        job_id,
        "https://evidence.recourse.example/job-late",
        evidence_body(job, receipt),
    )

    set_time(direct_vm, AFTER_DEADLINE)
    direct_vm.sender = direct_bob
    contract.settle_job(job_id)
    assert json.loads(contract.get_job(job_id))["outcome"] == "timeout"


def test_provider_cannot_release_success_during_buyer_challenge_window(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_owner
):
    contract = direct_deploy("contracts/Recourse.py")
    capability_id = register_capability(direct_vm, contract, direct_alice)
    job_id = create_job(direct_vm, contract, direct_bob, capability_id)
    submit_receipt(
        direct_vm,
        contract,
        direct_alice,
        job_id,
        now=AFTER_DEADLINE,
        completed_at="2026-01-01T00:00:20+00:00",
    )
    job = json.loads(contract.get_job(job_id))
    receipt = json.loads(contract.get_receipt(job_id))
    publish_evidence(
        direct_vm,
        contract,
        direct_owner,
        job_id,
        "https://evidence.recourse.example/job-challenge",
        evidence_body(job, receipt),
    )

    set_time(direct_vm, AFTER_DEADLINE)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("challenge window"):
        contract.settle_job(job_id)

    direct_vm.sender = direct_bob
    contract.settle_job(job_id)
    assert json.loads(contract.get_job(job_id))["outcome"] == "success"
