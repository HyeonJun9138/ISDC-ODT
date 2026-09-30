"""Accepted SDC deployments, isolated ICD scopes and SIM production regression tests."""
from copy import deepcopy

import httpx
import pytest
from fastapi.testclient import TestClient

from user_application.web.application import create_app


def node(node_id="SDC-A", *, storage=True, camera=False, mode="nominal"):
    equipment = [{"id": "store", "catalog": "dtn_store", "enabled": True}] if storage else []
    if camera:
        equipment.append({"id": "camera", "catalog": "eo_camera", "enabled": True})
    return {"id": node_id, "name": f"이름 {node_id}", "mode": mode, "equipment": equipment}


def deploy(client, nodes, deployment_id="deployment-a", revision=0):
    return client.post("/api/data-management/deployment", json={"deployment_id": deployment_id, "expected_revision": revision, "nodes": nodes})


def advance(client, seconds):
    while seconds > 0:
        step = min(seconds, 128)
        response = client.post("/api/runtime/control", json={"action": "step", "speed": step})
        assert response.status_code == 200
        seconds -= step


def test_default_dashboard_is_empty_and_not_evaluated():
    with TestClient(create_app()) as client:
        result = client.get("/api/data-management/dashboard").json()
        assert result["nodes"] == []
        assert result["objects"]["items"] == []
        assert result["events"]["items"] == []
        assert result["overview"]["jobs"] == []
        assert result["overview"]["capacity"]["used_ratio"] is None
        assert result["overview"]["stability"]["score"] is None
        assert all(value is None for value in result["overview"]["stability"]["components"].values())
        assert result["deployment"]["deployment_id"] is None
        assert client.post("/api/data-management/console/snapshot").status_code == 409


def test_deployment_is_idempotent_owned_copy_and_revision_checked():
    app = create_app()
    with TestClient(app) as client:
        original = node()
        response = deploy(client, [original])
        assert response.status_code == 200
        accepted = response.json()
        assert accepted["revision"] == 1 and accepted["nodes"] == [original]
        assert deploy(client, [original]).json() == accepted
        original["name"] = "다른 이름"
        assert deploy(client, [original]).status_code == 409
        assert deploy(client, [original], "other", 0).status_code == 409
        assert client.get("/api/data-management/deployment").json() == accepted
        owned = app.state.runtime.data_deployment()
        owned["nodes"][0]["equipment"].clear()
        assert app.state.runtime.data_deployment()["nodes"][0]["equipment"]


@pytest.mark.parametrize("nodes", [[node(), node()], [dict(node(), mode="oops")], [dict(node(), equipment=[{"id": "x", "catalog": "dtn_store", "enabled": "yes"}])], [dict(node(), capacity_gb=-1)], [node(str(i)) for i in range(241)]])
def test_invalid_deployment_does_not_change_server(nodes):
    with TestClient(create_app()) as client:
        assert deploy(client, nodes).status_code in (400, 422)
        assert client.get("/api/data-management/deployment").json()["revision"] == 0


def test_products_follow_equipment_without_history_or_fixed_samples():
    with TestClient(create_app()) as client:
        client.post("/api/runtime/control", json={"action": "pause"})
        accepted = deploy(client, [node(camera=True), node("SDC-B"), node("SDC-C", storage=False)]).json()
        first = client.get("/api/data-management/dashboard").json()
        assert first["objects"]["total"] == 0
        roster = {item["id"]: item for item in first["nodes"]}
        assert set(roster) == {"SDC-A", "SDC-B", "SDC-C"}
        assert roster["SDC-A"]["capacity_gb"] == 2000
        assert roster["SDC-C"]["capacity_gb"] == 0 and not roster["SDC-C"]["available"]
        assert roster["SDC-C"]["reason"] == "저장소 미설정"
        assert roster["SDC-C"]["used_ratio"] is None
        advance(client, 100)
        result = client.get("/api/data-management/dashboard").json()
        products = result["objects"]["items"]
        assert {item["source"] for item in products} == {"SDC-A", "SDC-B"}
        assert {item["class"] for item in products} == {"telemetry", "imagery"}
        assert all(item["source"] == "SDC-A" and 400 <= item["size_mb"] <= 1200 for item in products if item["class"] == "imagery")
        assert all(item["created_s"] > first["runtime"]["elapsed_seconds"] for item in products)
        assert result["deployment"]["scope_id"] == accepted["scope_id"]


