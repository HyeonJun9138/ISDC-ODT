"""Data objects, replicas and the ingest filter of the data management stand-in.

An object is one registered data product. Each replica records the storage node it lives on and
its state: `verified` (checksum confirmed), `syncing` (copy in progress), `stale` (node returned
after an outage, copy not yet re-checked), `unreachable` (node currently unavailable), `corrupt`
(checksum mismatch found) or `lost` (node reported the copy gone). Replica states other than
`verified` do not count toward the replication target.
"""
from __future__ import annotations

import hashlib
from typing import Any

from .policy import DATA_CLASSES

COUNTING_STATES = ("verified",)
DAMAGED_STATES = ("corrupt", "lost")


def checksum_of(ref: str, size_mb: float, version: int = 1) -> str:
    return hashlib.sha256(f"{ref}|{size_mb:.3f}|{version}".encode("utf-8")).hexdigest()[:16]


def filter_product(product: dict, filters: dict, known_refs: set[str]) -> str | None:
    """Return a rejection reason or None when the product passes the extraction filter."""
    if product.get("class") not in DATA_CLASSES:
        return "unknown_class"
    if product["class"] not in filters.get("accept_classes", list(DATA_CLASSES)):
        return "class_filtered"
    size = float(product.get("size_mb") or 0.0)
    if size <= 0:
        return "empty"
    if size < float(filters.get("min_size_mb", 0.0)):
        return "below_min_size"
    if int(product.get("priority", 1)) < int(filters.get("drop_priority_below", 0)):
        return "low_priority"
    if filters.get("dedupe_by_ref", True) and product.get("ref") in known_refs:
        return "duplicate"
    return None


def make_object(object_id: str, product: dict, created_s: float) -> dict[str, Any]:
    spec = DATA_CLASSES[product["class"]]
    size = round(float(product["size_mb"]), 3)
    return {
        "id": object_id,
        "ref": str(product.get("ref") or object_id),
        "class": product["class"],
        "label": str(product.get("label") or f"{spec['label']} {object_id}"),
        "source": str(product.get("source") or "unknown"),
        "size_mb": size,
        "priority": int(product.get("priority", spec["priority"])),
        "created_s": round(created_s, 3),
        "version": 1,
        "checksum": checksum_of(str(product.get("ref") or object_id), size, 1),
        "tier": "hot",
        "retention_days": int(product.get("retention_days") or spec["retention_days"]),
        "replicas": [],
        "status": "pending",
        "reason": None,
        "requests": 0,
        "last_verified_s": created_s,
    }


def counted_replicas(obj: dict) -> int:
    return sum(1 for replica in obj["replicas"] if replica["state"] in COUNTING_STATES)


def damaged_replicas(obj: dict) -> int:
    return sum(1 for replica in obj["replicas"] if replica["state"] in DAMAGED_STATES)


def evaluate_status(obj: dict, target: int) -> dict:
    """Update the object's status from its replicas against the replication target."""
    counted = counted_replicas(obj)
    damaged = damaged_replicas(obj)
    if obj["status"] == "expired":
        return obj
    pending = sum(1 for replica in obj["replicas"] if replica["state"] in ("syncing", "stale"))
    if counted == 0:
        obj["status"] = "critical" if pending == 0 else "pending"
        obj["reason"] = "no_verified_replica" if pending == 0 else "initial_sync"
    elif damaged:
        obj["status"] = "degraded"
        obj["reason"] = "integrity"
    elif counted < target:
        # Copies still being written are progress, not a policy breach.
        obj["status"] = "pending" if counted + pending >= target else "degraded"
        obj["reason"] = "sync_pending" if obj["status"] == "pending" else "under_replicated"
    else:
        obj["status"] = "healthy"
        obj["reason"] = "sync_pending" if pending else None
    return obj


def tier_for(obj: dict, now_s: float) -> str:
    spec = DATA_CLASSES[obj["class"]]
    age_h = max(0.0, now_s - obj["created_s"]) / 3600
    if age_h <= spec["hot_hours"]:
        return "hot"
    if age_h <= 24 * 7:
        return "warm"
    return "cold"


def expired(obj: dict, now_s: float) -> bool:
    return now_s - obj["created_s"] > obj["retention_days"] * 86400


def public_object(obj: dict) -> dict:
    replicas = [dict(replica) for replica in obj["replicas"]]
    return {**obj, "replicas": replicas, "verified_replicas": counted_replicas(obj), "damaged_replicas": damaged_replicas(obj)}
