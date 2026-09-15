import json

import pytest
from glsim.consensus import run_consensus
from glsim.engine import SimEngine
from glsim.state import StateStore, TxStatus

from tests.direct.conftest import PRICE, mock_json_prompt, set_time
from tests.direct.test_lifecycle import semantic_decision


@pytest.mark.parametrize("approval", [True, False])
def test_three_validator_semantic_consensus_and_rollback(semantic_scenario, direct_vm, approval):
    contract, _, job_id, dispute_id = semantic_scenario
    engine = SimEngine(StateStore(chain_id=61997))
    engine.vm = direct_vm
    engine._storages["contract"] = direct_vm._storage
    mock_json_prompt(direct_vm, "Independently check", {"approve": approval})
    mock_json_prompt(direct_vm, "GenLayer adjudicator", semantic_decision())
    before = contract.get_job(job_id)
    descriptor = contract.__dict__["__type_desc__"]

    def refresh_instance():
        from genlayer.storage import ROOT_SLOT_ID
        contract._instance = descriptor.get(direct_vm._storage.get_store_slot(ROOT_SLOT_ID), 0)

    def execute():
        refresh_instance()
        return contract.resolve_dispute(dispute_id), b""

    result = run_consensus(engine, execute, num_validators=3, max_rotations=2)
    refresh_instance()
    assert result.votes == ["agree" if approval else "disagree"] * 3
    if approval:
        assert result.status == TxStatus.FINALIZED
        assert result.error is None
        job = json.loads(contract.get_job(job_id))
        assert job["status"] == "settled"
        assert job["refund_wei"] == PRICE // 2
    else:
        assert result.status == TxStatus.UNDETERMINED
        assert result.rotation == 1
        assert contract.get_job(job_id) == before
        assert json.loads(contract.get_dispute(dispute_id))["status"] == "open"
        set_time(direct_vm, "2026-01-01T01:00:00+00:00")
        contract.recover_job(job_id)
        assert json.loads(contract.get_job(job_id))["refund_wei"] == PRICE
