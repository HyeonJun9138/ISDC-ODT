"""Replica placement over the storage nodes (the DFS part of the stand-in).

The source node keeps the original copy while it has room. Extra replicas go to available nodes
with free capacity in the order core, edge, onboard, never twice on one node, and the ground
center with the most free space is preferred within a kind. Service requests are answered from
the verified replica on the node kind that serves fastest.
"""
from __future__ import annotations

from typing import Any

from .policy import PLACEMENT_ORDER, SERVE_BASE_MS, SERVE_PREFERENCE, SERVE_RATE_MBPS


def free_gb(node: dict) -> float:
    return float(node["capacity_gb"]) - float(node.get("used_gb", 0.0))


def has_room(node: dict, size_mb: float) -> bool:
    return node.get("available", True) and free_gb(node) * 1000 >= size_mb


def choose_targets(nodes: dict[str, dict], source: str | None, size_mb: float, count: int, exclude: set[str] | None = None) -> list[str]:
    """Nodes for `count` new replicas, source first when it exists and has room."""
    chosen: list[str] = []
    taken = set(exclude or ())
    if source and source in nodes and source not in taken and has_room(nodes[source], size_mb):
        chosen.append(source)
        taken.add(source)
    for kind in PLACEMENT_ORDER:
        if len(chosen) >= count:
            break
        candidates = [node for node in nodes.values() if node["kind"] == kind and node["id"] not in taken and has_room(node, size_mb)]
        candidates.sort(key=lambda node: (-free_gb(node), node["id"]))
        for node in candidates:
            if len(chosen) >= count:
                break
            chosen.append(node["id"])
            taken.add(node["id"])
    return chosen


def serving_replica(obj: dict, nodes: dict[str, dict]) -> dict | None:
    """The verified replica on the fastest available node kind, or None."""
    usable = [replica for replica in obj["replicas"] if replica["state"] == "verified" and nodes.get(replica["node"], {}).get("available", False)]
    for kind in SERVE_PREFERENCE:
        for replica in usable:
            if nodes[replica["node"]]["kind"] == kind:
                return replica
    return None


def serve_latency_ms(kind: str, size_mb: float) -> float:
    base = SERVE_BASE_MS.get(kind, 500.0)
    rate = SERVE_RATE_MBPS.get(kind, 100.0)
    return round(base + size_mb * 8 / rate * 1000, 1)


def overloaded(nodes: dict[str, dict], ratio: float) -> list[dict[str, Any]]:
    return [node for node in nodes.values() if node["capacity_gb"] and float(node.get("used_gb", 0.0)) / float(node["capacity_gb"]) >= ratio]
