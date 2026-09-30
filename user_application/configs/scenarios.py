"""Operational scenarios of the SIM runtime and the PoC playback scenarios.

The first three entries are the legacy SIM scenarios the runtime has always listed. The PoC
scenarios (`kind: "poc"`) carry a full definition the console's scenario player consumes: the
constellation to lay out, the ground stations, the missions to register with the constellation
operations module, the timeline steps with their guidance, the actions each step performs and the
criteria of the final recovery verdict. Everything here is data; the browser assembles the nodes
with the node model library and drives the modules through their ICDs.

Placeholders of the form `@role` refer to the satellite that holds a constellation role, and
`{a.b}` inside narratives are filled by the player from the live context (plans, routes, faults).
"""
import json
from copy import deepcopy
from functools import lru_cache

from user_application.configs.paths import WEB_DIR

SCENARIOS = [
    {
        "id": "LEO_STANDARD",
        "name": "LEO Standard",
        "description": "저궤도 관측·중계 기준 시나리오",
        "satellite_group": "stations",
        "status": "ready",
        "duration_minutes": 420,
        "kind": "sim",
    },
    {
        "id": "OISL_STRESS",
        "name": "OISL Stress",
        "description": "링크 단절과 DTN 우회 검증",
        "satellite_group": "active",
        "status": "ready",
        "duration_minutes": 180,
        "kind": "sim",
    },
    {
        "id": "HIL_CLOSED_LOOP",
        "name": "HIL Closed Loop",
        "description": "EM/HIL 폐루프 통합 검증",
        "satellite_group": "stations",
        "status": "draft",
        "duration_minutes": 120,
        "kind": "sim",
    },
    {
        "id": "SDC_POC_01",
        "name": "PoC 1차 · OISL 주 링크 단절과 우회 복구",
        "description": "정상 운용 → Fault 주입 → 상태 전달 → 우회·재전송 → 복구 판정의 전체 실행 흐름을 40기 SDC 군집으로 검증한다.",
        "satellite_group": "active",
        "status": "ready",
        "duration_minutes": 12,
        "kind": "poc",
        "version": "1.0",
    },
]

STEP_TABS = ("orbit", "nodes", "communication", "data", "security", "mission", "status", "settings")
ACTION_KINDS = ("route", "sample", "inject_fault", "verify_link_unusable", "replan_mission", "dm_request", "verdict", "switch_tab")
ANCHOR_KINDS = ("task", "mission_end", "fault_end")

# Metrics the verdict and the step checks may refer to. The browser KPI module computes them from
# the samples the player collects; names not listed here are rejected by validate_definition().
METRICS = (
    "route.status", "route.hops", "route.total_delay_ms", "route.reliability", "route.reconverge_s", "route.primary_restored",
    "mission.relay.status", "mission.relay.margin_s", "mission.relay.hops", "mission.relay.latency_ms", "mission.relay.feasible",
    "fabric.usable_links", "fabric.fault_link_unusable", "fabric.source_custody", "fabric.source_stored_mb", "fabric.source_stored_ratio_max",
    "data.stability", "data.stability_min", "data.objects", "data.degraded", "data.service_status", "data.service_latency_ms",
    "security.authentication", "security.auth_percent", "security.nominal_throughout",
)

