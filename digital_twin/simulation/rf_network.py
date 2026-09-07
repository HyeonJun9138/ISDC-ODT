from __future__ import annotations

import heapq
import math
from datetime import datetime, timedelta, timezone
from typing import Any

from digital_twin.model_library.network import communication


BOLTZMANN = 1.380649e-23


def calculate_link_budget(request: dict[str, Any]) -> dict[str, Any]:
    frequency_ghz = float(request["frequency_ghz"])
    distance_km = float(request["distance_km"])
    tx_power_w = float(request["tx_power_w"])
    bandwidth_hz = float(request["bandwidth_mhz"]) * 1e6
    data_rate_bps = float(request["data_rate_mbps"]) * 1e6
    tx_power_dbw = 10 * math.log10(tx_power_w)
    eirp_dbw = tx_power_dbw + float(request["tx_gain_dbi"])
    fspl_db = 92.45 + 20 * math.log10(frequency_ghz) + 20 * math.log10(distance_km)
    received_dbw = eirp_dbw + float(request["rx_gain_dbi"]) - fspl_db - float(request["misc_losses_db"])
    noise_dbw = 10 * math.log10(BOLTZMANN * float(request["system_temp_k"]) * bandwidth_hz)
    cn_db = received_dbw - noise_dbw
    ebno_db = cn_db + 10 * math.log10(bandwidth_hz / data_rate_bps)
    margin_db = ebno_db - float(request["required_ebno_db"])
    snr_linear = 10 ** (cn_db / 10)
    shannon_mbps = bandwidth_hz * math.log2(1 + snr_linear) / 1e6
    return {
        "link_id": request["link_id"],
        "model": "RF-Friis-v1",
        "inputs": request,
        "eirp_dbw": round(eirp_dbw, 3),
        "fspl_db": round(fspl_db, 3),
        "received_power_dbw": round(received_dbw, 3),
        "noise_power_dbw": round(noise_dbw, 3),
        "cn_db": round(cn_db, 3),
        "ebno_db": round(ebno_db, 3),
        "margin_db": round(margin_db, 3),
        "capacity_mbps": round(shannon_mbps, 3),
        "status": "pass" if margin_db >= 3 else "marginal" if margin_db >= 0 else "fail",
        "assumptions": ["자유공간 손실", "시스템 잡음온도 일정", "misc_losses_db에 대기·포인팅·케이블 손실 포함"],
    }


def _link_cost(link: dict, objective: str, fault_targets: set[str]) -> float:
    if link["id"] in fault_targets or link["source"] in fault_targets or link["target"] in fault_targets:
        return math.inf
    quality = max(1, float(link["quality"]))
    delay = float(link.get("delay_ms") or (18 + (100 - quality) * 1.2))
    if objective == "latency":
        return delay
    if objective == "reliability":
        return -math.log(quality / 100)
    return delay * 0.65 + (100 - quality) * 1.1


def calculate_route(source: str, target: str, objective: str, active_faults: list[dict]) -> dict[str, Any]:
    graph: dict[str, list[tuple[str, dict]]] = {}
    links = communication()["links"]
    for link in links:
        graph.setdefault(link["source"], []).append((link["target"], link))
        graph.setdefault(link["target"], []).append((link["source"], link))
    fault_targets = {str(fault.get("target")) for fault in active_faults}
    queue: list[tuple[float, str, list[str], list[str]]] = [(0.0, source, [source], [])]
    best: dict[str, float] = {source: 0.0}
    while queue:
        cost, node, path, link_ids = heapq.heappop(queue)
        if node == target:
            return {
                "source": source,
                "target": target,
                "objective": objective,
                "path": path,
                "link_ids": link_ids,
                "hops": len(link_ids),
                "cost": round(cost, 3),
                "status": "available",
                "active_fault_targets": sorted(fault_targets),
            }
        if cost > best.get(node, math.inf):
            continue
        for neighbor, link in graph.get(node, []):
            edge = _link_cost(link, objective, fault_targets)
            if not math.isfinite(edge):
                continue
            new_cost = cost + edge
            if new_cost < best.get(neighbor, math.inf):
                best[neighbor] = new_cost
                heapq.heappush(queue, (new_cost, neighbor, path + [neighbor], link_ids + [link["id"]]))
    return {"source": source, "target": target, "objective": objective, "path": [], "link_ids": [], "hops": 0, "cost": None, "status": "unavailable", "active_fault_targets": sorted(fault_targets)}


def contact_plan(hours: int = 12) -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    links = communication()["links"]
    windows: list[dict[str, Any]] = []
    for index, link in enumerate(links):
        for cycle in range(2):
            start_minutes = (index * 19 + cycle * 210) % max(60, hours * 60 - 45)
            duration = 18 + (link["quality"] % 34)
            start = now + timedelta(minutes=start_minutes)
            end = start + timedelta(minutes=duration)
            windows.append(
                {
                    "id": f"CW-{link['id']}-{cycle + 1}",
                    "link_id": link["id"],
                    "source": link["source"],
                    "target": link["target"],
                    "start": start.isoformat(),
                    "end": end.isoformat(),
                    "duration_minutes": duration,
                    "quality": link["quality"],
                    "capacity_mb": round(duration * max(1, link["quality"] - 30) * 0.75, 1),
                    "provenance": "scenario-contact-plan-v1",
                }
            )
    return sorted(windows, key=lambda item: item["start"])

