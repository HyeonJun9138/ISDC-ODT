"""The data management stand-in (ICD-01), its twin-side bridge and the HTTP endpoints."""
import httpx
import pytest
from fastapi.testclient import TestClient

from digital_twin.simulation.data_products import products_between, snapshot_products_between
from operations_software.data_management import DataManagementStandIn
from operations_software.data_management.catalog import filter_product
from operations_software.data_management.placement import choose_targets, serve_latency_ms

NODES = [
    {"id": "DC-SEOUL", "name": "서울", "kind": "core", "capacity_gb": 1000, "available": True},
    {"id": "DC-JEJU", "name": "제주", "kind": "core", "capacity_gb": 500, "available": True},
    {"id": "GW-DTN", "name": "게이트웨이", "kind": "edge", "capacity_gb": 100, "available": True},
    {"id": "SAT-01", "name": "SAT-01", "kind": "onboard", "capacity_gb": 2, "available": True},
]


def topology(elapsed, nodes=None, **overrides):
    roster = [dict(node) for node in (nodes or NODES)]
    for node in roster:
        if node["id"] in overrides:
            node.update(overrides[node["id"]])
    return {"time": "2026-09-07T12:00:00Z", "sim_elapsed_s": elapsed, "nodes": roster}


def product(ref, cls="imagery", source="SAT-01", size=500.0, **extra):
    return {"ref": ref, "class": cls, "source": source, "size_mb": size, "priority": 1, **extra}


def ingest(module, elapsed, *products):
    return module.ingest({"time": "2026-09-07T12:00:00Z", "sim_elapsed_s": elapsed, "products": list(products)})


def test_filter_and_placement_rules():
    filters = {"min_size_mb": 1.0, "accept_classes": ["imagery", "telemetry"], "drop_priority_below": 1, "dedupe_by_ref": True}
    assert filter_product(product("a"), filters, set()) is None
    assert filter_product(product("a", size=0.2), filters, set()) == "below_min_size"
    assert filter_product(product("a", cls="science"), filters, set()) == "class_filtered"
    assert filter_product(product("a", cls="balloon"), filters, set()) == "unknown_class"
    assert filter_product(product("a", priority=0), filters, set()) == "low_priority"
    assert filter_product(product("a"), filters, {"a"}) == "duplicate"
    nodes = {node["id"]: {**node, "used_gb": 0.0} for node in NODES}
    assert choose_targets(nodes, "SAT-01", 500, 3) == ["SAT-01", "DC-SEOUL", "DC-JEJU"], "source first, then the emptiest ground centers"
    assert choose_targets(nodes, "SAT-01", 3000, 3) == ["DC-SEOUL", "DC-JEJU", "GW-DTN"], "a full onboard store is skipped"
    nodes["DC-SEOUL"]["available"] = False
    assert choose_targets(nodes, None, 500, 2, exclude={"DC-JEJU"}) == ["GW-DTN", "SAT-01"]
    assert serve_latency_ms("core", 1000) == pytest.approx(40 + 4000, rel=1e-6)
    assert serve_latency_ms("onboard", 10) > serve_latency_ms("edge", 10) > serve_latency_ms("core", 10)


def test_products_are_deterministic_and_slot_based():
    profiles = {"SAT-01": [{"class": "telemetry", "interval_s": 30, "size_mb": [8, 24]}], "SAT-02": [{"class": "imagery", "interval_s": 90, "size_mb": [400, 1200]}]}
    first = products_between(profiles, 0, 100)
    assert [item["ref"] for item in first] == ["SAT-01:telemetry:1", "SAT-01:telemetry:2", "SAT-01:telemetry:3", "SAT-02:imagery:1"]
    assert first == products_between(profiles, 0, 100)
    assert all(8 <= item["size_mb"] <= 24 for item in first if item["class"] == "telemetry")
    assert products_between(profiles, 100, 100) == [] and products_between(profiles, 0, 100, {"SAT-01": False}) == [first[-1]]
    assert products_between(profiles, 60, 90) == [first[2], first[3]], "a slot belongs to the interval its production ends in"
    assert [item["ref"] for item in snapshot_products_between(0, 61)] == ["digital_twin:ops_snapshot:1", "digital_twin:ops_snapshot:2"]


