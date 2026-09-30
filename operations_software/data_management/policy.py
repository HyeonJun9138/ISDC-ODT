"""Data classes, placement policy and filter rules of the data management stand-in.

These are the module's own configuration (a real module would ship its own). Sizes are in MB,
times in seconds of the twin's simulation clock. Values are representative figures for a sandbox.
"""
from __future__ import annotations

from copy import deepcopy

DATA_CLASSES = {
    "imagery": {"label": "관측 영상", "replication": 3, "retention_days": 365, "hot_hours": 24, "priority": 2},
    "science": {"label": "과학 관측", "replication": 3, "retention_days": 730, "hot_hours": 48, "priority": 2},
    "telemetry": {"label": "위성 텔레메트리", "replication": 2, "retention_days": 90, "hot_hours": 6, "priority": 1},
    "mission_log": {"label": "임무 로그", "replication": 2, "retention_days": 180, "hot_hours": 12, "priority": 1},
    "ops_snapshot": {"label": "DT 운용 스냅샷", "replication": 2, "retention_days": 30, "hot_hours": 2, "priority": 0},
}

NODE_KINDS = ("core", "edge", "onboard")

# Placement order for extra replicas beyond the source copy, by node kind.
PLACEMENT_ORDER = ("core", "edge", "onboard")

DEFAULT_POLICY = {
    "replication": {name: spec["replication"] for name, spec in DATA_CLASSES.items()},
    "filters": {"min_size_mb": 0.01, "accept_classes": sorted(DATA_CLASSES), "drop_priority_below": 0, "dedupe_by_ref": True},
    "verify_interval_s": 300,
    "sync_rate_mbps": 800,
    "heal_rate_mbps": 400,
    "outage_grace_s": 60,
    "capacity_warning_ratio": 0.8,
    "corruption_rate": 0.03,
    "auto_request_interval_s": 25,
    "window_s": 300,
}

# Service latency figures by the kind of node that serves a request.
SERVE_BASE_MS = {"core": 40.0, "edge": 80.0, "onboard": 450.0}
SERVE_RATE_MBPS = {"core": 2000.0, "edge": 800.0, "onboard": 200.0}
SERVE_PREFERENCE = ("core", "edge", "onboard")


def default_policy() -> dict:
    return deepcopy(DEFAULT_POLICY)


def class_spec(name: str) -> dict | None:
    spec = DATA_CLASSES.get(name)
    return deepcopy(spec) if spec else None
