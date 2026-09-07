from copy import deepcopy

SCENARIOS = [
    {
        "id": "LEO_STANDARD",
        "name": "LEO Standard",
        "description": "저궤도 관측·중계 기준 시나리오",
        "satellite_group": "stations",
        "status": "ready",
        "duration_minutes": 420,
    },
    {
        "id": "OISL_STRESS",
        "name": "OISL Stress",
        "description": "링크 단절과 DTN 우회 검증",
        "satellite_group": "active",
        "status": "ready",
        "duration_minutes": 180,
    },
    {
        "id": "HIL_CLOSED_LOOP",
        "name": "HIL Closed Loop",
        "description": "EM/HIL 폐루프 통합 검증",
        "satellite_group": "stations",
        "status": "draft",
        "duration_minutes": 120,
    },
]

def scenarios():
    return deepcopy(SCENARIOS)
