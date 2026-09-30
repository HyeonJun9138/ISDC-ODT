"""The data fabric stand-in that answers ICD-02 messages.

update()  네트워크 상태 갱신 (DT → 패브릭): the twin's nodes and links with their geometry and
          terminal states. Returns link quality, the best ground path per satellite and the DTN
          backlog (패브릭 → DT).
route()   경로 계산 요청: the best path between two nodes over the last network state.
status()  모듈 상태: implementation, version, sequence and last update time.

The object holds the last network state and the backlog, which is what the real module would also
have to remember. It does not hold any twin state and never invents links the twin did not report.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from .bundles import advance_backlog
from .link_metrics import LINK_KINDS, link_metrics
from .routing import OBJECTIVES, build_graph, ground_paths, shortest_path, summarize_hops

STAND_IN_VERSION = "0.1"
NODE_KINDS = ("satellite", "ground")


def _parse_time(value: Any) -> datetime:
    if isinstance(value, datetime):
        stamp = value
    else:
        text = str(value or "").strip()
        if not text:
            raise ValueError("네트워크 상태 갱신 메시지에 time(UTC ISO 8601)이 필요합니다.")
        try:
            stamp = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError(f"time 값을 해석할 수 없습니다: {text}") from error
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(timezone.utc)


def _validate(snapshot: dict) -> tuple[datetime, list[dict], list[dict]]:
    if not isinstance(snapshot, dict):
        raise ValueError("네트워크 상태 갱신 메시지는 객체여야 합니다.")
    stamp = _parse_time(snapshot.get("time"))
    nodes = snapshot.get("nodes")
    links = snapshot.get("links")
    if not isinstance(nodes, list) or not isinstance(links, list):
        raise ValueError("nodes와 links 목록이 필요합니다.")
    ids: set[str] = set()
    for node in nodes:
        if not isinstance(node, dict) or not node.get("id"):
            raise ValueError("노드에는 id가 필요합니다.")
        if node.get("kind") not in NODE_KINDS:
            raise ValueError(f"노드 {node.get('id')}의 kind는 satellite 또는 ground여야 합니다.")
        node_id = str(node["id"])
        if node_id in ids:
            raise ValueError(f"노드 id가 중복됩니다: {node_id}")
        ids.add(node_id)
    link_ids: set[str] = set()
    for link in links:
        if not isinstance(link, dict) or not link.get("id"):
            raise ValueError("링크에는 id가 필요합니다.")
        if link.get("kind") not in LINK_KINDS:
            raise ValueError(f"링크 {link.get('id')}의 kind는 {', '.join(LINK_KINDS)} 중 하나여야 합니다.")
        if str(link.get("a")) not in ids or str(link.get("b")) not in ids:
            raise ValueError(f"링크 {link.get('id')}의 끝점이 노드 목록에 없습니다.")
        if str(link["id"]) in link_ids:
            raise ValueError(f"링크 id가 중복됩니다: {link['id']}")
        link_ids.add(str(link["id"]))
    return stamp, nodes, links


class DataFabricStandIn:
    implementation = "stand_in"
    version = STAND_IN_VERSION

    def __init__(self) -> None:
        self._sequence = 0
        self._last_time: datetime | None = None
        self._nodes: list[dict] = []
        self._links: list[dict] = []
        self._graph: dict[str, list[tuple[str, dict]]] = {}
        self._backlog: dict[str, float] = {}
        self._delivered_mb = 0.0
        self._dropped_mb = 0.0
        self._report: dict[str, Any] | None = None

    def update(self, snapshot: dict) -> dict:
        stamp, nodes, links = _validate(snapshot)
        elapsed = 0.0
        if self._last_time is not None:
            elapsed = (stamp - self._last_time).total_seconds()
            if elapsed < 0:
                # The analysis clock moved backwards: no reverse history exists, so the backlog restarts.
                self._backlog = {}
                self._delivered_mb = 0.0
                self._dropped_mb = 0.0
                elapsed = 0.0
        metrics = [link_metrics(link) for link in links]
        graph = build_graph(metrics)
        ground_ids = [str(node["id"]) for node in nodes if node.get("kind") == "ground"]
        paths = ground_paths(graph, ground_ids, "latency")
        for node in nodes:
            extra = float(node.get("extra_delay_ms") or 0.0)
            if extra:
                for entry in paths.values():
                    if str(node["id"]) in entry["path"]:
                        entry["total_delay_ms"] = round(entry["total_delay_ms"] + extra, 3)
        backlog = advance_backlog(self._backlog, nodes, paths, elapsed)
        self._backlog = backlog["stored"]
        self._delivered_mb += backlog["delivered_mb"]
        self._dropped_mb += backlog["dropped_mb"]
        self._sequence += 1
        self._last_time = stamp
        self._nodes = deepcopy(nodes)
        self._links = metrics
        self._graph = graph
        node_reports = []
        satellites = 0
        with_ground = 0
        delays: list[float] = []
        for node in nodes:
            node_id = str(node["id"])
            entry: dict[str, Any] = {"id": node_id, "kind": node.get("kind")}
            if node.get("kind") == "satellite":
                satellites += 1
                path = paths.get(node_id)
                if path:
                    with_ground += 1
                    delays.append(float(path["total_delay_ms"]))
                entry.update({
                    "ground_path": path["path"] if path else None,
                    "ground_station": path["ground"] if path else None,
                    "next_hop": path["next_hop"] if path else None,
                    "ground_hops": path["hops"] if path else None,
                    "ground_delay_ms": path["total_delay_ms"] if path else None,
                    "ground_bottleneck_mbps": path["bottleneck_mbps"] if path else None,
                    **backlog["nodes"].get(node_id, {"stored_mb": 0.0, "capacity_mb": 0.0, "generation_mbps": 0.0, "drain_mbps": 0.0, "custody": "idle"}),
                })
            else:
                served = sorted(sat for sat, path in paths.items() if path["ground"] == node_id)
                entry.update({"serving": served, "direct_links": sum(1 for link in metrics if link["usable"] and link["kind"] == "ground" and node_id in (link["a"], link["b"]))})
            node_reports.append(entry)
        usable = [link for link in metrics if link["usable"]]
        self._report = {
            "time": stamp.isoformat().replace("+00:00", "Z"),
            "sequence": self._sequence,
            "elapsed_s": round(backlog["step_s"], 3),
            "implementation": self.implementation,
            "version": self.version,
            "links": metrics,
            "nodes": node_reports,
            "summary": {
                "nodes": len(nodes),
                "satellites": satellites,
                "ground_stations": len(ground_ids),
                "links": len(metrics),
                "usable_links": len(usable),
                "usable_oisl": sum(1 for link in usable if link["kind"] == "oisl"),
                "usable_ground": sum(1 for link in usable if link["kind"] == "ground"),
                "satellites_with_ground_path": with_ground,
                "mean_ground_delay_ms": round(sum(delays) / len(delays), 3) if delays else None,
                "stored_mb": round(sum(self._backlog.values()), 3),
                "delivered_mb": round(self._delivered_mb, 3),
                "dropped_mb": round(self._dropped_mb, 3),
            },
        }
        return deepcopy(self._report)

    def route(self, source: str, target: str, objective: str = "balanced") -> dict:
        if objective not in OBJECTIVES:
            raise ValueError(f"알 수 없는 경로 목적입니다: {objective}")
        base = {"source": source, "target": target, "objective": objective, "sequence": self._sequence}
        if self._report is None:
            return {**base, "status": "no_network", "path": [], "hop_list": [], "hops": 0, "total_delay_ms": None, "bottleneck_mbps": None, "reliability": None, "cost": None}
        known = {str(node["id"]) for node in self._nodes}
        if source not in known or target not in known:
            raise ValueError("출발지 또는 목적지가 마지막 네트워크 상태에 없습니다.")
        found = shortest_path(self._graph, source, target, objective)
        if not found:
            return {**base, "status": "unavailable", "path": [], "hop_list": [], "hops": 0, "total_delay_ms": None, "bottleneck_mbps": None, "reliability": None, "cost": None}
        return {**base, "status": "available", "path": found["path"], "hop_list": found["hop_list"], "cost": found["cost"], **summarize_hops(found["hop_list"])}

    def status(self) -> dict:
        return {
            "module": "data_fabric",
            "implementation": self.implementation,
            "version": self.version,
            "placement": "embedded",
            "endpoint": "in-process",
            "sequence": self._sequence,
            "last_update": self._report["time"] if self._report else None,
            "nodes": len(self._nodes),
            "links": len(self._links),
            "reachable": True,
        }
