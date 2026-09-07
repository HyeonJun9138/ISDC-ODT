import asyncio

from data.catalog.records import _catalog_page, _catalog_truncated, _satcat_fallback_from_gp
from digital_twin.simulation.orbital_elements import derive_orbit as _derive_orbit
from digital_twin.simulation.rf_network import calculate_link_budget, calculate_route
from user_application.bootstrap import create_runtime


def test_orbit_derivation_and_regime():
    derived = _derive_orbit(
        {
            "MEAN_MOTION": 15.5,
            "ECCENTRICITY": 0.001,
            "EPOCH": "2026-07-10T00:00:00+00:00",
        }
    )
    assert 90 < derived["PERIOD_MINUTES"] < 95
    assert derived["ORBIT_REGIME"] == "LEO"
    assert derived["APOGEE_KM"] > derived["PERIGEE_KM"]


def test_zero_catalog_limit_returns_every_filtered_satellite():
    items = [{"NORAD_CAT_ID": index} for index in range(15_985)]
    page = _catalog_page(items, offset=0, limit=0)
    assert len(page) == 15_985
    assert _catalog_truncated(len(items), 0, len(page), 0) is False


def test_satcat_fallback_preserves_identification_and_orbit_values():
    profile = _satcat_fallback_from_gp(
        {
            "OBJECT_NAME": "TEST SAT",
            "OBJECT_ID": "2026-001A",
            "NORAD_CAT_ID": 99901,
            "PERIOD_MINUTES": 95.2,
            "INCLINATION": 97.4,
            "APOGEE_KM": 560.0,
            "PERIGEE_KM": 540.0,
        }
    )
    assert profile["OBJECT_NAME"] == "TEST SAT"
    assert profile["NORAD_CAT_ID"] == 99901
    assert profile["PERIOD"] == 95.2
    assert profile["APOGEE"] == 560.0


def test_link_budget_is_reproducible_and_route_respects_fault_target():
    request = {
        "link_id": "L01",
        "frequency_ghz": 26.0,
        "distance_km": 1200.0,
        "tx_power_w": 20.0,
        "tx_gain_dbi": 32.0,
        "rx_gain_dbi": 34.0,
        "misc_losses_db": 3.0,
        "bandwidth_mhz": 20.0,
        "data_rate_mbps": 10.0,
        "system_temp_k": 290.0,
        "required_ebno_db": 7.0,
    }
    assert calculate_link_budget(request) == calculate_link_budget(request)
    normal = calculate_route("SAT-01", "SAT-02", "balanced", [])
    faulted = calculate_route("SAT-01", "SAT-02", "balanced", [{"target": "L01"}])
    assert normal["status"] == "available"
    assert "L01" in normal["link_ids"]
    assert faulted["status"] == "available"
    assert "L01" not in faulted["link_ids"]


def test_runtime_snapshot_is_stable_and_event_payload_is_immutable():
    state = create_runtime()
    first = state.telemetry()["telemetry"]
    second = state.telemetry()["telemetry"]
    assert first == second
    payload = {"nested": {"value": 1}}
    state._emit("test.event", "info", "immutable", payload)
    payload["nested"]["value"] = 999
    assert state.events[0]["payload"]["nested"]["value"] == 1
    assert state.events[0]["run_id"] == state.run_id


def test_mission_validation_task_edit_and_replan():
    state = create_runtime()

    async def scenario():
        created = await state.mutate_task(
            {
                "mission_id": "ODIN-01",
                "task_id": None,
                "operation": "create",
                "lane": "관측",
                "name": "Conflict Task",
                "start": 5,
                "duration": 20,
                "status": "planned",
                "predecessor": None,
                "priority": 5,
            }
        )
        assert created["validation"]["conflict_count"] >= 1
        replanned = await state.replan_mission("ODIN-01", True)
        assert replanned["mission"]["plan_version"] >= 5
        return replanned

    result = asyncio.run(scenario())
    assert result["applied"] is True


def test_hil_preflight_does_not_claim_ready_when_required_device_is_offline():
    state = create_runtime()
    preflight = state.hil_preflight()
    assert preflight["status"] == "BLOCKED"
    assert any(not check["passed"] for check in preflight["checks"])
