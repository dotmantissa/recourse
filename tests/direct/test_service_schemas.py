import copy
import json
from pathlib import Path

import pytest

from .conftest import (
    AFTER_DEADLINE, COLLATERAL, PRICE, START, create_job, evidence_body,
    publish_evidence, set_time, submit_receipt,
)


ROOT = Path(__file__).resolve().parents[2]
AGENTS = json.loads((ROOT / "agents/manifest.json").read_text())["agents"]
FIXTURES = json.loads((ROOT / "tests/fixtures/services.json").read_text())


@pytest.mark.parametrize("agent", AGENTS, ids=lambda agent: agent["slug"])
@pytest.mark.parametrize("malformed", [False, True], ids=["valid", "nested-invalid"])
def test_service_schema_controls_actual_settlement(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, agent, malformed
):
    direct_vm._chain_id = 61997
    contract = direct_deploy("contracts/Recourse.py")
    set_time(direct_vm, START)
    direct_vm.sender = direct_alice
    direct_vm.value = COLLATERAL
    capability_id = contract.register_capability(
        agent["name"], f"https://provider.example/agents/{agent['slug']}/execute",
        agent["terms"], agent["deadline_seconds"], json.dumps(agent["output_schema"]),
        agent["timeout_refund_bps"], agent["malformed_refund_bps"], PRICE,
    )
    fixture = FIXTURES[agent["slug"]]
    output = copy.deepcopy(fixture["output"])
    if malformed:
        target = output
        for key in fixture["invalid_path"][:-1]:
            target = target[key]
        target[fixture["invalid_path"][-1]] = fixture["invalid_value"]
    job_id = create_job(direct_vm, contract, direct_bob, capability_id)
    submit_receipt(direct_vm, contract, direct_alice, job_id, output=output, schema_valid=True)
    job = json.loads(contract.get_job(job_id))
    receipt = json.loads(contract.get_receipt(job_id))
    packet = evidence_body(job, receipt, output=output)
    publish_evidence(direct_vm, contract, direct_charlie, job_id, "https://evidence.recourse.example/packet", packet)
    set_time(direct_vm, AFTER_DEADLINE)
    direct_vm.sender = direct_bob
    contract.settle_job(job_id)
    settled = json.loads(contract.get_job(job_id))
    assert settled["refund_bps"] == (agent["malformed_refund_bps"] if malformed else 0)
    assert settled["refund_wei"] == PRICE * settled["refund_bps"] // 10000
