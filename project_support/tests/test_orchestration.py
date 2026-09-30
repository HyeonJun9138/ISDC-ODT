"""The constellation operations stand-in (ICD-03) and its endpoints."""
import httpx
import pytest
from fastapi.testclient import TestClient

from operations_software.orchestration import OrchestrationStandIn
from operations_software.orchestration.scheduler import IMAGING_DWELL_S, Planner, parse_time

T0 = "2026-09-08T00:00:00Z"


def at(minutes):
    return f"2026-09-08T{int(minutes) // 60:02d}:{int(minutes) % 60:02d}:00Z"


def satellite(sat_id, camera=True, mode="nominal", storage=4000, busy=None, compute=200):
    return {"id": sat_id, "name": sat_id, "mode": mode, "capabilities": {"camera": camera, "compute_mbps": compute, "storage_free_mb": storage, "oisl": True, "rf_bands": ["X"]},
            "power": {"generation_w": 1200, "bus_w": 120, "battery_wh": 2000}, "busy": busy or []}


def contact(sat_id, station, start_min, end_min, rate=800, uplink=20):
    return {"id": f"{station}|{sat_id}|{start_min}", "satellite": sat_id, "station": station, "band": "X", "rate_mbps": rate, "uplink_mbps": uplink, "start": at(start_min), "end": at(end_min), "max_elevation": 45}


def access(sat_id, start_min, end_min):
    return {"id": f"tgt|{sat_id}|{start_min}", "satellite": sat_id, "start": at(start_min), "end": at(end_min), "peak": at((start_min + end_min) / 2), "max_elevation": 70}


def request(mission, satellites, windows, mesh=None, exclude=None, time=T0):
    return {"time": time, "mission": mission, "satellites": satellites, "stations": [{"id": "GS-DAEJEON", "name": "대전"}], "windows": windows, "mesh": mesh or {}, "exclude": exclude or []}


def observe(deadline_min=360, **params):
    return {"id": "MSN-0001", "kind": "observe", "priority": 3, "window_start": T0, "deadline": at(deadline_min), "params": {"target_name": "서울", "product_mb": 800, **params}}


def test_observe_picks_the_earliest_delivery_and_relays_over_the_mesh_when_it_helps():
    sats = [satellite("S1"), satellite("S2", camera=False), satellite("S3")]
    windows = {
        "target_access": [access("S1", 30, 38), access("S3", 90, 98)],
        # S1 has no contact until minute 300, but its neighbour S2 sees Daejeon at minute 60.
        "contacts": [contact("S1", "GS-DAEJEON", 300, 310), contact("S2", "GS-DAEJEON", 60, 70), contact("S3", "GS-DAEJEON", 100, 110)],
        "eclipses": [{"satellite": "S1", "start": at(30), "end": at(60)}],
    }
    plan = OrchestrationStandIn().plan(request(observe(), sats, windows, mesh={"S1": ["S2"], "S2": ["S3"]}))
    assert plan["feasible"] is True
    kinds = [task["kind"] for task in plan["tasks"]]
    assert kinds == ["collect", "process", "store", "crosslink", "transfer"], kinds
    collect = plan["tasks"][0]
    assert collect["satellite"] == "S1" and collect["duration_s"] == IMAGING_DWELL_S
    assert plan["tasks"][3]["satellite"] == "S1" and plan["tasks"][3]["counterpart"] == "S2"
    transfer = plan["tasks"][-1]
    assert transfer["satellite"] == "S2" and transfer["counterpart"] == "GS-DAEJEON" and transfer["volume_mb"] == pytest.approx(320)
    assert transfer["start"].startswith("2026-09-08T01:00:00") and parse_time(transfer["end"]) - parse_time(transfer["start"]) == pytest.approx(320 * 8 / 800, abs=0.002)
    assert plan["summary"]["path"] == ["S1", "S2", "GS-DAEJEON"] and plan["summary"]["hops"] == 2
    assert plan["summary"]["margin_s"] > 0 and plan["summary"]["finish_at"] == transfer["end"]
    checks = {check["id"]: check for check in plan["checks"]}
    assert checks["deadline"]["ok"] and checks["storage"]["ok"] and checks["energy"]["ok"]
    assert checks["energy"]["items"][0]["drawn_wh"] > 0, "the collect task runs inside the eclipse and draws from the battery"
    assert plan["alternatives"] >= 2