def test_stand_in_catalogues_places_replicates_and_serves():
    module = DataManagementStandIn()
    with pytest.raises(ValueError):
        ingest(module, 0, product("x"))
    report = module.update_nodes(topology(0))
    assert report["sequence"] == 1 and len(report["nodes"]) == 4
    result = ingest(module, 0, product("img-1"), product("img-1"), product("tiny", size=0.001), product("tm-1", cls="telemetry", size=10))
    assert [item["object_id"] for item in result["accepted"]] == ["OBJ-000001", "OBJ-000002"]
    assert [item["reason"] for item in result["rejected"]] == ["duplicate", "below_min_size"]
    assert result["accepted"][0]["replicas"] == ["SAT-01", "DC-SEOUL", "DC-JEJU"], "imagery replicates three times"
    assert result["accepted"][1]["replicas"] == ["SAT-01", "DC-SEOUL"], "telemetry replicates twice"
    overview = module.overview()
    assert overview["stages"]["ingested"] == 2 and overview["stages"]["filtered"] == 2 and overview["stages"]["replicated"] == 0, "copies are still syncing"
    assert overview["metrics"]["objects"] == 2 and overview["objects_by_status"]["pending"] == 2, "copies still being written are pending, not degraded"
    module.update_nodes(topology(60))
    overview = module.overview()
    assert overview["stages"]["replicated"] == 2 and overview["metrics"]["verified_replicas"] == 5
    assert overview["stability"]["score"] >= 90 and overview["stability"]["grade"] == "stable"
    served = module.request({"time": "t", "sim_elapsed_s": 61, "object_id": "OBJ-000001", "destination": "GW-DTN"})
    assert served["status"] == "served" and served["served_from"] == "DC-SEOUL" and served["latency_ms"] == pytest.approx(40 + 500 * 8 / 2000 * 1000)
    by_class = module.request({"time": "t", "sim_elapsed_s": 62, "class": "telemetry", "destination": "DC-JEJU"})
    assert by_class["object_id"] == "OBJ-000002" and by_class["status"] == "served"
    missing = module.request({"time": "t", "sim_elapsed_s": 63, "object_id": "OBJ-999999", "destination": "DC-JEJU"})
    assert missing["status"] == "failed" and missing["reason"] == "object_not_found"
    with pytest.raises(ValueError):
        module.request({"time": "t", "sim_elapsed_s": 64, "destination": "DC-JEJU"})
    nodes = {node["id"]: node for node in module.nodes()["nodes"]}
    assert nodes["SAT-01"]["objects"] == 2 and nodes["DC-SEOUL"]["replicas"]["verified"] == 2
    assert nodes["SAT-01"]["used_gb"] == pytest.approx(0.51)
    listing = module.objects({"class": "imagery"})
    assert listing["total"] == 1 and listing["items"][0]["verified_replicas"] == 3 and listing["items"][0]["checksum"]


def test_outage_triggers_self_healing_and_recovery_resyncs():
    module = DataManagementStandIn()
    module.update_nodes(topology(0))
    ingest(module, 0, product("img-1"))
    module.update_nodes(topology(30))
    down = module.update_nodes(topology(31, **{"DC-JEJU": {"available": False, "reason": "power_drop (high)"}}))
    assert next(node for node in down["nodes"] if node["id"] == "DC-JEJU")["state"] == "down"
    obj = module.objects()["items"][0]
    assert obj["status"] == "degraded" and obj["verified_replicas"] == 2
    assert any(event["kind"] == "node_unavailable" for event in module.events()["items"])
    module.update_nodes(topology(120, **{"DC-JEJU": {"available": False}}))
    jobs = [job for job in module.overview()["jobs"] if job["kind"] == "heal"]
    assert jobs and jobs[0]["target"] == "GW-DTN" and jobs[0]["status"] == "running", "after the grace period a third copy is rebuilt elsewhere"
    module.update_nodes(topology(200, **{"DC-JEJU": {"available": False}}))
    healed = module.objects()["items"][0]
    assert healed["verified_replicas"] == 3 and any(event["kind"] == "heal_completed" for event in module.events()["items"])
    back = module.update_nodes(topology(210))
    assert next(node for node in back["nodes"] if node["id"] == "DC-JEJU")["state"] == "ok"
    assert any(event["kind"] == "node_recovered" for event in module.events()["items"])
    module.update_nodes(topology(220))
    assert module.objects()["items"][0]["verified_replicas"] == 4, "the returned copy re-synchronises alongside the healed one"
    assert module.overview()["counters"]["healed"] == 1


