"""Store-and-forward (DTN) backlog per satellite.

Each satellite generates data at its reported rate. While it has a usable path to the ground the
backlog drains through the path bottleneck; otherwise the data is kept on board up to the storage
capacity, and anything beyond that is dropped. The state advances by the elapsed analysis time
the twin reports between two network messages, so a paused analysis clock stops the model.
"""
from __future__ import annotations

from typing import Any

MAX_STEP_S = 3600.0


def advance_backlog(previous: dict[str, float], nodes: list[dict], paths: dict[str, dict], elapsed_s: float) -> dict[str, Any]:
    step = max(0.0, min(MAX_STEP_S, float(elapsed_s or 0.0)))
    stored: dict[str, float] = {}
    per_node: dict[str, dict[str, Any]] = {}
    delivered = 0.0
    dropped = 0.0
    for node in nodes:
        if node.get("kind") != "satellite":
            continue
        node_id = str(node["id"])
        generation_mbps = max(0.0, float(node.get("generation_mbps") or 0.0))
        capacity_mb = max(0.0, float(node.get("storage_gb") or 0.0)) * 1000
        before = max(0.0, float(previous.get(node_id, 0.0)))
        generated = generation_mbps * step / 8
        path = paths.get(node_id)
        drain_mbps = float(path.get("bottleneck_mbps") or 0.0) if path else 0.0
        drained = drain_mbps * step / 8
        pending = before + generated
        if path and drain_mbps > 0:
            sent = min(pending, drained)
            after = pending - sent
            delivered += sent
            custody = "forwarding" if after > 0 else "passing"
        else:
            after = pending
            custody = "storing"
        if capacity_mb and after > capacity_mb:
            dropped += after - capacity_mb
            after = capacity_mb
            custody = "full"
        if generation_mbps == 0 and after == 0:
            custody = "idle"
        stored[node_id] = round(after, 3)
        per_node[node_id] = {
            "stored_mb": round(after, 3),
            "capacity_mb": round(capacity_mb, 1),
            "generation_mbps": generation_mbps,
            "drain_mbps": round(drain_mbps, 3),
            "custody": custody,
        }
    return {"stored": stored, "nodes": per_node, "delivered_mb": round(delivered, 3), "dropped_mb": round(dropped, 3), "step_s": step}
