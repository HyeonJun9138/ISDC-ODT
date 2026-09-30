"""Route selection over the usable links of the last network message.

The graph is undirected: every usable link joins its two endpoints in both directions. Costs per
objective are the one-way delay (latency), the negative log of the link quality (reliability) or a
weighted mix of both (balanced). Ground paths are found with one multi-source Dijkstra pass from
every ground station so each satellite learns its best path to the ground and its next hop.
"""
from __future__ import annotations

import heapq
import math
from typing import Any

OBJECTIVES = ("latency", "reliability", "balanced")


def edge_cost(link: dict, objective: str) -> float:
    quality = max(0.0, min(100.0, float(link.get("quality") or 0)))
    delay = float(link.get("delay_ms") or 0.0)
    if objective == "latency":
        return delay
    if objective == "reliability":
        return math.inf if quality <= 0 else -math.log(quality / 100)
    return delay * 0.65 + (100 - quality) * 1.1


def build_graph(links: list[dict]) -> dict[str, list[tuple[str, dict]]]:
    graph: dict[str, list[tuple[str, dict]]] = {}
    for link in links:
        if not link.get("usable"):
            continue
        a, b = str(link["a"]), str(link["b"])
        graph.setdefault(a, []).append((b, link))
        graph.setdefault(b, []).append((a, link))
    return graph


def _hop(link: dict, frm: str, to: str) -> dict[str, Any]:
    return {"link_id": link["id"], "from": frm, "to": to, "kind": link.get("kind"), "delay_ms": link.get("delay_ms"),
            "capacity_mbps": link.get("capacity_mbps"), "quality": link.get("quality")}


def summarize_hops(hops: list[dict]) -> dict[str, Any]:
    delay = sum(float(hop.get("delay_ms") or 0.0) for hop in hops)
    bottleneck = min((float(hop.get("capacity_mbps") or 0.0) for hop in hops), default=0.0)
    reliability = 1.0
    for hop in hops:
        reliability *= max(0.0, min(100.0, float(hop.get("quality") or 0))) / 100
    return {"hops": len(hops), "total_delay_ms": round(delay, 3), "bottleneck_mbps": round(bottleneck, 3),
            "reliability": round(reliability, 4)}


def shortest_path(graph: dict[str, list[tuple[str, dict]]], source: str, target: str, objective: str = "balanced") -> dict[str, Any] | None:
    if objective not in OBJECTIVES:
        raise ValueError(f"알 수 없는 경로 목적입니다: {objective}")
    if source == target:
        return {"path": [source], "hop_list": [], "cost": 0.0}
    best: dict[str, float] = {source: 0.0}
    queue: list[tuple[float, int, str, list[str], list[dict]]] = [(0.0, 0, source, [source], [])]
    counter = 0
    while queue:
        cost, _, node, path, hops = heapq.heappop(queue)
        if node == target:
            return {"path": path, "hop_list": hops, "cost": round(cost, 4)}
        if cost > best.get(node, math.inf):
            continue
        for neighbour, link in graph.get(node, []):
            edge = edge_cost(link, objective)
            if not math.isfinite(edge):
                continue
            candidate = cost + edge
            if candidate < best.get(neighbour, math.inf):
                best[neighbour] = candidate
                counter += 1
                heapq.heappush(queue, (candidate, counter, neighbour, path + [neighbour], hops + [_hop(link, node, neighbour)]))
    return None


def ground_paths(graph: dict[str, list[tuple[str, dict]]], ground_ids: list[str], objective: str = "latency") -> dict[str, dict[str, Any]]:
    """Best path from every reachable node to the nearest ground station under the objective."""
    if objective not in OBJECTIVES:
        raise ValueError(f"알 수 없는 경로 목적입니다: {objective}")
    best: dict[str, float] = {}
    previous: dict[str, tuple[str, dict] | None] = {}
    queue: list[tuple[float, int, str]] = []
    counter = 0
    for ground in ground_ids:
        best[ground] = 0.0
        previous[ground] = None
        counter += 1
        heapq.heappush(queue, (0.0, counter, ground))
    while queue:
        cost, _, node = heapq.heappop(queue)
        if cost > best.get(node, math.inf):
            continue
        for neighbour, link in graph.get(node, []):
            edge = edge_cost(link, objective)
            if not math.isfinite(edge):
                continue
            candidate = cost + edge
            if candidate < best.get(neighbour, math.inf):
                best[neighbour] = candidate
                previous[neighbour] = (node, link)
                counter += 1
                heapq.heappush(queue, (candidate, counter, neighbour))
    ground_set = set(ground_ids)
    result: dict[str, dict[str, Any]] = {}
    for node, cost in best.items():
        if node in ground_set:
            continue
        path = [node]
        hops: list[dict] = []
        cursor = node
        while previous.get(cursor) is not None:
            parent, link = previous[cursor]
            hops.append(_hop(link, cursor, parent))
            path.append(parent)
            cursor = parent
        result[node] = {"path": path, "hop_list": hops, "cost": round(cost, 4), "next_hop": path[1] if len(path) > 1 else None,
                        "ground": path[-1], **summarize_hops(hops)}
    return result