def test_observe_reports_why_when_no_camera_or_no_window_fits_and_respects_the_preferred_satellite():
    sats = [satellite("S1", camera=False), satellite("S2")]
    windows = {"target_access": [access("S2", 30, 38)], "contacts": [contact("S2", "GS-DAEJEON", 400, 410)]}
    late = OrchestrationStandIn().plan(request(observe(deadline_min=120), sats, windows))
    assert late["feasible"] is False and late["tasks"] and "기한 초과" in late["checks"][0]["detail"]
    none = OrchestrationStandIn().plan(request(observe(), [satellite("S1", camera=False)], windows))
    assert none["feasible"] is False and none["tasks"] == [] and "촬영 장비" in none["reasons"][0]
    pinned = OrchestrationStandIn().plan(request(observe(preferred_satellite="S1"), sats, windows))
    assert pinned["feasible"] is False and "S1" in pinned["reasons"][0]
    safe = OrchestrationStandIn().plan(request(observe(), [satellite("S2", mode="safe")], windows))
    assert safe["unavailable"] == [{"satellite": "S2", "reason": "운용 모드 safe"}] and safe["tasks"] == []


def test_committed_tasks_push_new_work_later_and_storage_limits_are_checked():
    busy = [{"start": at(60), "end": at(70), "task_id": "MSN-0000-T01", "mission_id": "MSN-0000"}]
    sats = [satellite("S1", storage=100, busy=busy)]
    windows = {"target_access": [access("S1", 30, 38)], "contacts": [contact("S1", "GS-DAEJEON", 60, 75)]}
    plan = OrchestrationStandIn().plan(request(observe(), sats, windows))
    transfer = plan["tasks"][-1]
    assert parse_time(transfer["start"]) >= parse_time(at(70)) + 5, "the transfer waits for the committed task on the same satellite"
    storage = next(check for check in plan["checks"] if check["id"] == "storage")
    assert storage["ok"] is False and storage["items"][0]["held_mb"] == 800 and plan["feasible"] is False


def test_compute_relay_pickup_and_fleet_update_kinds():
    sats = [satellite("S1"), satellite("S2"), satellite("S3")]
    mesh = {"S1": ["S2"], "S2": ["S3"]}
    contacts = [contact("S1", "GS-DAEJEON", 20, 30), contact("S3", "GS-DAEJEON", 40, 50), contact("S2", "GS-DAEJEON", 200, 210)]
    compute = OrchestrationStandIn().plan(request({"id": "MSN-C", "kind": "compute", "deadline": at(300), "params": {"source_satellite": "S2", "input_mb": 2000, "output_ratio": 0.2}}, sats, {"contacts": contacts}, mesh))
    assert [task["kind"] for task in compute["tasks"]] == ["process", "store", "crosslink", "transfer"]
    assert compute["tasks"][0]["satellite"] == "S2" and compute["tasks"][0]["duration_s"] == pytest.approx(2000 * 8 / 200)
    assert compute["tasks"][-1]["satellite"] == "S1", "S1's contact at minute 20 beats S3's at 40 and S2's own at 200"
    assert compute["tasks"][2]["kind"] == "crosslink" and compute["tasks"][2]["satellite"] == "S2" and compute["tasks"][2]["counterpart"] == "S1"
    assert parse_time(compute["tasks"][3]["start"]) - parse_time(compute["tasks"][2]["end"]) == pytest.approx(5.0), "the hop lands one gap before the transfer"
    relay_up = OrchestrationStandIn().plan(request({"id": "MSN-R1", "kind": "relay", "deadline": at(300), "params": {"source": "station:GS-DAEJEON", "destination": "satellite:S2", "volume_mb": 40, "max_latency_ms": 30}}, sats, {"contacts": contacts}, mesh))
    assert [task["kind"] for task in relay_up["tasks"]] == ["uplink", "crosslink"] and relay_up["tasks"][0]["satellite"] == "S1"
    assert relay_up["summary"]["latency_ms"] == 16.0 and relay_up["feasible"] is True
    relay_sat = OrchestrationStandIn().plan(request({"id": "MSN-R2", "kind": "relay", "deadline": at(300), "params": {"source": "satellite:S1", "destination": "satellite:S3", "volume_mb": 10, "max_latency_ms": 10}}, sats, {}, mesh))
    assert [task["counterpart"] for task in relay_sat["tasks"]] == ["S2", "S3"]
    assert relay_sat["feasible"] is False and relay_sat["checks"][-1]["id"] == "latency" and relay_sat["checks"][-1]["ok"] is False
    assert OrchestrationStandIn().plan(request({"id": "MSN-R3", "kind": "relay", "deadline": at(300), "params": {"source": "station:A", "destination": "station:B"}}, sats, {}))["reasons"]
    crosslinks = [{"id": "x1", "satellite": "S3", "external": "25544", "start": at(10), "end": at(18), "min_range_km": 900}]
    pickup = OrchestrationStandIn().plan(request({"id": "MSN-P", "kind": "pickup", "deadline": at(300), "params": {"external_id": "25544", "external_name": "ISS", "volume_mb": 600, "crosslink_rate_mbps": 50}}, sats, {"contacts": contacts, "crosslinks": crosslinks}, mesh))
    assert [task["kind"] for task in pickup["tasks"]] == ["pickup", "store", "crosslink", "crosslink", "transfer"] and pickup["tasks"][0]["counterpart"] == "25544"
    assert pickup["tasks"][0]["duration_s"] == pytest.approx(600 * 8 / 50)
    assert pickup["summary"]["path"] == ["25544", "S3", "S2", "S1", "GS-DAEJEON"], "S1's contact at minute 20 is reached over two hops before S3's own at 40"
    update = OrchestrationStandIn().plan(request({"id": "MSN-U", "kind": "fleet_update", "deadline": at(600), "params": {"image_mb": 12, "apply_s": 600, "max_concurrent": 1}}, sats, {"contacts": contacts + [contact("S2", "GS-DAEJEON", 45, 55)]}))
    applies = [task for task in update["tasks"] if task["kind"] == "apply"]
    assert len(applies) == 3 and update["summary"]["updated"] == 3
    spans = sorted((parse_time(task["start"]), parse_time(task["end"])) for task in applies)
    assert all(spans[i][1] <= spans[i + 1][0] for i in range(2)), "one satellite applies at a time"
    partial = OrchestrationStandIn().plan(request({"id": "MSN-U2", "kind": "fleet_update", "deadline": at(600), "params": {"satellites": ["S1", "S9"]}}, sats, {"contacts": contacts}))
    assert partial["feasible"] is False and "S9" in partial["reasons"][0] and partial["summary"]["updated"] == 1


