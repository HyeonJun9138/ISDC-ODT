from copy import deepcopy

MISSIONS = [
    {
        "id": "ODIN-01",
        "name": "Lunar Polar Survey",
        "status": "running",
        "progress": 72,
        "plan_version": 3,
        "tasks": [
            {"id": "T-01", "lane": "관측", "name": "Target Sweep", "start": 2, "duration": 14, "status": "done"},
            {"id": "T-02", "lane": "처리", "name": "Pre-process", "start": 14, "duration": 10, "status": "done", "predecessor": "T-01"},
            {"id": "T-03", "lane": "관측", "name": "Nadir Observation", "start": 24, "duration": 17, "status": "running"},
            {"id": "T-04", "lane": "저장", "name": "Data Pack", "start": 38, "duration": 15, "status": "planned"},
            {"id": "T-05", "lane": "전송", "name": "X-Band DL", "start": 51, "duration": 14, "status": "planned"},
            {"id": "T-06", "lane": "검증", "name": "Quicklook", "start": 62, "duration": 13, "status": "planned"},
            {"id": "T-07", "lane": "저장", "name": "Backup", "start": 74, "duration": 13, "status": "planned"},
            {"id": "T-08", "lane": "검증", "name": "Integrity Check", "start": 87, "duration": 11, "status": "planned"},
        ],
        "resources": {"power": 54, "link": 61, "compute": 68, "storage": 65},
        "success_conditions": ["핵심 관측 데이터 획득률 ≥ 90%", "다운링크 성공률 ≥ 92%", "데이터 무결성 ≥ 99%"],
    },
    {"id": "ODIN-02", "name": "Ionosphere Probe", "status": "planned", "progress": 18, "plan_version": 1, "tasks": [], "resources": {"power": 30, "link": 45, "compute": 40, "storage": 25}, "success_conditions": []},
    {"id": "ODIN-03", "name": "Deep Space Relay", "status": "idle", "progress": 0, "plan_version": 1, "tasks": [], "resources": {"power": 12, "link": 10, "compute": 8, "storage": 5}, "success_conditions": []},
]

def missions():
    return deepcopy(MISSIONS)