SDC_POC_01 = {
    "id": "SDC_POC_01",
    "objective": "OISL 주 링크 하나가 끊겼을 때 디지털 트윈이 장애를 공통 상태로 전달하고, 군집 운용 모듈과 데이터 패브릭이 대체 경로로 재전송하며, 정상 대비 KPI로 복구를 판정한다.",
    "constellation": {
        "prefix": "SDC", "preset": "walker_delta", "planes": 4, "per_plane": 10, "altitude_km": 550, "inclination": 53,
        "phasing": 1, "raan_start": 0, "raan_spread": 60, "anomaly_start": 0, "bus": "comms_small", "link_policy": "grid",
        # Display model of every satellite (user_application/web/assets/models/manifest.json key); a role may
        # override it with its own model_key. The NASA Earth Observing-1 model stands in for the SDC bus.
        "model_key": "eo_1",
        "note": "네 궤도면을 승교점 적경 60° 안에 촘촘히 두어 같은 면의 앞뒤 링크와 인접 면의 좌우 링크가 모두 성립하는 격자다. 면당 10기는 표준 광 단말의 정격 거리 5,000 km와 지구 가림 조건을 만족한다.",
        "equipment": {"all": ["dtn_store"], "roles": {"source": ["eo_camera"], "gateway": ["x_band_downlink"], "gateway_b": ["x_band_downlink"], "gateway_c": ["x_band_downlink"], "gateway_d": ["x_band_downlink"]}},
        "roles": {
            "source": {"label": "N1 · 데이터 생성", "plane": 0, "index": 2},
            "relay": {"label": "N2 · 주 경로 중계", "plane": 0, "index": 3},
            "alternate": {"label": "N3 · 우회 중계", "plane": 1, "index": 2},
            "gateway": {"label": "N4 · 관문", "plane": 0, "index": 4},
            "gateway_b": {"label": "관문 B", "plane": 1, "index": 4},
            "gateway_c": {"label": "관문 C", "plane": 2, "index": 4},
            "gateway_d": {"label": "관문 D", "plane": 3, "index": 4},
        },
    },
    "stations": ["daejeon", "jeju", "svalbard"],
    "missions": [
        {"key": "relay", "kind": "relay", "name": "N1→N4 데이터 중계", "requester": "우주 데이터 센터 운용팀", "priority": 2, "deadline_hours": 2, "commit": True,
         "params": {"source": "satellite:@source", "destination": "satellite:@gateway", "volume_mb": 120000, "max_latency_ms": 40}},
        {"key": "observe", "kind": "observe", "name": "독도 관측 인도", "requester": "국토 관측 고객", "priority": 3, "deadline_hours": 24, "commit": True,
         "params": {"target": "dokdo", "target_name": "독도", "latitude": 37.2431, "longitude": 131.8643, "max_off_nadir_deg": 60, "product_mb": 800, "processing": True, "processing_ratio": 0.4, "preferred_satellite": "@source"}},
        {"key": "fleet_update", "kind": "fleet_update", "name": "관문 소프트웨어 갱신", "requester": "군집 운용팀", "priority": 4, "deadline_hours": 6, "commit": False,
         "params": {"image_mb": 120, "apply_s": 600, "max_concurrent": 2, "satellites": ["@gateway", "@gateway_b", "@gateway_c", "@gateway_d"]}},
    ],
    "route": {"source": "@source", "target": "@gateway", "objective": "latency"},
    "service": {"class": "imagery", "destination": "@gateway"},
    "playback": {"speed": 2, "speeds": [1, 2, 5, 10, 30, 60, 120], "sample_interval_s": 2},
    "steps": [
        {
            "id": "nominal", "order": 1, "title": "정상 운용", "tab": "mission", "tabs": ["mission", "communication", "data"], "speed": 2,
            "at": {"offset_s": 0},
            "summary": "N1에서 데이터 생성 · N1→N2→N4 전송",
            "narrative": "N1({source})이 관측 데이터를 생성하고, 군집 운용 모듈이 배정한 경로 {relay.path}로 N4({gateway})까지 위성 간 링크로 전달합니다. 데이터 패브릭은 매초 네트워크 상태를 받아 링크 판정과 경로를 돌려주고(DF-01→DF-02), 데이터 관리 모듈은 생성된 제품을 등록하고 복제합니다(DM-01). 이 구간의 KPI가 판정의 기준선이 됩니다.",
            "flows": [
                {"from": "engine", "to": "data-fabric", "icd": "ICD-02", "message": "DF-01 네트워크 상태 갱신 → DF-02 링크 판정·경로"},
                {"from": "framework", "to": "orchestrator", "icd": "ICD-03", "message": "OR-01 편성 요청 → OR-02 배정 → OR-03 실행 확정"},
                {"from": "engine", "to": "data-dist", "icd": "ICD-01", "message": "DM-04 노드 상태 · DM-01 수집 등록 → DM-05 상태 보고"},
            ],
            "actions": [{"kind": "route"}, {"kind": "sample", "phase": "baseline", "delay_s": 15}],
            "checks": [{"metric": "route.status", "equals": "available", "label": "N1→N4 경로 계산"}, {"metric": "mission.relay.status", "equals": "committed", "label": "중계 임무 실행 중"}, {"metric": "data.objects", "min": 1, "label": "데이터 객체 등록"}],
        },
        {
            "id": "fault", "order": 2, "title": "Fault 주입", "tab": "status", "tabs": ["status", "communication"], "speed": 1,
            "at": {"anchor": "task", "mission": "relay", "task_kind": "crosslink", "index": 0, "edge": "start", "offset_s": 20, "fallback_s": 40},
            "summary": "N1-N2 링크 단절 · Network 상태 갱신",
            "narrative": "주 경로의 첫 구간 {fault.link}에 링크 손실 장애(심각도 높음, {fault.duration_s}초)를 주입합니다(CS-004). DT 런타임이 장애 상태를 소유하고 fault.injected 이벤트를 기록하며, SIM 텔레메트리의 링크 품질과 손실률이 바뀝니다.",
            "flows": [
                {"from": "console", "to": "framework", "icd": "ICD-07", "message": "CS-004 장애 주입 요청"},
                {"from": "framework", "to": "engine", "icd": "ICD-05", "message": "EN-04 fault.injected 이벤트"},
            ],
            "actions": [
                {"kind": "inject_fault", "target": {"from_plan": "relay", "task_kind": "crosslink", "index": 0}, "fault": "link_loss", "severity": "high", "duration_s": 300},
                {"kind": "sample", "phase": "fault", "delay_s": 6},
            ],
            "checks": [{"metric": "fabric.fault_link_unusable", "equals": True, "label": "장애 링크 사용 불가"}],
        },
        {
            "id": "sync", "order": 3, "title": "상태 전달", "tab": "communication", "tabs": ["communication", "data", "security"], "speed": 1,
            "at": {"after": "fault", "offset_s": 4},
            "summary": "ODT가 장애 이벤트와 공통 상태를 동기화",
            "narrative": "DT 엔진이 다음 네트워크 상태 갱신(DF-01)에 장애 링크를 faulted=true로 실어 보내고, 데이터 패브릭이 그 링크를 사용 불가(사유 fault)로 판정합니다(DF-02). 같은 장애가 ICD-03 격자에서 제외되어 군집 운용 모듈이 재구성 대상을 알게 되고, 데이터 관리 모듈(DM-04)과 보안 운용 SW(SEC-01)는 같은 시각의 관측을 계속 받습니다. 공통 상태가 모든 모듈에 동기화됩니다.",
            "flows": [
                {"from": "engine", "to": "data-fabric", "icd": "ICD-02", "message": "DF-01 faulted=true → DF-02 usable=false (fault)"},
                {"from": "framework", "to": "orchestrator", "icd": "ICD-03", "message": "OR-01 격자에서 장애 링크 제외"},
                {"from": "engine", "to": "data-dist", "icd": "ICD-01", "message": "DM-04 저장 노드 상태 갱신"},
                {"from": "engine", "to": "security-ops", "icd": "ICD-08", "message": "SEC-01 관측 → SEC-02 판정"},
            ],
            "actions": [{"kind": "verify_link_unusable"}],
            "checks": [{"metric": "fabric.fault_link_unusable", "equals": True, "label": "패브릭 판정: 장애 링크 사용 불가"}, {"metric": "security.authentication", "equals": "nominal", "label": "보안 판정 유지"}],
        },
        {
            "id": "reroute", "order": 4, "title": "우회·재전송", "tab": "mission", "tabs": ["mission", "communication"], "speed": 5,
            "at": {"after": "fault", "offset_s": 10},
            "summary": "대체 경로 산출 · N1→N3→N4 전송",
            "narrative": "군집 운용 모듈에 재구성을 요청(OR-01, 장애 링크 제외)해 새 경로 {relay.replan_path}로 다시 배정하고 실행을 확정합니다(OR-03). 원본 위성 N1에서 처음부터 다시 보내므로 재전송입니다. 데이터 패브릭의 N1→N4 경로도 {route.path}로 바뀝니다.",
            "flows": [
                {"from": "framework", "to": "orchestrator", "icd": "ICD-03", "message": "OR-01 재구성 요청 → OR-02 새 배정 → OR-03 실행 확정"},
                {"from": "engine", "to": "data-fabric", "icd": "ICD-02", "message": "DF-03 경로 계산 요청 → DF-04 우회 경로"},
            ],
            "actions": [{"kind": "replan_mission", "mission": "relay"}, {"kind": "route"}, {"kind": "sample", "phase": "reroute", "delay_s": 8}],
            "checks": [{"metric": "mission.relay.feasible", "equals": True, "label": "재구성 계획 실행 가능"}, {"metric": "route.status", "equals": "available", "label": "우회 경로 계산"}],
        },
        {
            "id": "verdict", "order": 5, "title": "복구 판정", "tab": "mission", "tabs": ["mission", "data", "status"], "speed": 5,
            "at": {"max": [{"anchor": "mission_end", "mission": "relay"}, {"anchor": "fault_end", "step": "fault"}], "offset_s": 5, "fallback_s": 600},
            "summary": "도달·자원·상태 확인 · 정상/장애 KPI 비교",
            "narrative": "도달(중계 임무 완료와 기한 여유), 자원(N1 보관량과 데이터 안정성), 상태(대체 경로 재수렴 시간, 장애 해제 후 주 경로 복귀, 보안 판정 유지)를 정상 구간의 KPI와 비교해 판정합니다. 관문 N4가 N1의 최신 관측 영상을 데이터 센터에 요청해(DM-02) 서비스가 유지되는지도 확인합니다.",
            "flows": [
                {"from": "engine", "to": "data-dist", "icd": "ICD-01", "message": "DM-02 서비스 요청 → 제공 복제본·지연"},
                {"from": "framework", "to": "test-mgr", "icd": "ICD-06", "message": "VF-02 KPI 샘플 → VF-03 시험 결과 기록"},
            ],
            "actions": [{"kind": "dm_request"}, {"kind": "sample", "phase": "recovery"}, {"kind": "verdict"}],
            "checks": [{"metric": "mission.relay.status", "equals": "completed", "label": "중계 임무 완료"}, {"metric": "route.primary_restored", "equals": True, "label": "주 경로 복귀"}],
        },
    ],
    "criteria": [
        {"id": "reach", "label": "도달", "rules": [
            {"metric": "mission.relay.status", "equals": "completed", "label": "중계 임무 완료"},
            {"metric": "mission.relay.margin_s", "min": 0, "label": "기한 여유 유지"},
        ]},
        {"id": "resources", "label": "자원", "rules": [
            {"metric": "fabric.source_stored_ratio_max", "max": 0.6, "label": "N1 보관량 ≤ 저장 용량 60 %"},
            {"metric": "data.stability_min", "min": 70, "label": "데이터 안정성 ≥ 70"},
        ]},
        {"id": "state", "label": "상태", "rules": [
            {"metric": "route.reconverge_s", "max": 90, "label": "대체 경로 재수렴 ≤ 90 s"},
            {"metric": "route.primary_restored", "equals": True, "label": "장애 해제 후 주 경로 복귀"},
            {"metric": "security.nominal_throughout", "equals": True, "label": "보안 판정 기준 충족 유지"},
        ]},
    ],
}

