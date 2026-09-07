from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from typing import Any
from digital_twin.contracts.state import RuntimeSnapshot


def _status(value: float, target: float, inverse: bool = False, quality: str = "GOOD") -> str:
    if quality not in {"GOOD", "VALID"}:
        return "invalid"
    passed = value <= target if inverse else value >= target
    return "pass" if passed else "fail"


def evaluate(runtime: RuntimeSnapshot) -> dict[str, Any]:
    telemetry = deepcopy(runtime.current_telemetry)
    quality = runtime.data_quality
    aborted = sum(1 for mission in runtime.missions if mission.get("status") == "aborted")
    high_faults = sum(1 for fault in runtime.faults if fault.get("severity") == "high")
    mission_score = max(0.0, 98.0 - aborted * 30 - len(runtime.faults) * 4 - high_faults * 8)
    delay = float(telemetry.get("delay_ms") or 0)
    recovery = max([runtime.elapsed_seconds - fault["created_at"] for fault in runtime.faults] or [0.0])
    if not runtime.faults:
        recovery = 0.0
    integrity = float(telemetry.get("auth_percent") or 0)
    kpis = [
        {"id": "KPI-01", "name": "임무 건전성", "value": round(mission_score, 2), "target": 90.0, "unit": "%", "inverse": False, "formula": "98 - aborted×30 - faults×4 - high_faults×8", "source": "mission state + fault events"},
        {"id": "KPI-02", "name": "평균 링크 지연", "value": round(delay, 2), "target": 50.0, "unit": "ms", "inverse": True, "formula": "current deterministic telemetry.delay_ms", "source": "runtime telemetry snapshot"},
        {"id": "KPI-03", "name": "활성 장애 경과", "value": round(recovery, 2), "target": 60.0, "unit": "s", "inverse": True, "formula": "sim_time - earliest active fault", "source": "immutable event/fault state"},
        {"id": "KPI-04", "name": "인증·무결성", "value": round(integrity, 3), "target": 99.0, "unit": "%", "inverse": False, "formula": "telemetry.auth_percent", "source": "deterministic simulation"},
    ]
    for item in kpis:
        item["status"] = _status(item["value"], item["target"], item["inverse"], quality)
        item["delta"] = round(item["value"] - item["target"], 3)
        item["samples"] = max(1, runtime.sequence)
        item["missing_percent"] = 0.0
    by_id = {item["id"]: item for item in kpis}
    requirements = [
        {"id": "REQ-001", "name": "임무 건전성 유지", "test": "TC-MSN-01", "result": by_id["KPI-01"]["status"].upper(), "evidence": runtime.run_id, "kpi_id": "KPI-01"},
        {"id": "REQ-014", "name": "링크 지연 한계", "test": "TC-COM-07", "result": by_id["KPI-02"]["status"].upper(), "evidence": runtime.run_id, "kpi_id": "KPI-02"},
        {"id": "REQ-023", "name": "장애 대응 시간", "test": "TC-FLT-03", "result": by_id["KPI-03"]["status"].upper(), "evidence": runtime.run_id, "kpi_id": "KPI-03"},
        {"id": "REQ-031", "name": "보호전송 무결성", "test": "TC-SEC-09", "result": by_id["KPI-04"]["status"].upper(), "evidence": runtime.run_id, "kpi_id": "KPI-04"},
    ]
    verdict = "INVALID" if any(item["status"] == "invalid" for item in kpis) else "FAIL" if any(item["status"] == "fail" for item in kpis) else "PASS"
    pass_count = sum(item["status"] == "pass" for item in kpis)
    overall = round(pass_count / len(kpis) * 100, 1)
    return {
        "run_id": runtime.run_id,
        "scenario_id": runtime.scenario_id,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "overall": overall,
        "verdict": verdict,
        "kpis": kpis,
        "requirements": requirements,
        "provenance": {"mode": runtime.mode, "data_quality": quality, "is_simulation": True, "rule_set": "SIM-VNV-0.2", "recording": runtime.recording},
    }