def test_redeploy_recall_reset_and_old_commands_do_not_mix_scopes():
    with TestClient(create_app()) as client:
        first = deploy(client, [node()]).json()
        advance(client, 40)
        assert client.get("/api/data-management/dashboard").json()["objects"]["total"] > 0
        second = deploy(client, [node("SDC-B")], "deployment-b", 1).json()
        assert second["scope_id"] != first["scope_id"]
        fresh = client.get("/api/data-management/dashboard").json()
        assert fresh["objects"]["total"] == 0 and fresh["events"]["items"] == []
        assert client.post("/api/data-management/console/action", json={"action": "verify", "scope_id": first["scope_id"]}).status_code == 409
        client.post("/api/runtime/control", json={"action": "reset"})
        reset = client.get("/api/data-management/dashboard").json()
        assert reset["deployment"]["scope_id"] != second["scope_id"]
        assert reset["objects"]["total"] == 0
        recalled = deploy(client, [], "deployment-empty", 2).json()
        advance(client, 300)
        empty = client.get("/api/data-management/dashboard").json()
        assert empty["nodes"] == [] and empty["objects"]["items"] == [] and empty["events"]["items"] == []
        assert client.post("/api/data-management/console/action", json={"action": "verify", "scope_id": recalled["scope_id"]}).status_code == 409


def test_remote_without_scope_contract_cannot_accept_deployment():
    from communication.external.data_management import RemoteDataManagement
    calls = []
    def transport(request):
        calls.append(request.method)
        return httpx.Response(200, json={"reachable": True, "module": "data_management"})
    remote = RemoteDataManagement("http://example.test", client=httpx.Client(base_url="http://example.test", transport=httpx.MockTransport(transport)))
    with TestClient(create_app(data_management=remote)) as client:
        assert deploy(client, [node()]).status_code == 503
        assert client.get("/api/data-management/deployment").json()["revision"] == 0
        result = client.get("/api/data-management/dashboard").json()
        assert not result["module"]["reachable"] and result["overview"] is None
        assert "POST" not in calls, "incompatible shared modules must never be mutated"


def test_names_and_multiple_storage_equipment_are_preserved():
    with TestClient(create_app()) as client:
        configured = node()
        configured["name"] = "  원래 SDC 이름  "
        configured["equipment"].append({"id": "second", "catalog": "dtn_store", "enabled": True})
        response = deploy(client, [configured])
        assert response.json()["nodes"] == [configured]
        assert client.get("/api/data-management/dashboard").json()["nodes"][0]["capacity_gb"] == 4000


@pytest.mark.parametrize("mode,enabled", [("nominal", False), ("safe", True)])
def test_disabled_or_safe_mode_storage_never_generates(mode, enabled):
    configured = node(camera=True, mode=mode)
    configured["equipment"][0]["enabled"] = enabled
    with TestClient(create_app()) as client:
        assert deploy(client, [configured]).status_code == 200
        advance(client, 400)
        report = client.get("/api/data-management/dashboard").json()
        assert report["objects"]["items"] == []
        assert report["overview"]["stability"]["score"] is None
        assert report["overview"]["requests"] == []


def test_remote_scopes_do_not_delete_or_modify_other_clients():
    from communication.external.data_management import RemoteDataManagement
    module_app = create_app()
    with TestClient(module_app) as module_client:
        def remote():
            transport = httpx.MockTransport(lambda request: module_client.request(request.method, str(request.url.raw_path, "ascii"), content=request.content, headers=dict(request.headers)))
            return RemoteDataManagement("http://module.test", client=httpx.Client(base_url="http://module.test", transport=transport))
        with TestClient(create_app(data_management=remote())) as a, TestClient(create_app(data_management=remote())) as b:
            scope_a = deploy(a, [node("SDC-A")]).json()["scope_id"]
            scope_b = deploy(b, [node("SDC-B")]).json()["scope_id"]
            assert scope_a != scope_b
            advance(a, 50)
            advance(b, 50)
            assert a.get("/api/data-management/dashboard").json()["objects"]["total"] > 0
            assert b.get("/api/data-management/dashboard").json()["objects"]["total"] > 0
            old_a = module_client.get("/api/data-management/objects", params={"scope_id": scope_a}).json()
            assert deploy(a, [], "recall", 1).status_code == 200
            assert a.get("/api/data-management/dashboard").json()["objects"]["total"] == 0
            retained = module_client.get("/api/data-management/objects", params={"scope_id": scope_a}).json()
            assert retained == old_a
            current_b = b.get("/api/data-management/dashboard").json()
            assert {item["source"] for item in current_b["objects"]["items"]} == {"SDC-B"}
            bad = module_client.post("/api/data-management/ingest", json={"scope_id": scope_b, "time": "t", "sim_elapsed_s": 180,
                "products": [{"ref": "other", "class": "telemetry", "source": "SDC-A", "size_mb": 10}]})
            assert bad.status_code == 400


