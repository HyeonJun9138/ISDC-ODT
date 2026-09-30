"""Deterministic task assignment for one mission over the twin's windows.

All times are seconds since the Unix epoch inside this module; the twin sends and receives UTC
ISO 8601 strings. Windows are half-open [start, end). Every decision is greedy and ordered by the
earliest completion, then by fewer hops, then by satellite id, so the same request always yields
the same plan. Representative figures (dwell, hop delay, task power) are engineering estimates for
a stand-in, not the specification of any flight system.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any

MISSION_KINDS = ("observe", "compute", "relay", "pickup", "fleet_update")
TASK_KINDS = ("collect", "process", "store", "crosslink", "transfer", "uplink", "apply", "pickup")

OISL_RATE_MBPS = 10_000.0
HOP_DELAY_MS = 8.0            # one OISL hop: about 2,000 km at c plus terminal processing
GROUND_HOP_DELAY_MS = 8.0     # one ground contact hop
IMAGING_DWELL_S = 45.0        # time the camera stays on one target per pass
TASK_GAP_S = 5.0              # settling gap between consecutive tasks on one satellite
MAX_ACCESS_CANDIDATES = 6
MAX_MESH_HOPS = 6             # a 40-satellite grid needs a longer detour when an in-plane link is lost
USABLE_BATTERY_FRACTION = 0.6
DEFAULT_COMPUTE_MBPS = 200.0
DEFAULT_PROCESSING_RATIO = 0.4
DEFAULT_OUTPUT_RATIO = 0.2
DEFAULT_APPLY_S = 600.0
DEFAULT_MAX_CONCURRENT = 4
TASK_POWER_W = {"collect": 150.0, "process": 60.0, "store": 30.0, "crosslink": 120.0, "transfer": 90.0, "uplink": 40.0, "apply": 40.0, "pickup": 60.0}
TASK_LABELS = {"collect": "촬영", "process": "궤도상 처리", "store": "보관", "crosslink": "위성 간 전달", "transfer": "지상 전송", "uplink": "지상 상향", "apply": "갱신 적용", "pickup": "외부 위성 수신"}


def parse_time(value: Any) -> float:
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    text = str(value or "").strip()
    if not text:
        raise ValueError("시각 값이 비어 있습니다.")
    try:
        stamp = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"시각 값을 해석할 수 없습니다: {text}") from error
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.timestamp()


def iso(seconds: float) -> str:
    return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _number(value: Any, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _interval(record: dict) -> tuple[float, float]:
    start = parse_time(record.get("start"))
    end = parse_time(record.get("end"))
    if end <= start:
        raise ValueError("창의 끝은 시작보다 뒤여야 합니다.")
    return start, end


def overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


class Planner:
    """One mission request parsed into lookups, plus the greedy assignment per mission kind."""

    def __init__(self, request: dict) -> None:
        mission = request.get("mission")
        if not isinstance(mission, dict) or mission.get("kind") not in MISSION_KINDS:
            raise ValueError(f"임무 종류는 {', '.join(MISSION_KINDS)} 중 하나여야 합니다.")
        self.request = request
        self.mission = mission
        self.mission_id = str(mission.get("id") or "MSN")
        self.kind = mission["kind"]
        self.params = mission.get("params") if isinstance(mission.get("params"), dict) else {}
        self.now = parse_time(request.get("time"))
        self.start = max(self.now, parse_time(mission.get("window_start") or request.get("time")))
        self.deadline = parse_time(mission.get("deadline"))
        if self.deadline <= self.start:
            raise ValueError("인도 기한은 계획 시작 시각보다 뒤여야 합니다.")
        exclude = {str(item) for item in (request.get("exclude") or [])}
        self.satellites: dict[str, dict] = {}
        self.unavailable: dict[str, str] = {}
        for sat in request.get("satellites") or []:
            sat_id = str(sat.get("id") or "")
            if not sat_id:
                continue
            if sat_id in exclude:
                self.unavailable[sat_id] = "제외 지정"
            elif str(sat.get("mode") or "nominal") != "nominal":
                self.unavailable[sat_id] = f"운용 모드 {sat.get('mode')}"
            else:
                self.satellites[sat_id] = sat
        self.stations = {str(station.get("id")): station for station in request.get("stations") or [] if station.get("id")}
        windows = request.get("windows") if isinstance(request.get("windows"), dict) else {}
        self.contacts = self._by_satellite(windows.get("contacts"), self._contact)
        self.access = self._by_satellite(windows.get("target_access"), self._plain)
        self.crosslinks = self._by_satellite(windows.get("crosslinks"), self._plain)
        self.eclipses = self._by_satellite(windows.get("eclipses"), self._plain)
        self.busy: dict[str, list[tuple[float, float]]] = {}
        for sat_id, sat in self.satellites.items():
            spans = []
            for item in sat.get("busy") or []:
                try:
                    spans.append(_interval(item))
                except ValueError:
                    continue
            self.busy[sat_id] = sorted(spans)
        mesh = request.get("mesh") if isinstance(request.get("mesh"), dict) else {}
        self.mesh: dict[str, set[str]] = {sat_id: set() for sat_id in self.satellites}
        for sat_id, neighbours in mesh.items():
            if str(sat_id) not in self.satellites:
                continue
            for other in neighbours or []:
                if str(other) in self.satellites and str(other) != str(sat_id):
                    self.mesh[str(sat_id)].add(str(other))
                    self.mesh[str(other)].add(str(sat_id))
        self.task_counter = 0
        self.alternatives = 0

    # ---- window lookups -------------------------------------------------------------------------

    def _by_satellite(self, records, convert) -> dict[str, list[dict]]:
        result: dict[str, list[dict]] = {}
        for record in records or []:
            sat_id = str(record.get("satellite") or "")
            if sat_id not in self.satellites:
                continue
            try:
                converted = convert(record)
            except ValueError:
                continue
            result.setdefault(sat_id, []).append(converted)
        for items in result.values():
            items.sort(key=lambda item: item["start"])
        return result

    def _plain(self, record: dict) -> dict:
        start, end = _interval(record)
        return {**record, "start": start, "end": end}

    def _contact(self, record: dict) -> dict:
        start, end = _interval(record)
        return {**record, "start": start, "end": end, "rate_mbps": _number(record.get("rate_mbps"), 0.0), "uplink_mbps": _number(record.get("uplink_mbps"), 0.0)}

    def capability(self, sat_id: str, key: str, default=None):
        capabilities = self.satellites[sat_id].get("capabilities") or {}
        return capabilities.get(key, default)

    def compute_mbps(self, sat_id: str) -> float:
        return max(1.0, _number(self.capability(sat_id, "compute_mbps"), DEFAULT_COMPUTE_MBPS))

    def storage_free_mb(self, sat_id: str) -> float:
        return max(0.0, _number(self.capability(sat_id, "storage_free_mb"), 0.0))

    # ---- scheduling primitives -------------------------------------------------------------------

    def free_from(self, sat_id: str, start: float, duration: float) -> float:
        """Earliest t >= start where [t, t + duration) avoids the satellite's committed tasks."""
        cursor = start
        for busy_start, busy_end in self.busy.get(sat_id, []):
            if busy_end <= cursor:
                continue
            if busy_start >= cursor + duration:
                break
            cursor = busy_end + TASK_GAP_S
        return cursor

    def earliest_transfer(self, sat_id: str, after: float, volume_mb: float, direction: str = "down", station_id: str | None = None) -> dict | None:
        """Earliest contact of the satellite in which the volume fits, honouring committed tasks."""
        for window in self.contacts.get(sat_id, []):
            if station_id and str(window.get("station")) != station_id:
                continue
            if window["end"] <= after:
                continue
            rate = window["rate_mbps"] if direction == "down" else window["uplink_mbps"]
            if rate <= 0:
                continue
            duration = volume_mb * 8 / rate
            start = self.free_from(sat_id, max(after, window["start"]), duration)
            if start + duration <= window["end"] and start < self.deadline + 86_400:
                return {"window": window, "start": start, "end": start + duration, "rate_mbps": rate}
        return None

    def mesh_reach(self, origin: str) -> dict[str, list[str]]:
        """Breadth-first paths (as satellite id lists) from the origin over the locked OISL mesh."""
        paths = {origin: [origin]}
        frontier = [origin]
        depth = 0
        while frontier and depth < MAX_MESH_HOPS:
            depth += 1
            next_frontier = []
            for sat_id in frontier:
                for neighbour in sorted(self.mesh.get(sat_id, ())):
                    if neighbour not in paths:
                        paths[neighbour] = paths[sat_id] + [neighbour]
                        next_frontier.append(neighbour)
            frontier = next_frontier
        return paths

    def delivery_options(self, origin: str, after: float, volume_mb: float, station_id: str | None = None) -> list[dict]:
        """Ways to get the volume from the origin to the ground: own contact or a mesh relay."""
        options = []
        crosslink_s = volume_mb * 8 / OISL_RATE_MBPS
        for relay_id, path in self.mesh_reach(origin).items():
            hops = len(path) - 1
            ready = after + hops * (crosslink_s + TASK_GAP_S)
            transfer = self.earliest_transfer(relay_id, ready, volume_mb, "down", station_id)
            if not transfer:
                continue
            options.append({"path": path, "hops": hops, "transfer": transfer, "end": transfer["end"], "crosslink_s": crosslink_s})
        options.sort(key=lambda option: (option["end"], option["hops"], option["path"][-1]))
        return options

    def new_task(self, kind: str, satellite: str, start: float, end: float, **extra) -> dict:
        self.task_counter += 1
        task = {
            "id": f"{self.mission_id}-T{self.task_counter:02d}", "kind": kind, "label": TASK_LABELS[kind], "satellite": satellite,
            "start": start, "end": max(start, end), "counterpart": None, "volume_mb": 0.0, "rate_mbps": None, "window": None,
            "depends_on": [], "power_w": TASK_POWER_W.get(kind, 0.0),
        }
        task.update(extra)
        return task

    def is_free(self, sat_id: str, start: float, end: float) -> bool:
        return all(busy_end <= start or busy_start >= end for busy_start, busy_end in self.busy.get(sat_id, []))

    def chain_to_ground(self, origin: str, after: float, volume_mb: float, depends: list[str], station_id: str | None = None) -> tuple[list[dict], dict | None]:
        """Crosslink hops (if any) plus the ground transfer for the best delivery option.

        Data stays on the origin until the relay's contact is imminent: the hops are scheduled
        backwards from the transfer so the relay never holds the data for long and a mesh change
        before the window does not strand it. When the backward schedule collides with committed
        work or the origin's readiness, the hops run forward from `after` instead and the relay
        holds the data until its window.
        """
        options = self.delivery_options(origin, after, volume_mb, station_id)
        self.alternatives += len(options)
        if not options:
            return [], None
        best = options[0]
        transfer = best["transfer"]
        relay_id = best["path"][-1]
        hop_s = best["crosslink_s"]
        hops = [(best["path"][index], best["path"][index + 1]) for index in range(best["hops"])]
        # Backward: the last hop ends one gap before the transfer starts.
        backward = []
        cursor_end = transfer["start"] - TASK_GAP_S
        for frm, to in reversed(hops):
            backward.append((frm, to, cursor_end - hop_s, cursor_end))
            cursor_end = cursor_end - hop_s - TASK_GAP_S
        backward.reverse()
        fits = all(start >= after and self.is_free(frm, start, end) for frm, _, start, end in backward)
        tasks: list[dict] = []
        previous = list(depends)
        if fits:
            for frm, to, start, end in backward:
                task = self.new_task("crosslink", frm, start, end, counterpart=to, volume_mb=volume_mb, rate_mbps=OISL_RATE_MBPS, depends_on=previous, window={"kind": "mesh", "ref": f"{frm}|{to}"})
                tasks.append(task)
                previous = [task["id"]]
        else:
            cursor = after
            for frm, to in hops:
                start = self.free_from(frm, cursor, hop_s)
                task = self.new_task("crosslink", frm, start, start + hop_s, counterpart=to, volume_mb=volume_mb, rate_mbps=OISL_RATE_MBPS, depends_on=previous, window={"kind": "mesh", "ref": f"{frm}|{to}"})
                tasks.append(task)
                previous = [task["id"]]
                cursor = task["end"] + TASK_GAP_S
            if hops and transfer["start"] - cursor > 60:
                hold = self.new_task("store", relay_id, cursor, transfer["start"], volume_mb=volume_mb, depends_on=previous)
                tasks.append(hold)
                previous = [hold["id"]]
        task = self.new_task("transfer", relay_id, transfer["start"], transfer["end"], counterpart=str(transfer["window"].get("station")), volume_mb=volume_mb,
                             rate_mbps=transfer["rate_mbps"], depends_on=previous, window={"kind": "contact", "ref": transfer["window"].get("id"), "station": transfer["window"].get("station"), "band": transfer["window"].get("band")})
        tasks.append(task)
        return tasks, best

    # ---- checks ----------------------------------------------------------------------------------

    def energy_check(self, tasks: list[dict]) -> dict:
        """Battery energy drawn while a satellite works in eclipse or beyond its generation, per satellite."""
        details = []
        ok = True
        for sat_id in sorted({task["satellite"] for task in tasks}):
            sat = self.satellites.get(sat_id) or {}
            power = sat.get("power") or {}
            generation = _number(power.get("generation_w"), 0.0)
            bus = _number(power.get("bus_w"), 0.0)
            battery = _number(power.get("battery_wh"), 0.0)
            drawn_wh = 0.0
            for task in tasks:
                if task["satellite"] != sat_id:
                    continue
                load = bus + _number(task.get("power_w"), 0.0)
                eclipse_s = sum(overlap(task["start"], task["end"], window["start"], window["end"]) for window in self.eclipses.get(sat_id, []))
                sunlit_s = max(0.0, task["end"] - task["start"] - eclipse_s)
                drawn_wh += load * eclipse_s / 3600 + max(0.0, load - generation) * sunlit_s / 3600
            limit = battery * USABLE_BATTERY_FRACTION
            fine = battery <= 0 or drawn_wh <= limit
            ok = ok and fine
            details.append({"satellite": sat_id, "drawn_wh": round(drawn_wh, 1), "limit_wh": round(limit, 1), "ok": fine})
        return {"id": "energy", "label": "배터리 여유", "ok": ok, "detail": "; ".join(f"{item['satellite']} {item['drawn_wh']}/{item['limit_wh']} Wh" for item in details) or "작업 없음", "items": details}

    def storage_check(self, tasks: list[dict]) -> dict:
        details = []
        ok = True
        for sat_id in sorted({task["satellite"] for task in tasks}):
            held = max([_number(task.get("volume_mb"), 0.0) for task in tasks if task["satellite"] == sat_id and task["kind"] in ("collect", "store", "process", "pickup", "crosslink", "uplink")] or [0.0])
            free = self.storage_free_mb(sat_id)
            fine = held <= free or free <= 0 and held == 0
            ok = ok and fine
            details.append({"satellite": sat_id, "held_mb": round(held, 1), "free_mb": round(free, 1), "ok": fine})
        return {"id": "storage", "label": "탑재 저장 여유", "ok": ok, "detail": "; ".join(f"{item['satellite']} {item['held_mb']}/{item['free_mb']} MB" for item in details) or "작업 없음", "items": details}

    def deadline_check(self, finish: float | None) -> dict:
        if finish is None:
            return {"id": "deadline", "label": "인도 기한", "ok": False, "detail": "완료 시각을 정할 수 없음"}
        margin = self.deadline - finish
        return {"id": "deadline", "label": "인도 기한", "ok": margin >= 0, "detail": f"여유 {margin / 60:.1f}분" if margin >= 0 else f"기한 초과 {-margin / 60:.1f}분", "margin_s": round(margin, 1)}

    def result(self, tasks: list[dict], finish: float | None, path: list[str], reasons: list[str], extra_checks: list[dict] | None = None, summary: dict | None = None) -> dict:
        tasks = sorted(tasks, key=lambda task: (task["start"], task["satellite"], task["id"]))
        checks = [self.deadline_check(finish), self.storage_check(tasks), self.energy_check(tasks)] + list(extra_checks or [])
        feasible = bool(tasks) and all(check["ok"] for check in checks) and not reasons
        satellites = sorted({task["satellite"] for task in tasks})
        volume = max([_number(task.get("volume_mb"), 0.0) for task in tasks] or [0.0])
        return {
            "mission_id": self.mission_id, "kind": self.kind, "feasible": feasible,
            "tasks": [{**task, "start": iso(task["start"]), "end": iso(task["end"]), "duration_s": round(task["end"] - task["start"], 1), "volume_mb": round(_number(task.get("volume_mb"), 0.0), 3)} for task in tasks],
            "summary": {"finish_at": iso(finish) if finish is not None else None, "deadline": iso(self.deadline), "margin_s": round(self.deadline - finish, 1) if finish is not None else None,
                        "path": path, "satellites": satellites, "task_count": len(tasks), "volume_mb": round(volume, 3), "hops": max(0, len(path) - 1) if path else 0, **(summary or {})},
            "checks": checks, "reasons": reasons, "alternatives": self.alternatives,
            "unavailable": [{"satellite": sat_id, "reason": reason} for sat_id, reason in sorted(self.unavailable.items())],
        }

    # ---- mission kinds ---------------------------------------------------------------------------

    def plan(self) -> dict:
        return getattr(self, f"plan_{self.kind}")()

    def _process_then_deliver(self, sat_id: str, ready: float, input_mb: float, output_mb: float, depends: list[str], processing: bool, station_id: str | None = None) -> tuple[list[dict], float | None, list[str]]:
        tasks: list[dict] = []
        previous = list(depends)
        cursor = ready
        if processing and output_mb > 0:
            duration = input_mb * 8 / self.compute_mbps(sat_id)
            start = self.free_from(sat_id, cursor + TASK_GAP_S, duration)
            task = self.new_task("process", sat_id, start, start + duration, volume_mb=input_mb, rate_mbps=self.compute_mbps(sat_id), depends_on=previous)
            tasks.append(task)
            previous = [task["id"]]
            cursor = task["end"]
        chain, best = self.chain_to_ground(sat_id, cursor + TASK_GAP_S, output_mb, previous, station_id)
        if not best:
            return tasks, None, []
        first_hop = chain[0]["start"]
        if first_hop - cursor > 60:
            tasks.append(self.new_task("store", sat_id, cursor, first_hop, volume_mb=output_mb, depends_on=previous))
        tasks.extend(chain)
        return tasks, chain[-1]["end"], best["path"] + [str(best["transfer"]["window"].get("station"))]

    def plan_observe(self) -> dict:
        product_mb = max(1.0, _number(self.params.get("product_mb"), 800.0))
        processing = self.params.get("processing", True) is not False
        ratio = min(1.0, max(0.05, _number(self.params.get("processing_ratio"), DEFAULT_PROCESSING_RATIO)))
        output_mb = product_mb * ratio if processing else product_mb
        preferred = str(self.params.get("preferred_satellite") or "")
        station_id = str(self.params.get("station") or "") or None
        candidates = [sat_id for sat_id in sorted(self.satellites) if self.capability(sat_id, "camera")]
        if preferred:
            candidates = [sat_id for sat_id in candidates if sat_id == preferred]
        reasons: list[str] = []
        if not candidates:
            reasons.append("촬영 장비가 켜진 사용 가능 위성이 없음" if not preferred else f"{preferred}은(는) 사용할 수 없거나 촬영 장비가 없음")
        best: dict | None = None
        for sat_id in candidates:
            windows = [window for window in self.access.get(sat_id, []) if window["end"] > self.start][:MAX_ACCESS_CANDIDATES]
            for window in windows:
                self.task_counter = 0
                peak = _number(window.get("peak"), (window["start"] + window["end"]) / 2)
                dwell = min(IMAGING_DWELL_S, window["end"] - max(window["start"], self.start))
                if dwell <= 0:
                    continue
                collect_start = max(window["start"], self.start, min(peak - dwell / 2, window["end"] - dwell))
                collect_start = self.free_from(sat_id, collect_start, dwell)
                if collect_start + dwell > window["end"]:
                    continue
                collect = self.new_task("collect", sat_id, collect_start, collect_start + dwell, counterpart=str(self.params.get("target_name") or "목표"), volume_mb=product_mb, window={"kind": "access", "ref": window.get("id"), "max_elevation": window.get("max_elevation")})
                tasks, finish, path = self._process_then_deliver(sat_id, collect["end"], product_mb, output_mb, [collect["id"]], processing, station_id)
                if finish is None:
                    continue
                candidate = {"tasks": [collect] + tasks, "finish": finish, "path": path, "hops": max(0, len(path) - 2)}
                if best is None or (candidate["finish"], candidate["hops"], sat_id) < (best["finish"], best["hops"], best["tasks"][0]["satellite"]):
                    best = candidate
        access_count = sum(len([window for window in self.access.get(sat_id, []) if window["end"] > self.start]) for sat_id in candidates)
        contact_count = sum(len([window for window in self.contacts.get(sat_id, []) if window["end"] > self.start]) for sat_id in self.satellites)
        counts = {"access_windows": access_count, "contact_windows": contact_count, "candidates": len(candidates)}
        if best is None:
            if candidates and not reasons:
                reasons.append("계획 창 안에 촬영 위성의 관측 통과가 없음. 기한을 늘리거나 최대 관측각을 키우세요" if access_count == 0
                               else "지상 전송 창이 없어 결과를 내려보낼 수 없음" if contact_count == 0
                               else f"관측 통과 {access_count}개와 지상 전송 창 {contact_count}개로는 기한 안에 촬영과 전송을 잇지 못함")
            return self.result([], None, [], reasons, summary=counts)
        self.task_counter = len(best["tasks"])
        return self.result(best["tasks"], best["finish"], best["path"], reasons, summary={"product_mb": product_mb, "output_mb": round(output_mb, 3), "processing": processing, **counts})

    def plan_compute(self) -> dict:
        input_mb = max(1.0, _number(self.params.get("input_mb"), 2000.0))
        ratio = min(1.0, max(0.01, _number(self.params.get("output_ratio"), DEFAULT_OUTPUT_RATIO)))
        output_mb = input_mb * ratio
        source = str(self.params.get("source_satellite") or "")
        station_id = str(self.params.get("station") or "") or None
        candidates = [source] if source else sorted(self.satellites)
        reasons: list[str] = []
        if source and source not in self.satellites:
            reasons.append(f"{source}은(는) 사용할 수 없음 ({self.unavailable.get(source, '배치되지 않음')})")
            candidates = []
        best: dict | None = None
        for sat_id in candidates:
            self.task_counter = 0
            tasks, finish, path = self._process_then_deliver(sat_id, self.start, input_mb, output_mb, [], True, station_id)
            if finish is None:
                continue
            candidate = {"tasks": tasks, "finish": finish, "path": path, "hops": max(0, len(path) - 2)}
            if best is None or (candidate["finish"], candidate["hops"], sat_id) < (best["finish"], best["hops"], best["tasks"][0]["satellite"]):
                best = candidate
        if best is None:
            if candidates and not reasons:
                contact_count = sum(len([window for window in self.contacts.get(sat_id, []) if window["end"] > self.start]) for sat_id in self.satellites)
                reasons.append("계획 창 안에 지상 전송 창이 없음" if contact_count == 0 else f"지상 전송 창 {contact_count}개로는 처리 후 기한 안에 결과를 내려보낼 수 없음")
            return self.result([], None, [], reasons)
        self.task_counter = len(best["tasks"])
        return self.result(best["tasks"], best["finish"], best["path"], reasons, summary={"input_mb": input_mb, "output_mb": round(output_mb, 3)})

    def _endpoint(self, value: Any) -> tuple[str, str]:
        text = str(value or "")
        if ":" in text:
            kind, ident = text.split(":", 1)
            return kind, ident
        return ("satellite" if text in self.satellites else "station"), text

    def plan_relay(self) -> dict:
        volume_mb = max(0.1, _number(self.params.get("volume_mb"), 500.0))
        max_latency = _number(self.params.get("max_latency_ms"), 0.0)
        src_kind, src = self._endpoint(self.params.get("source"))
        dst_kind, dst = self._endpoint(self.params.get("destination"))
        reasons: list[str] = []
        tasks: list[dict] = []
        finish: float | None = None
        path: list[str] = []
        latency_ms = 0.0
        if src_kind == "station" and dst_kind == "station":
            return self.result([], None, [], ["지상국 사이의 전송은 지상망이 맡으며 군집 작업이 아님"])
        if src_kind == "satellite" and src not in self.satellites:
            reasons.append(f"출발 위성 {src}은(는) 사용할 수 없음 ({self.unavailable.get(src, '배치되지 않음')})")
        if dst_kind == "satellite" and dst not in self.satellites:
            reasons.append(f"도착 위성 {dst}은(는) 사용할 수 없음 ({self.unavailable.get(dst, '배치되지 않음')})")
        if reasons:
            return self.result([], None, [], reasons)
        if src_kind == "satellite" and dst_kind == "station":
            chain, best = self.chain_to_ground(src, self.start, volume_mb, [], dst)
            if not best:
                reasons.append(f"{src}에서 {dst}까지 기한 안에 닿는 전송 창이 없음")
            else:
                tasks = chain
                finish = chain[-1]["end"]
                path = best["path"] + [dst]
                latency_ms = best["hops"] * HOP_DELAY_MS + GROUND_HOP_DELAY_MS
        elif src_kind == "station" and dst_kind == "satellite":
            options = []
            for relay_id, mesh_path in self.mesh_reach(dst).items():
                uplink = self.earliest_transfer(relay_id, self.start, volume_mb, "up", src)
                if uplink:
                    options.append((uplink["end"] + (len(mesh_path) - 1) * (volume_mb * 8 / OISL_RATE_MBPS + TASK_GAP_S), len(mesh_path) - 1, relay_id, uplink, mesh_path))
            self.alternatives += len(options)
            if not options:
                reasons.append(f"{src}에서 {dst}으로 올릴 상향 전송 창이 없음")
            else:
                options.sort(key=lambda option: (option[0], option[1], option[2]))
                _, hops, relay_id, uplink, mesh_path = options[0]
                up = self.new_task("uplink", relay_id, uplink["start"], uplink["end"], counterpart=src, volume_mb=volume_mb, rate_mbps=uplink["rate_mbps"], window={"kind": "contact", "ref": uplink["window"].get("id"), "station": src, "band": uplink["window"].get("band")})
                tasks.append(up)
                previous = [up["id"]]
                cursor = up["end"] + TASK_GAP_S
                route = list(reversed(mesh_path))  # relay satellite first, destination last
                for index in range(hops):
                    frm, to = route[index], route[index + 1]
                    duration = volume_mb * 8 / OISL_RATE_MBPS
                    start = self.free_from(frm, cursor, duration)
                    hop = self.new_task("crosslink", frm, start, start + duration, counterpart=to, volume_mb=volume_mb, rate_mbps=OISL_RATE_MBPS, depends_on=previous, window={"kind": "mesh", "ref": f"{frm}|{to}"})
                    tasks.append(hop)
                    previous = [hop["id"]]
                    cursor = hop["end"] + TASK_GAP_S
                finish = tasks[-1]["end"]
                path = [src] + route
                latency_ms = GROUND_HOP_DELAY_MS + hops * HOP_DELAY_MS
        else:
            paths = self.mesh_reach(src)
            if dst not in paths:
                reasons.append(f"{src}에서 {dst}까지 현재 OISL 격자에 경로가 없음")
            else:
                route = paths[dst]
                previous: list[str] = []
                cursor = self.start
                for index in range(len(route) - 1):
                    frm, to = route[index], route[index + 1]
                    duration = volume_mb * 8 / OISL_RATE_MBPS
                    start = self.free_from(frm, cursor, duration)
                    hop = self.new_task("crosslink", frm, start, start + duration, counterpart=to, volume_mb=volume_mb, rate_mbps=OISL_RATE_MBPS, depends_on=previous, window={"kind": "mesh", "ref": f"{frm}|{to}"})
                    tasks.append(hop)
                    previous = [hop["id"]]
                    cursor = hop["end"] + TASK_GAP_S
                finish = tasks[-1]["end"] if tasks else self.start
                path = route
                latency_ms = (len(route) - 1) * HOP_DELAY_MS
        checks = []
        if max_latency > 0:
            checks.append({"id": "latency", "label": "종단 지연 한계", "ok": latency_ms <= max_latency, "detail": f"예상 {latency_ms:.1f} ms / 한계 {max_latency:.0f} ms"})
        return self.result(tasks, finish, path, reasons, checks, summary={"latency_ms": round(latency_ms, 1), "volume_mb": volume_mb})

    def plan_pickup(self) -> dict:
        volume_mb = max(0.1, _number(self.params.get("volume_mb"), 1500.0))
        rate = max(0.1, _number(self.params.get("crosslink_rate_mbps"), 50.0))
        external = str(self.params.get("external_id") or self.params.get("external_name") or "외부 위성")
        station_id = str(self.params.get("station") or "") or None
        reasons: list[str] = []
        best: dict | None = None
        seen = 0
        for sat_id in sorted(self.satellites):
            for window in [window for window in self.crosslinks.get(sat_id, []) if window["end"] > self.start]:
                seen += 1
                self.task_counter = 0
                duration = volume_mb * 8 / rate
                start = self.free_from(sat_id, max(window["start"], self.start), duration)
                if start + duration > window["end"]:
                    continue
                pickup = self.new_task("pickup", sat_id, start, start + duration, counterpart=external, volume_mb=volume_mb, rate_mbps=rate, window={"kind": "crosslink", "ref": window.get("id"), "min_range_km": window.get("min_range_km")})
                tasks, finish, path = self._process_then_deliver(sat_id, pickup["end"], volume_mb, volume_mb, [pickup["id"]], False, station_id)
                if finish is None:
                    continue
                candidate = {"tasks": [pickup] + tasks, "finish": finish, "path": path, "hops": max(0, len(path) - 2)}
                if best is None or (candidate["finish"], candidate["hops"], sat_id) < (best["finish"], best["hops"], best["tasks"][0]["satellite"]):
                    best = candidate
        if best is None:
            reasons.append("외부 위성과의 교차링크 창이 없음" if not seen else f"교차링크 창 {seen}개 중 {volume_mb:.0f} MB를 받고 기한 안에 내려보낼 수 있는 조합이 없음")
            return self.result([], None, [], reasons)
        self.task_counter = len(best["tasks"])
        return self.result(best["tasks"], best["finish"], [external] + best["path"], reasons, summary={"volume_mb": volume_mb, "crosslink_rate_mbps": rate})

    def plan_fleet_update(self) -> dict:
        image_mb = max(0.1, _number(self.params.get("image_mb"), 120.0))
        apply_s = max(1.0, _number(self.params.get("apply_s"), DEFAULT_APPLY_S))
        max_concurrent = max(1, int(_number(self.params.get("max_concurrent"), DEFAULT_MAX_CONCURRENT)))
        targets = [str(item) for item in (self.params.get("satellites") or [])] or sorted(self.satellites)
        reasons: list[str] = []
        tasks: list[dict] = []
        scheduled: list[tuple[float, float, str]] = []  # apply intervals
        unscheduled: list[str] = []
        for sat_id in sorted(targets):
            if sat_id not in self.satellites:
                unscheduled.append(f"{sat_id} ({self.unavailable.get(sat_id, '배치되지 않음')})")
                continue
            uplink = self.earliest_transfer(sat_id, self.start, image_mb, "up")
            if not uplink:
                unscheduled.append(f"{sat_id} (상향 전송 창 없음)")
                continue
            up = self.new_task("uplink", sat_id, uplink["start"], uplink["end"], counterpart=str(uplink["window"].get("station")), volume_mb=image_mb, rate_mbps=uplink["rate_mbps"], window={"kind": "contact", "ref": uplink["window"].get("id"), "station": uplink["window"].get("station"), "band": uplink["window"].get("band")})
            apply_start = self.free_from(sat_id, up["end"] + TASK_GAP_S, apply_s)
            # Rolling waves: never more than max_concurrent satellites applying at once.
            while sum(1 for s, e, _ in scheduled if s < apply_start + apply_s and apply_start < e) >= max_concurrent:
                apply_start = min(e for s, e, _ in scheduled if s < apply_start + apply_s and apply_start < e) + TASK_GAP_S
            apply = self.new_task("apply", sat_id, apply_start, apply_start + apply_s, volume_mb=image_mb, depends_on=[up["id"]])
            scheduled.append((apply["start"], apply["end"], sat_id))
            tasks.extend([up, apply])
        if unscheduled:
            reasons.append("갱신하지 못한 위성: " + ", ".join(unscheduled))
        finish = max([task["end"] for task in tasks], default=None)
        peak = max([sum(1 for s2, e2, _ in scheduled if s2 <= s < e2) for s, _, _ in scheduled] or [0])
        return self.result(tasks, finish, [sat for _, _, sat in sorted(scheduled)], reasons, summary={"image_mb": image_mb, "updated": len(scheduled), "requested": len(targets), "max_parallel": peak, "max_concurrent": max_concurrent})