SCENARIO_DEFINITIONS = {SDC_POC_01["id"]: SDC_POC_01}


def scenarios():
    return deepcopy(SCENARIOS)


def scenario_summaries():
    """The list the console shows: legacy SIM scenarios and PoC scenarios with their step count."""
    items = []
    for item in SCENARIOS:
        summary = deepcopy(item)
        definition = SCENARIO_DEFINITIONS.get(item["id"])
        if definition:
            summary["steps"] = [{"id": step["id"], "order": step["order"], "title": step["title"], "summary": step.get("summary", "")} for step in definition["steps"]]
            summary["satellites"] = definition["constellation"]["planes"] * definition["constellation"]["per_plane"]
            summary["stations"] = len(definition["stations"])
            summary["missions"] = len(definition["missions"])
        items.append(summary)
    return items


def scenario_definition(scenario_id: str):
    """Full definition of a PoC scenario merged with its summary, or None for unknown or SIM-only ids."""
    definition = SCENARIO_DEFINITIONS.get(scenario_id)
    summary = next((item for item in SCENARIOS if item["id"] == scenario_id), None)
    if definition is None or summary is None:
        return None
    return {**deepcopy(summary), **deepcopy(definition)}


def scenario_library():
    return {"summaries": scenario_summaries, "definition": scenario_definition, "ids": [item["id"] for item in SCENARIOS]}


