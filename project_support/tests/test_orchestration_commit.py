"""OR-03 실행 확정·중단 통보 of the constellation operations stand-in, its endpoint and the forwarder."""
import httpx
import pytest
from fastapi.testclient import TestClient

from communication.external.orchestration import RemoteOrchestration
from digital_twin.contracts.orchestration import OrchestrationUnavailable
from operations_software.orchestration import OrchestrationStandIn
from user_application.web.application import create_app

T0 = "2026-09-08T00:00:00Z"
TASKS = [{"id": "MSN-0001-T01", "kind": "crosslink", "satellite": "S1", "counterpart": "S2", "start": "2026-09-08T00:00:00Z", "end": "2026-09-08T00:01:36Z"},
         {"id": "MSN-0001-T02", "kind": "crosslink", "satellite": "S2", "counterpart": "S3", "start": "2026-09-08T00:01:41Z", "end": "2026-09-08T00:03:17Z"}]


def test_stand_in_records_committed_plans_and_releases_them_on_abort():
    module = OrchestrationStandIn()
    answer = module.commit({"time": T0, "mission_id": "MSN-0001", "decision": "commit", "version": 2, "tasks": TASKS})
    assert answer["accepted"] is True and answer["held_tasks"] == 2 and answer["sequence"] == 1
    status = module.status()
    assert status["committed"] == {"MSN-0001": {"version": 2, "tasks": 2}}
    assert module.commit({"time": T0, "mission_id": "MSN-0001", "decision": "abort"})["held_tasks"] == 0
    assert module.status()["committed"] == {}
    with pytest.raises(ValueError):
        module.commit({"time": T0, "mission_id": "", "decision": "commit"})
    with pytest.raises(ValueError):
        module.commit({"time": T0, "mission_id": "MSN-0001", "decision": "maybe"})
    with pytest.raises(ValueError):
        module.commit({"time": T0, "mission_id": "MSN-0001", "decision": "commit", "tasks": [{"satellite": "S1", "start": "2026-09-08T00:02:00Z", "end": "2026-09-08T00:01:00Z"}]})


def test_commit_endpoint_and_status_expose_the_confirmed_plan():
    with TestClient(create_app()) as client:
        response = client.post("/api/orchestration/commit", json={"time": T0, "mission_id": "MSN-0007", "decision": "commit", "version": 1, "tasks": TASKS})
        assert response.status_code == 200 and response.json()["held_tasks"] == 2
        assert client.get("/api/orchestration/status").json()["committed"]["MSN-0007"]["tasks"] == 2
        assert client.post("/api/orchestration/commit", json={"time": T0, "mission_id": "MSN-0007", "decision": "later"}).status_code == 422


def test_remote_forwarder_relays_commit_and_reports_outages():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path.endswith("/commit"):
            return httpx.Response(200, json={"accepted": True, "held_tasks": 2, "sequence": 9})
        return httpx.Response(500)

    remote = RemoteOrchestration("http://module.example", client=httpx.Client(base_url="http://module.example", transport=httpx.MockTransport(handler)))
    assert remote.commit({"time": T0, "mission_id": "MSN-0001", "decision": "commit", "tasks": TASKS})["sequence"] == 9
    with pytest.raises(OrchestrationUnavailable):
        remote.plan({"time": T0})
    assert calls == ["/api/orchestration/commit", "/api/orchestration/plan"]