def test_all_240_deployed_nodes_produce_without_source_starvation():
    with TestClient(create_app()) as client:
        assert deploy(client, [node(f"SDC-{i}") for i in range(240)]).status_code == 200
        advance(client, 100)
        dashboard = client.get("/api/data-management/dashboard?limit=1000").json()
        assert len({item["source"] for item in dashboard["objects"]["items"]}) == 240


def test_remote_ingest_failure_is_reported_and_retry_keeps_production_interval():
    from communication.external.data_management import RemoteDataManagement
    module_app = create_app()
    with TestClient(module_app) as module_client:
        fail_ingest = [True]
        def transport(request):
            if request.url.path.endswith("/ingest") and fail_ingest[0]:
                return httpx.Response(503, json={"detail": "temporary unavailable"})
            return module_client.request(request.method, str(request.url.raw_path, "ascii"), content=request.content, headers=dict(request.headers))
        remote = RemoteDataManagement("http://module.test", client=httpx.Client(base_url="http://module.test", transport=httpx.MockTransport(transport)))
        with TestClient(create_app(data_management=remote)) as client:
            assert deploy(client, [node()]).status_code == 200
            advance(client, 100)
            failed = client.get("/api/data-management/dashboard").json()
            assert failed["overview"] is None and not failed["module"]["reachable"]
            fail_ingest[0] = False
            restored = client.get("/api/data-management/dashboard").json()
            assert restored["objects"]["total"] == 3
            assert client.get("/api/data-management/dashboard").json()["objects"]["total"] == 3


def test_remote_wrong_scope_response_never_accepts_configuration():
    from communication.external.data_management import RemoteDataManagement
    def transport(request):
        if request.method == "GET":
            return httpx.Response(200, json={"scope_contract": "isolated-v1", "reachable": True})
        return httpx.Response(200, json={"scope_contract": "isolated-v1", "scope_id": "wrong-scope", "nodes": []})
    remote = RemoteDataManagement("http://module.test", client=httpx.Client(base_url="http://module.test", transport=httpx.MockTransport(transport)))
    with TestClient(create_app(data_management=remote)) as client:
        assert deploy(client, [node()]).status_code == 503
        assert client.get("/api/data-management/deployment").json()["revision"] == 0


def test_deployment_named_unconfigured_cannot_reuse_the_initial_empty_scope():
    with TestClient(create_app()) as client:
        initial = client.get("/api/data-management/deployment").json()
        accepted = deploy(client, [node()], "unconfigured").json()
        assert accepted["scope_id"] != initial["scope_id"]


def test_four_hour_sync_does_not_drop_telemetry_or_camera_slots():
    from digital_twin.simulation.data_deployment import deployment_inputs, deployment_products
    inputs = deployment_inputs({"nodes": [node(camera=True)]}, [])
    products = deployment_products(inputs, 0, 14400)
    assert sum(item["class"] == "telemetry" for item in products) == 480
    assert sum(item["class"] == "imagery" for item in products) == 160
    assert len({item["ref"] for item in products}) == 640
    assert max(item["created_s"] for item in products) == 14400


def test_icd_scope_is_validated_in_the_wire_schema():
    with TestClient(create_app()) as client:
        response = client.post("/api/data-management/nodes", json={"scope_id": 123, "time": "t", "sim_elapsed_s": 0, "nodes": []})
        assert response.status_code == 422
