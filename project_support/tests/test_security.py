"""ICD-08 SIM security rules, ownership, HTTP validation and external failure behavior."""
import httpx
import pytest
from fastapi.testclient import TestClient

from operations_software.security import SecurityStandIn
from communication.external.security import RemoteSecurity
from digital_twin.contracts.security import SecurityUnavailable
from user_application.web.application import create_app


def sample(elapsed=1, **changes):
    return {"contract_version": "1.0", "run_id": "RUN-A", "sample_id": f"RUN-A:{elapsed}",
            "sim_elapsed_s": elapsed, "observed_at": "2026-09-08T00:00:00Z", "source": "SIM",
            "running": False, "auth_percent": 99.5, "throughput_mbps": 40, "loss_percent": 0.2,
            "devices": [{"id": "PQC-TEE", "source": "MOCK-HIL", "connected": True}], **changes}


@pytest.mark.parametrize("value,want", [(98, "warning"), (99, "nominal"), (100, "nominal"),
    (0, "warning"), (None, "unknown"), (-1, "unknown"), (101, "unknown"),
    (float("nan"), "unknown"), (float("inf"), "unknown"), (10 ** 400, "unknown"),
    (True, "unknown"), ("99", "unknown")])
def test_authentication_rule_never_claims_integrity_or_encryption(value, want):
    module = SecurityStandIn(authentication_threshold=99)
    result = module.observe(sample(auth_percent=value))
    assert result["verdict"] == {"authentication": want, "integrity": "unknown", "encryption": "unknown"}
    assert result["observation"]["source"] == "SIM"
    if want == "unknown":
        assert result["observation"]["auth_percent"] is None


def test_missing_observation_is_unknown_and_reference_metrics_are_not_auth_evidence():
    module = SecurityStandIn()
    assert module.overview()["observation"] is None
    assert module.overview()["verdict"]["authentication"] == "unknown"
    message = sample(throughput_mbps=-1, loss_percent=101)
    del message["auth_percent"]
    result = module.observe(message)
    assert result["verdict"]["authentication"] == "unknown"
    assert result["observation"]["throughput_mbps"] is None
    assert result["observation"]["loss_percent"] is None


def test_duplicate_out_of_order_paused_and_unchanged_reports_do_not_add_events():
    module = SecurityStandIn()
    first = module.observe(sample(10))
    assert module.observe(sample(10, auth_percent=90)) == first
    assert module.observe(sample(9, auth_percent=90)) == first
    module.observe(sample(11))
    assert len(module.events()["events"]) == 1
    assert module.observe(sample(12, sample_id="RUN-A:10", auth_percent=90))["observation"]["sim_elapsed_s"] == 11
    module.observe(sample(12, auth_percent=98))
    assert [e["authentication"] for e in module.events()["events"]] == ["nominal", "warning"]
    assert len(module.events(after=1)["events"]) == 1


def test_new_run_resets_events_and_rejects_late_previous_run():
    module = SecurityStandIn()
    module.observe(sample(10))
    module.observe(sample(11, auth_percent=90))
    new = sample(0, run_id="RUN-B", sample_id="RUN-B:0", observed_at="2026-09-08T00:00:01Z")
    module.observe(new)
    assert module.events()["latest"] == 1
    assert len(module.events()["events"]) == 1
    assert module.events()["run_id"] == "RUN-B"
    module.observe(sample(12, observed_at="2026-09-08T00:00:02Z"))
    assert module.overview()["observation"]["run_id"] == "RUN-B"


def test_module_owns_deep_copies_and_bounded_event_history():
    module, other = SecurityStandIn(), SecurityStandIn()
    message = sample()
    result = module.observe(message)
    message["devices"][0]["connected"] = False
    result["observation"]["devices"][0]["connected"] = False
    assert module.overview()["observation"]["devices"][0]["connected"] is True
    assert other.overview()["observation"] is None
    for elapsed in range(2, 252):
        module.observe(sample(elapsed, auth_percent=90 if elapsed % 2 == 0 else 100))
    history = module.events()
    assert len(history["events"]) == 200 and history["latest"] == 251
    history["events"][0]["message"] = "changed"
    assert module.events()["events"][0]["message"] != "changed"


