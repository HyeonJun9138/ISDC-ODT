"""Storage node roster of the space data center and what each node produces.

The data management module (operations software, ICD-01) decides where data objects live and
whether they are intact; this file only says which storage nodes exist in the twin's world and
which data products the satellites generate. Capacities and rates are representative engineering
figures for the sandbox, not measured values.
"""
from copy import deepcopy

# kind: core = ground data center, edge = gateway or station cache, onboard = satellite storage.
STORAGE_NODES = [
    {"id": "DC-SEOUL", "name": "서울 데이터센터", "kind": "core", "capacity_gb": 2_000_000, "site": "GS-02"},
    {"id": "DC-JEJU", "name": "제주 미러 센터", "kind": "core", "capacity_gb": 1_000_000, "site": "GS-01"},
    {"id": "GW-OISL", "name": "OISL 게이트웨이 캐시", "kind": "edge", "capacity_gb": 200_000, "site": "GW-OISL"},
    {"id": "GW-DTN", "name": "DTN 게이트웨이 캐시", "kind": "edge", "capacity_gb": 200_000, "site": "GW-DTN"},
    {"id": "GS-01", "name": "지상국 1 캐시", "kind": "edge", "capacity_gb": 50_000, "site": "GS-01"},
    {"id": "GS-02", "name": "지상국 2 캐시", "kind": "edge", "capacity_gb": 50_000, "site": "GS-02"},
    {"id": "GS-03", "name": "지상국 3 캐시", "kind": "edge", "capacity_gb": 50_000, "site": "GS-03"},
    {"id": "SAT-01", "name": "SAT-01 탑재 저장소", "kind": "onboard", "capacity_gb": 512, "site": "SAT-01"},
    {"id": "SAT-02", "name": "SAT-02 탑재 저장소", "kind": "onboard", "capacity_gb": 512, "site": "SAT-02"},
    {"id": "SAT-03", "name": "SAT-03 탑재 저장소", "kind": "onboard", "capacity_gb": 512, "site": "SAT-03"},
    {"id": "SAT-04", "name": "SAT-04 탑재 저장소", "kind": "onboard", "capacity_gb": 512, "site": "SAT-04"},
    {"id": "SAT-05", "name": "SAT-05 탑재 저장소", "kind": "onboard", "capacity_gb": 512, "site": "SAT-05"},
]

# What each satellite registers with the data center: class, mean interval and size range.
PRODUCTION_PROFILES = {
    "SAT-01": [{"class": "imagery", "interval_s": 90, "size_mb": [400, 1200]}, {"class": "telemetry", "interval_s": 30, "size_mb": [8, 24]}],
    "SAT-02": [{"class": "imagery", "interval_s": 120, "size_mb": [400, 1000]}, {"class": "telemetry", "interval_s": 30, "size_mb": [8, 24]}],
    "SAT-03": [{"class": "science", "interval_s": 240, "size_mb": [150, 600]}, {"class": "telemetry", "interval_s": 30, "size_mb": [8, 24]}],
    "SAT-04": [{"class": "mission_log", "interval_s": 60, "size_mb": [1, 4]}, {"class": "telemetry", "interval_s": 30, "size_mb": [8, 24]}],
    "SAT-05": [{"class": "science", "interval_s": 180, "size_mb": [150, 500]}, {"class": "telemetry", "interval_s": 30, "size_mb": [8, 24]}],
}

# Runtime faults that take a storage node out of service while they are active.
OUTAGE_FAULT_KINDS = ("power_drop", "storage_pressure", "thermal_spike", "link_loss")


def data_center() -> dict:
    return deepcopy({"nodes": STORAGE_NODES, "production": PRODUCTION_PROFILES, "outage_fault_kinds": list(OUTAGE_FAULT_KINDS)})