def test_requests_are_validated_and_plans_are_deterministic():
    sats = [satellite("S1"), satellite("S2")]
    windows = {"target_access": [access("S1", 30, 38), access("S2", 30, 38)], "contacts": [contact("S1", "GS-DAEJEON", 60, 70), contact("S2", "GS-DAEJEON", 60, 70)]}
    first = OrchestrationStandIn().plan(request(observe(), sats, windows))
    second = OrchestrationStandIn().plan(request(observe(), list(reversed(sats)), windows))
    assert first["tasks"] == second["tasks"] and first["tasks"][0]["satellite"] == "S1", "ties resolve by satellite id regardless of input order"
    with pytest.raises(ValueError):
        Planner(request({"id": "X", "kind": "sleep", "deadline": at(60), "params": {}}, sats, {}))
    with pytest.raises(ValueError):
        Planner(request(observe(deadline_min=0), sats, {}))
    with pytest.raises(ValueError):
        Planner({"time": "not a time", "mission": observe()})
    status = OrchestrationStandIn().status()
    assert status["placement"] == "embedded" and status["sequence"] == 0


def test_icd_endpoints_and_remote_forwarding():
    from user_application.web.application import create_app

    sats = [satellite("S1")]
    windows = {"target_access": [access("S1", 30, 38)], "contacts": [contact("S1", "GS-DAEJEON", 60, 70)]}
    body = request(observe(), sats, windows)
    with TestClient(create_app()) as client:
        assert client.get("/api/orchestration/status").json()["placement"] == "embedded"
        answer = client.post("/api/orchestration/plan", json=body)
        assert answer.status_code == 200 and answer.json()["feasible"] is True and answer.json()["sequence"] == 1
        assert client.post("/api/orchestration/plan", json={"time": T0, "mission": {"id": "X", "kind": "nap", "deadline": at(60)}}).status_code == 422
        assert client.post("/api/orchestration/plan", json={"time": T0, "mission": {"id": "X", "kind": "observe", "deadline": T0}}).status_code == 400
    from communication.external.orchestration import RemoteOrchestration

    module_app = create_app()
    with TestClient(module_app) as module_client:
        transport = httpx.MockTransport(lambda req: module_client.request(req.method, req.url.path, content=req.content, headers=dict(req.headers)))
        remote = RemoteOrchestration("http://ops.example:5103", client=httpx.Client(base_url="http://ops.example:5103", transport=transport))
        with TestClient(create_app(orchestration=remote)) as client:
            assert client.get("/api/orchestration/status").json()["placement"] == "remote"
            assert client.post("/api/orchestration/plan", json=body).json()["feasible"] is True
    dead = RemoteOrchestration("http://127.0.0.1:9", client=httpx.Client(base_url="http://127.0.0.1:9", transport=httpx.MockTransport(lambda req: (_ for _ in ()).throw(httpx.ConnectError("refused")))))
    with TestClient(create_app(orchestration=dead)) as client:
        assert client.post("/api/orchestration/plan", json=body).status_code == 503
        assert client.get("/api/orchestration/status").json()["reachable"] is False
