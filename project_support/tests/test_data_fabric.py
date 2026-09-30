"""The data fabric stand-in and its ICD-02 endpoints."""
import math

import httpx
import pytest
from fastapi.testclient import TestClient

from operations_software.data_fabric import DataFabricStandIn
from operations_software.data_fabric.link_metrics import ber_from_margin, ground_metrics, oisl_metrics, quality_from_margin, terrestrial_metrics
from operations_software.data_fabric.routing import build_graph, ground_paths, shortest_path


def satellite(node_id, generation=0.2, storage=64):
    return {"id": node_id, "name": node_id, "kind": "satellite", "mode": "nominal", "generation_mbps": generation, "storage_gb": storage}


def oisl(a, b, state="locked", range_km=2000, margin=8.0, faulted=False):
    return {"id": f"{a}|{b}", "a": a, "b": b, "kind": "oisl", "state": state, "range_km": range_km, "data_rate_mbps": 10000, "margin_db": margin, "faulted": faulted}


def ground(station, sat, elevation=40.0, range_km=900.0, faulted=False):
    return {"id": f"{station}|{sat}", "a": station, "b": sat, "kind": "ground", "band": "X", "elevation_deg": elevation, "min_elevation_deg": 5,
            "range_km": range_km, "data_rate_mbps": 800, "eirp_dbw": 32.8, "gt_dbk": 30.7, "frequency_ghz": 8.2, "faulted": faulted}


def snapshot(time="2026-09-07T12:00:00Z", links=None, nodes=None):
    nodes = nodes or [satellite("S1"), satellite("S2"), satellite("S3"), {"id": "G1", "name": "서울", "kind": "ground"}]
    links = links if links is not None else [oisl("S1", "S2"), oisl("S2", "S3"), ground("G1", "S3")]
    return {"time": time, "nodes": nodes, "links": links}


def test_link_metrics_follow_geometry_and_state():
    locked = oisl_metrics(oisl("A", "B", range_km=1000, margin=10))
    assert locked["usable"] and locked["quality"] == 100 and locked["capacity_mbps"] == 10000
    assert 3.3 < locked["delay_ms"] < 5.0  # 1000 km at c plus 1.5 ms processing
    assert oisl_metrics(oisl("A", "B", state="acquiring"))["reason"] == "not_locked"
    assert oisl_metrics(oisl("A", "B", faulted=True))["reason"] == "fault"
    assert oisl_metrics(oisl("A", "B", margin=-2))["reason"] == "margin"
    high = ground_metrics(ground("G", "S", elevation=80, range_km=600))
    low = ground_metrics(ground("G", "S", elevation=6, range_km=2400))
    assert high["usable"] and low["usable"] and high["margin_db"] > low["margin_db"]
    assert ground_metrics(ground("G", "S", elevation=2, range_km=2600))["reason"] == "below_mask"
    fibre = terrestrial_metrics({"id": "G1|G2", "a": "G1", "b": "G2", "kind": "terrestrial", "distance_km": 450})
    assert fibre["usable"] and fibre["quality"] == 100 and 5.0 < fibre["delay_ms"] < 6.0
    assert quality_from_margin(0) == 50 and quality_from_margin(12) == 100 and quality_from_margin(-11) == 0
    assert ber_from_margin(0) > ber_from_margin(3) > ber_from_margin(10) >= 1e-15


def test_routing_prefers_objective_and_ground_paths_reach_every_connected_satellite():
    links = [oisl_metrics(oisl("S1", "S2", range_km=3000, margin=10)), oisl_metrics(oisl("S2", "S3", range_km=3000, margin=10)),
             oisl_metrics(oisl("S1", "S3", range_km=4500, margin=0.5)), ground_metrics(ground("G1", "S3"))]
    graph = build_graph(links)
    fast = shortest_path(graph, "S1", "S3", "latency")
    assert fast["path"] == ["S1", "S3"], "one 4500 km hop (16.5 ms) beats two 3000 km hops (23 ms) on delay alone"
    reliable = shortest_path(graph, "S1", "S3", "reliability")
    assert reliable["path"] == ["S1", "S2", "S3"], "the low-margin direct link loses on reliability"
    paths = ground_paths(graph, ["G1"])
    assert set(paths) == {"S1", "S2", "S3"}
    assert paths["S3"]["path"] == ["S3", "G1"] and paths["S3"]["next_hop"] == "G1"
    assert paths["S1"]["ground"] == "G1" and paths["S1"]["hops"] == 2
    assert shortest_path(build_graph([oisl_metrics(oisl("S1", "S2", state="idle"))]), "S1", "S2") is None