@pytest.mark.parametrize("change", [{"source": "LIVE"}, {"contract_version": "9"},
    {"sim_elapsed_s": -1}, {"observed_at": "2026-09-08"}, {"run_id": ""}])
def test_invalid_envelope_does_not_mutate_module(change):
    module = SecurityStandIn()
    with pytest.raises(ValueError):
        module.observe(sample(**change))
    assert module.events()["events"] == []


def test_dashboard_routes_schema_paused_deduplication_and_application_isolation():
    app, other = create_app(), create_app()
    with TestClient(app) as client:
        client.post("/api/runtime/control", json={"action": "pause"})
        first = client.get("/api/security/dashboard")
        assert first.status_code == 200
        report = first.json()
        assert set(report) == {"module", "overview", "events", "runtime"}
        assert report["module"]["placement"] == "embedded"
        assert report["module"]["reachable"] is True
        assert report["overview"]["observation"]["running"] is False
        again = client.get("/api/security/dashboard").json()
        assert again["events"] == report["events"]
        assert again["overview"]["observation"]["sample_id"] == report["overview"]["observation"]["sample_id"]
        assert other.state.security.overview()["observation"] is None
        assert client.post("/api/security/observations", json=sample(contract_version="2")).status_code == 422
        assert client.post("/api/security/observations", json=sample(observed_at="yesterday")).status_code == 422
        assert client.post("/api/security/observations", json=sample(auth_percent="99")).status_code == 422
        assert client.get("/api/security/events?after=-1").status_code == 422
        assert client.get("/api/security/status").json()["contract_version"] == "1.0"


def remote_with(handler):
    return RemoteSecurity("http://security.example:8798", client=httpx.Client(transport=httpx.MockTransport(handler)))


@pytest.mark.parametrize("handler", [
    lambda req: httpx.Response(200, json={}),
    lambda req: httpx.Response(200, json={"contract_version": "2.0"}),
    lambda req: httpx.Response(200, text="not JSON"),
    lambda req: httpx.Response(503),
    lambda req: (_ for _ in ()).throw(httpx.ReadTimeout("timeout")),
    lambda req: (_ for _ in ()).throw(httpx.ConnectError("refused")),
])
def test_remote_errors_are_503_without_embedded_fallback(handler):
    remote = remote_with(handler)
    with pytest.raises(SecurityUnavailable):
        remote.status()
    with TestClient(create_app(security=remote)) as client:
        response = client.get("/api/security/dashboard")
        assert response.status_code == 503
        report = response.json()
        assert report["module"]["reachable"] is False and report["module"]["placement"] == "remote"
        assert report["overview"] is None and report["events"]["events"] == []
        assert client.get("/api/security/status").status_code == 503
    assert remote._client.is_closed


def test_remote_roundtrip_uses_contract_and_timeout_and_closes_resources():
    with TestClient(create_app()) as server:
        def dispatch(request):
            assert request.extensions["timeout"]["read"] == 2.5
            return server.request(request.method, request.url.raw_path.decode(), content=request.content, headers=dict(request.headers))
        remote = remote_with(dispatch)
        with TestClient(create_app(security=remote)) as client:
            report = client.get("/api/security/dashboard").json()
            assert report["module"]["placement"] == "remote"
            assert report["module"]["endpoint"] == "http://security.example:8798"
            assert report["overview"]["observation"]["source"] == "SIM"
            assert report["events"]["events"][0]["authentication"] == "nominal"
        assert remote._client.is_closed


def test_external_environment_configuration_is_lazy(monkeypatch):
    monkeypatch.setenv("SPACETWIN_SECURITY_URL", "http://security.example:8798")
    app = create_app()
    assert app.state.security.base_url == "http://security.example:8798"
    assert app.state.security._client is None


@pytest.mark.parametrize("kind,change", [
    ("overview", {"verdict": {"authentication": "nominal", "integrity": "verified", "encryption": "unknown"}}),
    ("overview", {"threshold": "99"}),
    ("overview", {"source": "LIVE"}),
    ("overview", {"observation": {"source": "SIM"}}),
    ("overview", {"threshold": 10 ** 400}),
    ("events", {"events": [{"sequence": 1}]}),
    ("events", {"latest": True}),
    ("status", {"reachable": False}),
    ("status", {"observed_at": "2026-09-08"}),
    ("status", {"version": None}),
])
def test_remote_rejects_malformed_nested_contract_fields(kind, change):
    module = SecurityStandIn()
    module.observe(sample())
    report = getattr(module, kind)()
    report.update(change)
    remote = remote_with(lambda request: httpx.Response(200, json=report))
    try:
        with pytest.raises(SecurityUnavailable):
            getattr(remote, kind)()
    finally:
        remote.close()