def test_actions_change_policy_and_time_reversal_restarts_the_model():
    module = DataManagementStandIn()
    module.update_nodes(topology(0))
    ingest(module, 0, product("img-1"), product("img-2"))
    module.update_nodes(topology(60))
    fewer = module.action({"time": "t", "sim_elapsed_s": 61, "action": "set_replication", "class": "imagery", "replication": 2})
    assert fewer["status"] == "done" and module.overview()["policy"]["replication"]["imagery"] == 2
    assert all(item["verified_replicas"] == 2 for item in module.objects()["items"])
    more = module.action({"time": "t", "sim_elapsed_s": 62, "action": "set_replication", "class": "imagery", "replication": 3})
    assert more["scheduled"] == 2 and sum(1 for job in module.overview()["jobs"] if job["status"] == "running") == 2
    with pytest.raises(ValueError):
        module.action({"time": "t", "sim_elapsed_s": 63, "action": "set_replication", "class": "imagery", "replication": 9})
    with pytest.raises(ValueError):
        module.action({"time": "t", "sim_elapsed_s": 63, "action": "shred"})
    filters = module.action({"time": "t", "sim_elapsed_s": 64, "action": "set_filter", "filter": {"min_size_mb": 50, "accept_classes": ["imagery"]}})
    assert filters["filters"]["min_size_mb"] == 50 and filters["filters"]["accept_classes"] == ["imagery"]
    assert ingest(module, 65, product("tm", cls="telemetry", size=10))["rejected"][0]["reason"] == "class_filtered"
    verify = module.action({"time": "t", "sim_elapsed_s": 66, "action": "verify"})
    assert verify["status"] == "running" and verify["checked"] >= 4
    rebalance = module.action({"time": "t", "sim_elapsed_s": 67, "action": "rebalance"})
    assert rebalance["status"] == "running" and rebalance["moved"] == 0
    assert module.status()["sequence"] == 9, "rejected messages do not consume a sequence number"
    with pytest.raises(ValueError):
        module.update_nodes({"time": "t", "nodes": NODES})
    restarted = module.update_nodes(topology(5))
    assert restarted["sequence"] == 1 and module.overview()["metrics"]["objects"] == 0, "a backward clock restarts the stand-in"


def test_icd_endpoints_bridge_and_remote_forwarding():
    from user_application.web.application import create_app
    from project_support.tests.test_data_deployment import node, deploy, advance

    with TestClient(create_app()) as client:
        status = client.get("/api/data-management/status").json()
        assert status["placement"] == "embedded" and status["reachable"] is True
        first = client.get("/api/data-management/dashboard").json()
        assert first["sync"]["nodes"] == 0 and first["module"]["reachable"] is True
        assert first["nodes"] == [] and first["overview"]["stability"]["score"] is None
        deployment = deploy(client, [node()]).json()
        scope = deployment["scope_id"]
        assert client.get("/api/data-management/dashboard").json()["objects"]["total"] == 0
        advance(client, 40)
        second = client.get("/api/data-management/dashboard?class=telemetry&limit=5").json()
        assert second["objects"]["total"] >= 1 and all(item["class"] == "telemetry" for item in second["objects"]["items"])
        served = client.post("/api/data-management/console/request", json={"scope_id": scope, "class": "telemetry", "destination": "SDC-A"}).json()
        assert served["status"] in ("served", "failed") and "sequence" in served
        action = client.post("/api/data-management/console/action", json={"scope_id": scope, "action": "set_replication", "class": "telemetry", "replication": 3}).json()
        assert action["status"] == "done"
        assert client.post("/api/data-management/console/action", json={"scope_id": scope, "action": "shred"}).status_code == 422
        assert client.post("/api/data-management/console/action", json={"scope_id": scope, "action": "set_replication", "class": "nope", "replication": 2}).status_code == 400
        assert client.post("/api/data-management/console/snapshot").status_code == 409
        assert client.post("/api/data-management/ingest", json={"scope_id": scope, "time": "t", "sim_elapsed_s": 100000, "products": [{"ref": "x", "class": "imagery", "source": "SAT-01", "size_mb": 1}]}).status_code == 400
        assert client.post("/api/data-management/nodes", json={"time": "t", "nodes": []}).status_code == 422
        events = client.get("/api/data-management/events", params={"scope_id": scope}).json()
        assert events["items"] and events["latest"] >= len(events["items"])

    from communication.external.data_management import RemoteDataManagement

    module_app = create_app()
    with TestClient(module_app) as module_client:
        transport = httpx.MockTransport(lambda request: module_client.request(request.method, str(request.url.raw_path, "ascii"), content=request.content, headers=dict(request.headers)))
        remote = RemoteDataManagement("http://dm.example:8793", client=httpx.Client(base_url="http://dm.example:8793", transport=transport))
        with TestClient(create_app(data_management=remote)) as client:
            accepted = deploy(client, [node()]).json()
            advance(client, 40)
            dashboard = client.get("/api/data-management/dashboard?limit=3").json()
            assert dashboard["module"]["placement"] == "remote" and dashboard["module"]["reachable"] is True
            assert len(dashboard["nodes"]) == 1 and len(dashboard["objects"]["items"]) <= 3
            assert client.post("/api/data-management/console/action", json={"scope_id": accepted["scope_id"], "action": "set_replication", "class": "nope", "replication": 2}).status_code == 400
    dead = RemoteDataManagement("http://127.0.0.1:9", client=httpx.Client(base_url="http://127.0.0.1:9", transport=httpx.MockTransport(lambda request: (_ for _ in ()).throw(httpx.ConnectError("refused")))))
    with TestClient(create_app(data_management=dead)) as client:
        dashboard = client.get("/api/data-management/dashboard").json()
        assert dashboard["module"]["reachable"] is False and dashboard["overview"] is None
        assert deploy(client, [node()]).status_code == 503
        assert client.post("/api/data-management/console/action", json={"action": "verify"}).status_code == 409
        assert client.get("/api/data-management/status").json()["reachable"] is False