def test_stand_in_reports_paths_backlog_and_restarts_on_backward_time():
    fabric = DataFabricStandIn()
    first = fabric.update(snapshot())
    assert first["sequence"] == 1 and first["elapsed_s"] == 0
    assert first["summary"] == {"nodes": 4, "satellites": 3, "ground_stations": 1, "links": 3, "usable_links": 3, "usable_oisl": 2, "usable_ground": 1,
                                "satellites_with_ground_path": 3, "mean_ground_delay_ms": first["summary"]["mean_ground_delay_ms"], "stored_mb": 0.0,
                                "delivered_mb": 0.0, "dropped_mb": 0.0}
    by_id = {node["id"]: node for node in first["nodes"]}
    assert by_id["S1"]["ground_path"] == ["S1", "S2", "S3", "G1"] and by_id["S1"]["next_hop"] == "S2"
    assert by_id["G1"]["serving"] == ["S1", "S2", "S3"]
    # Cut the ground link: S1..S3 store data for 60 s.
    cut = fabric.update(snapshot("2026-09-07T12:01:00Z", links=[oisl("S1", "S2"), oisl("S2", "S3"), ground("G1", "S3", elevation=1)]))
    stored = {node["id"]: node for node in cut["nodes"] if node["kind"] == "satellite"}
    assert all(node["custody"] == "storing" and math.isclose(node["stored_mb"], 0.2 * 60 / 8, rel_tol=1e-6) for node in stored.values())
    assert cut["summary"]["satellites_with_ground_path"] == 0 and cut["summary"]["stored_mb"] == pytest.approx(3 * 1.5)
    # Restore it: the backlog drains and delivered data accumulates.
    restored = fabric.update(snapshot("2026-09-07T12:01:10Z"))
    assert restored["summary"]["stored_mb"] == 0.0 and restored["summary"]["delivered_mb"] == pytest.approx(3 * 1.5 + 3 * 0.2 * 10 / 8)
    assert {node["custody"] for node in restored["nodes"] if node["kind"] == "satellite"} == {"passing"}
    # A jump back in time restarts the store-and-forward model instead of inventing history.
    back = fabric.update(snapshot("2026-09-07T11:00:00Z"))
    assert back["summary"]["delivered_mb"] == 0.0 and back["elapsed_s"] == 0
    route = fabric.route("S1", "G1", "latency")
    assert route["status"] == "available" and route["path"] == ["S1", "S2", "S3", "G1"] and route["hops"] == 3
    assert route["total_delay_ms"] == pytest.approx(sum(hop["delay_ms"] for hop in route["hop_list"]))
    assert fabric.route("S1", "S1")["path"] == ["S1"]
    with pytest.raises(ValueError):
        fabric.route("S1", "NOPE")
    status = fabric.status()
    assert status["placement"] == "embedded" and status["sequence"] == 4 and status["nodes"] == 4


def test_stand_in_rejects_malformed_messages_without_inventing_links():
    fabric = DataFabricStandIn()
    assert fabric.route("S1", "S2")["status"] == "no_network"
    with pytest.raises(ValueError):
        fabric.update({"nodes": [], "links": []})
    with pytest.raises(ValueError):
        fabric.update(snapshot(links=[oisl("S1", "GHOST")]))
    with pytest.raises(ValueError):
        fabric.update(snapshot(nodes=[{"id": "X", "kind": "balloon"}], links=[]))
    faulted = fabric.update(snapshot(links=[oisl("S1", "S2", faulted=True), oisl("S2", "S3"), ground("G1", "S3")]))
    assert faulted["summary"]["satellites_with_ground_path"] == 2
    assert next(node for node in faulted["nodes"] if node["id"] == "S1")["ground_path"] is None


def test_icd_endpoints_and_remote_forwarding():
    from user_application.web.application import create_app

    with TestClient(create_app()) as client:
        status = client.get("/api/data-fabric/status").json()
        assert status["placement"] == "embedded" and status["reachable"] is True
        assert client.post("/api/data-fabric/route", json={"source": "S1", "target": "G1", "objective": "latency"}).json()["status"] == "no_network"
        report = client.post("/api/data-fabric/network", json=snapshot())
        assert report.status_code == 200 and report.json()["summary"]["usable_links"] == 3
        assert client.post("/api/data-fabric/network", json={"time": "x", "nodes": [], "links": []}).status_code == 400
        assert client.post("/api/data-fabric/network", json={"nodes": []}).status_code == 422
        assert client.post("/api/data-fabric/route", json={"source": "S1", "target": "G1", "objective": "fastest"}).status_code == 422
        route = client.post("/api/data-fabric/route", json={"source": "S1", "target": "G1", "objective": "latency"}).json()
        assert route["path"] == ["S1", "S2", "S3", "G1"]

    # A second application acting as the external module answers the same ICD over HTTP.
    from communication.external.data_fabric import RemoteDataFabric

    module_app = create_app()
    with TestClient(module_app) as module_client:
        transport = httpx.MockTransport(lambda request: module_client.request(request.method, request.url.path, content=request.content, headers=dict(request.headers)))
        remote = RemoteDataFabric("http://fabric.example:8792", client=httpx.Client(base_url="http://fabric.example:8792", transport=transport))
        with TestClient(create_app(data_fabric=remote)) as client:
            assert client.get("/api/data-fabric/status").json()["placement"] == "remote"
            assert client.post("/api/data-fabric/network", json=snapshot()).json()["summary"]["satellites_with_ground_path"] == 3
            assert client.post("/api/data-fabric/network", json=snapshot(links=[oisl("S1", "GHOST")])).status_code == 400
    dead = RemoteDataFabric("http://127.0.0.1:9", client=httpx.Client(base_url="http://127.0.0.1:9", transport=httpx.MockTransport(lambda request: (_ for _ in ()).throw(httpx.ConnectError("refused")))))
    with TestClient(create_app(data_fabric=dead)) as client:
        assert client.post("/api/data-fabric/network", json=snapshot()).status_code == 503
        status = client.get("/api/data-fabric/status").json()
        assert status["reachable"] is False and status["placement"] == "remote"
