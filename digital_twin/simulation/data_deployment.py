"""Derive a storage roster and SIM products only from accepted SDC equipment."""
from copy import deepcopy

from digital_twin.model_library.data_deployment import DTN_STORAGE_GB, IMAGERY_PROFILE, OUTAGE_FAULT_KINDS, TELEMETRY_PROFILE
from .data_products import products_between


def deployment_inputs(deployment: dict, faults: list[dict]) -> dict:
    roster, profiles, available = [], {}, {}
    for node in deployment["nodes"]:
        enabled = [item for item in node["equipment"] if item["enabled"] and node["mode"] != "safe"]
        capacity = sum(DTN_STORAGE_GB for item in enabled if item["catalog"] == "dtn_store")
        down = next((fault for fault in faults if fault.get("target") == node["id"] and fault.get("active", True)
                     and fault.get("severity") == "high" and fault.get("kind") in OUTAGE_FAULT_KINDS), None)
        usable = capacity > 0 and down is None
        reason = "저장소 미설정" if not capacity else f"{down['kind']} (high)" if down else None
        roster.append({"id": node["id"], "name": node["name"], "kind": "onboard", "capacity_gb": capacity, "available": usable, "reason": reason})
        available[node["id"]] = usable
        if capacity:
            profiles[node["id"]] = [deepcopy(TELEMETRY_PROFILE)]
            if any(item["catalog"] == "eo_camera" for item in enabled):
                profiles[node["id"]].append(deepcopy(IMAGERY_PROFILE))
    return {"nodes": roster, "production": profiles, "available": available}


def deployment_products(inputs: dict, from_s: float, to_s: float) -> list[dict]:
    # One node produces at most 160 products per hour with the accepted SIM profiles,
    # safely below the legacy calculator's 400-product cap. Cover every interval;
    # advancing the delivery cursor after a truncated result would lose data forever.
    products = []
    begin = from_s
    while begin < to_s:
        end = min(begin + 3600, to_s)
        for node_id, profiles in sorted(inputs["production"].items()):
            products.extend(products_between({node_id: profiles}, begin, end, inputs["available"]))
        begin = end
    return products
