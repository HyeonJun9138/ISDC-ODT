import math


def calculate_telemetry(elapsed_seconds: float, faults: list[dict]) -> dict:
    t = elapsed_seconds
    noise = lambda phase, scale=1.0: math.sin(t * 0.731 + phase) * scale + math.sin(t * 0.173 + phase * 0.31) * scale * 0.35
    fault_kinds = {item["kind"] for item in faults}
    link_penalty = 30 if "link_loss" in fault_kinds else 0
    latency_penalty = 85 if "latency_spike" in fault_kinds else 0
    power_penalty = 24 if "power_drop" in fault_kinds else 0
    thermal_penalty = 28 if "thermal_spike" in fault_kinds else 0
    storage_penalty = 22 if "storage_pressure" in fault_kinds else 0
    telemetry = {
        "power": round(max(0, 86 + 5 * math.sin(t / 34) + noise(1.1, 0.8) - power_penalty), 1),
        "temperature": round(24 + 3.8 * math.sin(t / 48) + noise(2.2, 0.3) + thermal_penalty, 1),
        "attitude_error": round(max(0.01, 0.12 + 0.06 * math.sin(t / 20) + noise(3.1, 0.008)), 3),
        "storage": round(min(99, 61 + 8 * math.sin(t / 90) + noise(4.2, 0.6) + storage_penalty), 1),
        "link_quality": round(max(0, 96 + 2 * math.sin(t / 18) + noise(5.4, 0.7) - link_penalty), 1),
        "delay_ms": round(max(1, 31.2 + 5 * math.sin(t / 14) + noise(6.2, 0.8) + latency_penalty), 1),
        "loss_percent": round(max(0, 0.32 + 0.18 * math.sin(t / 11) + noise(7.8, 0.025) + link_penalty / 20), 2),
        "throughput_mbps": round(max(0, 42.8 + 4 * math.sin(t / 17) + noise(8.7, 0.9) - link_penalty / 2), 1),
        "ber": max(1e-8, 1.2e-6 + noise(9.5, 7e-8) + link_penalty * 1e-7),
        "auth_percent": round(max(0, 99.8 + noise(10.3, 0.025)), 2),
    }
    return telemetry