def _rule_ok(rule: dict) -> bool:
    return isinstance(rule, dict) and rule.get("metric") in METRICS and any(key in rule for key in ("equals", "min", "max"))


@lru_cache(maxsize=1)
def model_keys() -> frozenset[str]:
    """Keys of the shipped 3D models; empty when the manifest is not available."""
    try:
        manifest = json.loads((WEB_DIR / "assets" / "models" / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return frozenset()
    return frozenset(str(model.get("key")) for model in manifest.get("models") or [] if model.get("key"))


def _model_problem(value, where: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        return f"{where} model_key must be a non-empty string"
    known = model_keys()
    if known and value not in known:
        return f"{where} model_key {value} is not in the model manifest"
    return None


def validate_definition(definition: dict) -> list[str]:
    """Structural checks of a PoC definition; returns the problems found (empty when valid)."""
    problems: list[str] = []
    constellation = definition.get("constellation") or {}
    planes, per_plane = int(constellation.get("planes") or 0), int(constellation.get("per_plane") or 0)
    if planes < 1 or per_plane < 1:
        problems.append("constellation.planes and per_plane must be positive")
    if (problem := _model_problem(constellation.get("model_key"), "constellation")) is not None:
        problems.append(problem)
    roles = constellation.get("roles") or {}
    seen: set[tuple[int, int]] = set()
    for name, role in roles.items():
        plane, index = int(role.get("plane", -1)), int(role.get("index", -1))
        if not (0 <= plane < planes and 0 <= index < per_plane):
            problems.append(f"role {name} points outside the formation")
        if (plane, index) in seen:
            problems.append(f"role {name} shares a satellite with another role")
        seen.add((plane, index))
        if (problem := _model_problem(role.get("model_key"), f"role {name}")) is not None:
            problems.append(problem)
    for role in (constellation.get("equipment") or {}).get("roles", {}):
        if role not in roles:
            problems.append(f"equipment override for unknown role {role}")
    keys: set[str] = set()
    for mission in definition.get("missions") or []:
        if mission.get("key") in keys:
            problems.append(f"duplicate mission key {mission.get('key')}")
        keys.add(mission.get("key"))
        for value in _strings(mission.get("params") or {}):
            if value.startswith("@") and value[1:] not in roles:
                problems.append(f"mission {mission.get('key')} refers to unknown role {value}")
            if value.startswith("satellite:@") and value[len("satellite:@"):] not in roles:
                problems.append(f"mission {mission.get('key')} refers to unknown role {value}")
    for field in ("route", "service"):
        for value in _strings(definition.get(field) or {}):
            if value.startswith("@") and value[1:] not in roles:
                problems.append(f"{field} refers to unknown role {value}")
    steps = definition.get("steps") or []
    ids = [step.get("id") for step in steps]
    if len(ids) != len(set(ids)):
        problems.append("step ids must be unique")
    if [step.get("order") for step in steps] != list(range(1, len(steps) + 1)):
        problems.append("step order must be 1..n")
    for step in steps:
        if step.get("tab") not in STEP_TABS or any(tab not in STEP_TABS for tab in step.get("tabs", [])):
            problems.append(f"step {step.get('id')} names an unknown tab")
        problems.extend(_anchor_problems(step.get("at") or {}, ids, keys, step.get("id")))
        for action in step.get("actions") or []:
            if action.get("kind") not in ACTION_KINDS:
                problems.append(f"step {step.get('id')} has unknown action {action.get('kind')}")
            if action.get("kind") == "replan_mission" and action.get("mission") not in keys:
                problems.append(f"step {step.get('id')} replans unknown mission")
            if action.get("kind") == "inject_fault" and (action.get("target") or {}).get("from_plan") not in keys:
                problems.append(f"step {step.get('id')} injects a fault on an unknown mission plan")
        for check in step.get("checks") or []:
            if not _rule_ok(check):
                problems.append(f"step {step.get('id')} has an invalid check")
    for group in definition.get("criteria") or []:
        for rule in group.get("rules") or []:
            if not _rule_ok(rule):
                problems.append(f"criteria {group.get('id')} has an invalid rule")
    return problems


def _strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _strings(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _strings(item)


def _anchor_problems(anchor: dict, step_ids: list, mission_keys: set, step_id) -> list[str]:
    problems: list[str] = []
    if "max" in anchor:
        for item in anchor["max"]:
            problems.extend(_anchor_problems(item, step_ids, mission_keys, step_id))
        return problems
    if "after" in anchor and anchor["after"] not in step_ids:
        problems.append(f"step {step_id} waits for unknown step {anchor['after']}")
    kind = anchor.get("anchor")
    if kind is not None and kind not in ANCHOR_KINDS:
        problems.append(f"step {step_id} has unknown anchor {kind}")
    if kind in ("task", "mission_end") and anchor.get("mission") not in mission_keys:
        problems.append(f"step {step_id} anchors to unknown mission {anchor.get('mission')}")
    if kind == "fault_end" and anchor.get("step") not in step_ids:
        problems.append(f"step {step_id} anchors to unknown fault step {anchor.get('step')}")
    return problems
