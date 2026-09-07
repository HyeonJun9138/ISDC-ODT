from __future__ import annotations

import asyncio
from copy import deepcopy
from typing import Any, Callable


class MissionRuntime:
    """Owns mission state beneath RuntimeState; shares its command lock."""

    def __init__(self, missions: list[dict], lock: asyncio.Lock, emit: Callable):
        self.items = deepcopy(missions)
        self._lock = lock
        self._emit = emit

    async def mission_action(self, mission_id: str, action: str) -> dict:
        async with self._lock:
            mission = next((m for m in self.items if m["id"] == mission_id), None)
            if not mission:
                raise ValueError("임무를 찾을 수 없습니다.")
            if action == "start" and mission["status"] in {"completed", "aborted"}:
                raise ValueError("완료 또는 중단 임무는 직접 재시작할 수 없습니다.")
            if action == "pause" and mission["status"] != "running":
                raise ValueError("실행 중인 임무만 일시정지할 수 있습니다.")
            status_map = {"start": "running", "pause": "paused", "replan": "running", "abort": "aborted", "complete": "completed"}
            mission["status"] = status_map[action]
            if action == "replan":
                mission["progress"] = min(100, mission["progress"] + 2)
            elif action == "complete":
                mission["progress"] = 100
            self._emit(f"mission.{action}", "warning" if action == "abort" else "info", f"{mission_id} · {action}")
            return deepcopy(mission)

    def validate_mission(self, mission_id: str) -> dict:
        mission = next((m for m in self.items if m["id"] == mission_id), None)
        if not mission:
            raise ValueError("임무를 찾을 수 없습니다.")
        conflicts: list[dict[str, Any]] = []
        tasks = mission.get("tasks", [])
        for index, first in enumerate(tasks):
            if first.get("predecessor"):
                predecessor = next((task for task in tasks if task["id"] == first["predecessor"]), None)
                if not predecessor:
                    conflicts.append({"type": "missing_predecessor", "severity": "high", "task_ids": [first["id"]], "message": f"{first['id']} 선행 작업 누락"})
                elif predecessor["start"] + predecessor["duration"] > first["start"]:
                    conflicts.append({"type": "dependency", "severity": "high", "task_ids": [predecessor["id"], first["id"]], "message": "선행 작업 완료 전 시작"})
            for second in tasks[index + 1 :]:
                if first["lane"] != second["lane"]:
                    continue
                if first["start"] < second["start"] + second["duration"] and second["start"] < first["start"] + first["duration"]:
                    conflicts.append({"type": "lane_overlap", "severity": "medium", "task_ids": [first["id"], second["id"]], "message": f"{first['lane']} 자원 점유 중복"})
        for resource, value in mission.get("resources", {}).items():
            if value > 85:
                conflicts.append({"type": "resource", "severity": "high", "task_ids": [], "resource": resource, "message": f"{resource} 사용률 {value}%"})
        return {"mission_id": mission_id, "plan_version": mission.get("plan_version", 1), "valid": not conflicts, "conflict_count": len(conflicts), "conflicts": conflicts}

    async def mutate_task(self, payload: dict[str, Any]) -> dict:
        async with self._lock:
            mission = next((m for m in self.items if m["id"] == payload["mission_id"]), None)
            if not mission:
                raise ValueError("임무를 찾을 수 없습니다.")
            tasks = mission.setdefault("tasks", [])
            operation = payload["operation"]
            if operation == "delete":
                before = len(tasks)
                tasks[:] = [task for task in tasks if task["id"] != payload.get("task_id")]
                if len(tasks) == before:
                    raise ValueError("삭제할 작업을 찾을 수 없습니다.")
                changed_id = payload.get("task_id")
            else:
                if not all(payload.get(key) is not None for key in ("lane", "name", "start", "duration")):
                    raise ValueError("작업 필드가 부족합니다.")
                if operation == "create":
                    next_number = max([int(task["id"].split("-")[-1]) for task in tasks if task["id"].startswith("T-") and task["id"].split("-")[-1].isdigit()] or [0]) + 1
                    changed_id = payload.get("task_id") or f"T-{next_number:02d}"
                    task = {"id": changed_id}
                    tasks.append(task)
                else:
                    changed_id = payload.get("task_id")
                    task = next((item for item in tasks if item["id"] == changed_id), None)
                    if not task:
                        raise ValueError("수정할 작업을 찾을 수 없습니다.")
                for key in ("lane", "name", "start", "duration", "status", "predecessor", "priority"):
                    if payload.get(key) is not None:
                        task[key] = payload[key]
                task.setdefault("status", "planned")
                task.setdefault("priority", 5)
            mission["plan_version"] = mission.get("plan_version", 1) + 1
            self._emit(f"mission.task.{operation}", "info", f"{mission['id']} · {changed_id}", {"mission_id": mission["id"], "task_id": changed_id})
            return {"mission": deepcopy(mission), "validation": self.validate_mission(mission["id"])}

    async def replan_mission(self, mission_id: str, apply: bool = True) -> dict:
        async with self._lock:
            mission = next((m for m in self.items if m["id"] == mission_id), None)
            if not mission:
                raise ValueError("임무를 찾을 수 없습니다.")
            before = deepcopy(mission.get("tasks", []))
            proposal = deepcopy(before)
            by_lane: dict[str, list[dict]] = {}
            for task in proposal:
                by_lane.setdefault(task["lane"], []).append(task)
            for tasks in by_lane.values():
                tasks.sort(key=lambda task: (task["start"], -task.get("priority", 5)))
                cursor = 0.0
                for task in tasks:
                    task["start"] = round(max(task["start"], cursor), 2)
                    cursor = task["start"] + task["duration"] + 1
            proposal.sort(key=lambda task: task["start"])
            diff = []
            before_map = {task["id"]: task for task in before}
            for task in proposal:
                old = before_map[task["id"]]
                if old["start"] != task["start"]:
                    diff.append({"task_id": task["id"], "field": "start", "before": old["start"], "after": task["start"]})
            if apply:
                mission["tasks"] = proposal
                mission["plan_version"] = mission.get("plan_version", 1) + 1
                mission["status"] = "running"
            self._emit("mission.replanned", "info", f"{mission_id} · {len(diff)}개 작업 이동", {"mission_id": mission_id, "diff": diff})
            return {"mission": deepcopy(mission), "applied": apply, "diff": diff, "validation": self.validate_mission(mission_id)}
