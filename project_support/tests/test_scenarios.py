"""PoC scenario definitions, the scenario catalogue API and the forward-only clock advance."""
from fastapi.testclient import TestClient

from user_application.configs.scenarios import SCENARIO_DEFINITIONS, model_keys, scenario_definition, scenario_summaries, validate_definition
from user_application.web.application import create_app


def test_every_poc_definition_is_structurally_valid():
    assert SCENARIO_DEFINITIONS, "at least one PoC scenario is defined"
    for scenario_id in SCENARIO_DEFINITIONS:
        definition = scenario_definition(scenario_id)
        assert validate_definition(definition) == [], scenario_id
        assert [step["order"] for step in definition["steps"]] == [1, 2, 3, 4, 5], "the PoC follows the five-step flow"
        assert definition["constellation"]["planes"] * definition["constellation"]["per_plane"] >= 24, "the constellation is a real mesh, not four satellites"
        assert definition["constellation"]["model_key"] in model_keys(), "the satellites show a shipped 3D model, not the bus placeholder"
        assert any(action["kind"] == "inject_fault" for step in definition["steps"] for action in step["actions"])
        assert any(action["kind"] == "verdict" for step in definition["steps"] for action in step["actions"])


def test_validate_definition_reports_broken_references():
    broken = scenario_definition("SDC_POC_01")
    broken["constellation"]["roles"]["gateway"]["index"] = 99
    broken["missions"][0]["params"]["source"] = "satellite:@nobody"
    broken["steps"][1]["at"]["mission"] = "missing"
    broken["steps"][2]["actions"].append({"kind": "explode"})
    broken["criteria"][0]["rules"].append({"metric": "made.up", "min": 1})
    broken["constellation"]["roles"]["relay"]["model_key"] = "no_such_model"
    problems = validate_definition(broken)
    assert any("gateway" in problem for problem in problems)
    assert any("no_such_model" in problem for problem in problems), "model keys are checked against the shipped manifest"
    assert any("@nobody" in problem for problem in problems)
    assert any("missing" in problem for problem in problems)
    assert any("explode" in problem for problem in problems)
    assert any("criteria reach" in problem for problem in problems)


def test_scenario_catalogue_and_detail_api():
    with TestClient(create_app()) as client:
        listing = client.get("/api/scenarios").json()
        ids = [item["id"] for item in listing["scenarios"]]
        assert "LEO_STANDARD" in ids and "SDC_POC_01" in ids
        assert listing["current"] == "LEO_STANDARD"
        poc = next(item for item in listing["scenarios"] if item["id"] == "SDC_POC_01")
        assert poc["kind"] == "poc" and poc["satellites"] == 40 and len(poc["steps"]) == 5
        assert "constellation" not in poc, "the listing carries summaries, the detail carries the definition"
        detail = client.get("/api/scenarios/SDC_POC_01").json()
        assert detail["constellation"]["roles"]["source"]["plane"] == 0
        assert detail["missions"][0]["params"]["destination"] == "satellite:@gateway"
        assert client.get("/api/scenarios/LEO_STANDARD").status_code == 404, "SIM-only scenarios have no playback definition"
        assert client.get("/api/scenarios/NOPE").status_code == 404
        bootstrap = client.get("/api/bootstrap").json()
        assert len(bootstrap["scenarios"]) >= 4
        assert scenario_summaries()[3]["missions"] == 3


def test_clock_advance_is_forward_only_and_expires_faults():
    with TestClient(create_app()) as client:
        assert client.post("/api/scenario/select", json={"scenario_id": "SDC_POC_01"}).json()["scenario_id"] == "SDC_POC_01"
        client.post("/api/runtime/control", json={"action": "pause"})
        assert client.get("/api/health").json()["runtime"]["elapsed_seconds"] < 1
        client.post("/api/faults", json={"target": "NODE-0001|NODE-0002", "kind": "link_loss", "severity": "high", "duration_seconds": 100})
        assert client.post("/api/scenario/advance", json={"seconds": 60}).json()["elapsed_seconds"] >= 60
        assert len(client.get("/api/health").json()["runtime"]["active_faults"]) == 1
        assert client.post("/api/scenario/advance", json={"seconds": 60}).json()["active_faults"] == []
        assert client.post("/api/scenario/advance", json={"seconds": -5}).status_code == 422
        assert client.post("/api/scenario/advance", json={"seconds": 7200}).status_code == 422
        events = client.get("/api/bootstrap").json()["events"]
        assert any(event["type"] == "runtime.advance" for event in events)