def test_wall_clock_reversal_does_not_overwrite_a_newer_observation():
    module = SecurityStandIn()
    initial = module.observe(sample(observed_at="2026-09-08T00:00:02Z"))
    assert module.observe(sample(2, observed_at="2026-09-08T00:00:01Z", auth_percent=90)) == initial
    assert module.observe(sample(0, run_id="RUN-B", observed_at="2026-09-08T00:00:01Z")) == initial


def test_server_control_after_observation_reports_current_paused_runtime():
    with TestClient(create_app()) as client:
        client.get("/api/security/dashboard")
        client.post("/api/runtime/control", json={"action": "pause"})
        report = client.get("/api/security/dashboard").json()
        assert report["runtime"]["running"] is False
        assert len(report["events"]["events"]) == 1


@pytest.mark.parametrize("devices", [{}, [None], [{"id": "PQC-TEE", "connected": "yes"}],
    [{"id": 123, "connected": True}], [{"id": "PQC-TEE"}]])
def test_remote_rejects_malformed_device_evidence(devices):
    module = SecurityStandIn()
    report = module.observe(sample())
    report["observation"]["devices"] = devices
    remote = remote_with(lambda request: httpx.Response(200, json=report))
    try:
        with pytest.raises(SecurityUnavailable):
            remote.overview()
    finally:
        remote.close()


@pytest.mark.parametrize("devices", [{}, [None], [{"id": "PQC-TEE", "connected": "yes"}],
    [{"id": 123, "connected": True}], [{"id": "PQC-TEE"}]])
def test_http_rejects_malformed_device_evidence(devices):
    with TestClient(create_app()) as client:
        assert client.post("/api/security/observations", json=sample(devices=devices)).status_code == 422


@pytest.mark.parametrize("message", [None, [], "invalid", 1])
def test_stand_in_rejects_non_dictionary_messages_without_mutation(message):
    module = SecurityStandIn()
    with pytest.raises(ValueError):
        module.observe(message)
    assert module.overview()["observation"] is None


def test_remote_observe_rejects_another_run_but_allows_same_run_order_rejection():
    module = SecurityStandIn()
    report = module.observe(sample(10))
    remote = remote_with(lambda request: httpx.Response(200, json=report))
    try:
        assert remote.observe(sample(9))["observation"]["sim_elapsed_s"] == 10
        with pytest.raises(SecurityUnavailable):
            remote.observe(sample(11))
        with pytest.raises(SecurityUnavailable):
            remote.observe(sample(0, run_id="RUN-B", sample_id="RUN-B:0"))
    finally:
        remote.close()


@pytest.mark.parametrize("different", ["status", "events"])
def test_dashboard_rejects_responses_from_different_runs(different):
    import json

    module = SecurityStandIn()
    def dispatch(request):
        if request.method == "POST":
            body = module.observe(json.loads(request.content))
        elif request.url.path.endswith("/status"):
            body = module.status()
        else:
            body = module.events()
        if request.url.path.endswith("/" + different):
            body["run_id"] = "RUN-OTHER"
            for event in body.get("events", []):
                event["run_id"] = "RUN-OTHER"
        return httpx.Response(200, json=body)

    with TestClient(create_app(security=remote_with(dispatch))) as client:
        response = client.get("/api/security/dashboard")
        assert response.status_code == 503
        assert response.json()["overview"] is None
        assert response.json()["module"]["reachable"] is False


def test_embedded_inconsistent_run_failure_preserves_actual_placement():
    class InconsistentRun(SecurityStandIn):
        def status(self):
            return {**super().status(), "run_id": "RUN-OTHER"}

    with TestClient(create_app(security=InconsistentRun())) as client:
        response = client.get("/api/security/dashboard")
        assert response.status_code == 503
        assert response.json()["module"]["placement"] == "embedded"
