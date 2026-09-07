from fastapi.testclient import TestClient

from user_application.web.application import create_app


def test_bootstrap_contains_all_operational_modules():
    with TestClient(create_app()) as client:
        response = client.get("/api/bootstrap")
        assert response.status_code == 200
        payload = response.json()
        assert len(payload["scenarios"]) >= 3
        assert len(payload["communication"]["nodes"]) >= 8
        assert len(payload["missions"]) >= 3
        assert len(payload["analytics"]["kpis"]) >= 4
        assert len(payload["devices"]) >= 6


def test_runtime_control_fault_mission_and_hil_actions():
    with TestClient(create_app()) as client:
        pause = client.post("/api/runtime/control", json={"action": "pause"})
        assert pause.status_code == 200
        assert pause.json()["running"] is False

        speed = client.post("/api/runtime/speed", json={"speed": 4})
        assert speed.status_code == 200
        assert speed.json()["speed"] == 4

        fault = client.post(
            "/api/faults",
            json={"target": "SAT-01", "kind": "link_loss", "severity": "medium", "duration_seconds": 30},
        )
        assert fault.status_code == 200
        assert fault.json()["active"] is True

        mission = client.post("/api/missions/action", json={"mission_id": "ODIN-01", "action": "replan"})
        assert mission.status_code == 200
        assert mission.json()["status"] == "running"

        hil = client.post("/api/hil/device", json={"device_id": "KRS-HIL", "action": "connect"})
        assert hil.status_code == 200
        assert hil.json()["connected"] is True


def test_report_exports():
    with TestClient(create_app()) as client:
        csv_response = client.get("/api/reports/summary.csv")
        assert csv_response.status_code == 200
        assert "KPI" in csv_response.text

        json_response = client.get("/api/reports/snapshot.json")
        assert json_response.status_code == 200
        assert json_response.json()["analytics"]["verdict"] == "PASS"

