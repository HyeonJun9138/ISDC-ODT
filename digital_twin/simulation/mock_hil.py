from copy import deepcopy
from datetime import datetime, timezone


def apply_device_action(device: dict, action: str) -> dict:
    device = deepcopy(device)
    if action == "connect":
        device.update(connected=True, health=max(device["health"], 88), latency_ms=device["latency_ms"] or 14.2)
    elif action == "disconnect":
        device["connected"] = False
    elif action == "sync":
        if not device["connected"]:
            raise ValueError("먼저 장비를 연결해야 합니다.")
        device["latency_ms"] = round(max(1.0, device["latency_ms"] * 0.84), 1)
        device["clock_offset_us"] = round(max(0.5, float(device.get("clock_offset_us") or 45) * 0.55), 2)
        device["jitter_us"] = round(max(0.2, float(device.get("jitter_us") or 8) * 0.65), 2)
        device["clock_state"] = "LOCKED"
    elif action == "loopback":
        if not device["connected"]:
            raise ValueError("먼저 장비를 연결해야 합니다.")
        device["health"] = min(100, device["health"] + 1)
    return device


def preflight(devices: list[dict], status: dict) -> dict:
    checks = []
    for device in devices:
        checks.append({"id": f"connect:{device['id']}", "name": f"{device['name']} 연결", "passed": bool(device["connected"]), "value": "ONLINE" if device["connected"] else "OFFLINE"})
        if device["connected"]:
            offset = float(device.get("clock_offset_us") or 999999)
            checks.append({"id": f"clock:{device['id']}", "name": f"{device['name']} 시각 오프셋", "passed": offset <= 50, "value": f"{offset:.2f} µs"})
            checks.append({"id": f"lock:{device['id']}", "name": f"{device['name']} 시각 상태", "passed": device.get("clock_state") == "LOCKED", "value": device.get("clock_state", "UNKNOWN")})
    checks.append({"id": "recording", "name": "시험 기록", "passed": status["recording"], "value": "REC" if status["recording"] else "OFF"})
    passed = all(check["passed"] for check in checks)
    return {"run_id": status["run_id"], "passed": passed, "status": "READY" if passed else "BLOCKED", "checks": checks, "mode": "MOCK-HIL", "evaluated_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
