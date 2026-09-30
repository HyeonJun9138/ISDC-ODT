"""The constellation operations stand-in that answers ICD-03 messages.

plan()    OR-01 임무 편성 요청 (DT → 군집 운용): one mission with the twin's satellites, stations and
          windows. Returns the satellite tasks, feasibility verdict, checks and reasons
          (OR-02 역할 배정 결과, 군집 운용 → DT).
commit()  OR-03 실행 확정·중단 통보 (DT → 군집 운용): the operator confirmed or aborted a plan. The
          module records the confirmed tasks as held intervals and acknowledges.
status()  OR-04 모듈 상태.

Planning is stateless per request; the module keeps a sequence counter, the last verdict per
mission and the confirmed plans so the console can show what the module answered and holds.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from .scheduler import Planner, parse_time

STAND_IN_VERSION = "0.2"
DECISIONS = ("commit", "abort")


class OrchestrationStandIn:
    implementation = "stand_in"
    version = STAND_IN_VERSION

    def __init__(self) -> None:
        self._sequence = 0
        self._last: dict[str, dict[str, Any]] = {}
        self._committed: dict[str, dict[str, Any]] = {}
        self._last_time: str | None = None

    def _stamp(self) -> None:
        self._sequence += 1
        self._last_time = datetime.now(timezone.utc).isoformat(timespec="seconds")

    def plan(self, request: dict) -> dict:
        if not isinstance(request, dict):
            raise ValueError("임무 편성 요청은 객체여야 합니다.")
        planner = Planner(request)
        verdict = planner.plan()
        self._stamp()
        answer = {"sequence": self._sequence, "time": request.get("time"), "implementation": self.implementation, "version": self.version, **verdict}
        self._last[verdict["mission_id"]] = {"sequence": self._sequence, "feasible": verdict["feasible"], "finish_at": verdict["summary"]["finish_at"],
                                             "committed": verdict["mission_id"] in self._committed}
        return deepcopy(answer)

    def commit(self, message: dict) -> dict:
        if not isinstance(message, dict):
            raise ValueError("실행 확정 통보는 객체여야 합니다.")
        mission_id = str(message.get("mission_id") or "").strip()
        if not mission_id:
            raise ValueError("mission_id가 필요합니다.")
        decision = str(message.get("decision") or "")
        if decision not in DECISIONS:
            raise ValueError(f"decision은 {', '.join(DECISIONS)} 중 하나여야 합니다.")
        version = int(message.get("version") or 0)
        tasks = message.get("tasks") if isinstance(message.get("tasks"), list) else []
        held: list[dict[str, Any]] = []
        for task in tasks:
            if not isinstance(task, dict) or not task.get("satellite"):
                raise ValueError("작업에는 satellite와 start, end가 필요합니다.")
            start, end = parse_time(task.get("start")), parse_time(task.get("end"))
            if end < start:
                raise ValueError("작업의 끝은 시작보다 앞설 수 없습니다.")
            held.append({"task_id": str(task.get("id") or ""), "satellite": str(task["satellite"]), "kind": str(task.get("kind") or ""), "start": task.get("start"), "end": task.get("end")})
        self._stamp()
        if decision == "commit":
            self._committed[mission_id] = {"version": version, "sequence": self._sequence, "time": message.get("time"), "tasks": held}
        else:
            self._committed.pop(mission_id, None)
        if mission_id in self._last:
            self._last[mission_id]["committed"] = decision == "commit"
        return {"sequence": self._sequence, "mission_id": mission_id, "decision": decision, "version": version, "accepted": True,
                "held_tasks": len(held) if decision == "commit" else 0, "time": self._last_time, "implementation": self.implementation, "version_module": self.version}

    def status(self) -> dict:
        return {
            "module": "orchestration", "implementation": self.implementation, "version": self.version, "placement": "embedded", "endpoint": "in-process",
            "sequence": self._sequence, "last_update": self._last_time, "missions": deepcopy(self._last),
            "committed": {mission_id: {"version": item["version"], "tasks": len(item["tasks"])} for mission_id, item in self._committed.items()},
            "reachable": True,
        }
