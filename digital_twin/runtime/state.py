from __future__ import annotations

import asyncio
import uuid
from collections import deque
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from .missions import MissionRuntime
from digital_twin.simulation.telemetry import calculate_telemetry
from digital_twin.simulation.mock_hil import apply_device_action, preflight
from digital_twin.contracts.state import RuntimeSnapshot


class RuntimeState:
    """Thread-safe-enough asyncio state for a single-process simulation console."""

    def __init__(self, *, missions: list[dict], devices: list[dict], scenarios: list[dict]) -> None:
        self._lock = asyncio.Lock()
        self.random_seed = 2042
        self.running = True
        self.speed = 1.0
        self.elapsed_seconds = 124.5
        self.scenario_id = "LEO_STANDARD"
        self.started_at = datetime.now(timezone.utc)
        self.run_id = f"RUN-{uuid.uuid4().hex[:12].upper()}"
        self.mode = "SIM"
        self.scenario_version = "1.0"
        self.recording = True
        self.data_quality = "GOOD"
        self.sequence = 0
        self.faults: list[dict[str, Any]] = []
        self._missions = MissionRuntime(missions, self._lock, self._emit)
        self.scenarios = deepcopy(scenarios)
        self.devices = deepcopy(devices)
        self.events: deque[dict[str, Any]] = deque(maxlen=200)
        self._task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()
        self._last_snapshot_second = -1
        self.current_telemetry: dict[str, Any] = {}
        self._refresh_telemetry()
        self._emit("runtime.started", "info", "시뮬레이션 런타임 시작")

    @property
    def missions(self) -> list[dict]:
        return self._missions.items

    def snapshot(self) -> RuntimeSnapshot:
        return RuntimeSnapshot(
            current_telemetry=deepcopy(self.current_telemetry),
            missions=deepcopy(self.missions), faults=deepcopy(self.faults),
            data_quality=self.data_quality, elapsed_seconds=self.elapsed_seconds,
            sequence=self.sequence, run_id=self.run_id, scenario_id=self.scenario_id,
            mode=self.mode, recording=self.recording,
        )

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._clock_loop(), name="simulation-clock")

    async def shutdown(self) -> None:
        self._stop.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _clock_loop(self) -> None:
        last = asyncio.get_running_loop().time()
        while not self._stop.is_set():
            await asyncio.sleep(0.2)
            now = asyncio.get_running_loop().time()
            delta = now - last
            last = now
            async with self._lock:
                if self.running:
                    self.elapsed_seconds += delta * self.speed
                    self.sequence += 1
                self._expire_faults()
                if int(self.elapsed_seconds) != self._last_snapshot_second:
                    self._refresh_telemetry()

    def _emit(self, event_type: str, severity: str, message: str, payload: dict | None = None) -> None:
        self.events.appendleft(
            {
                "id": f"EVT-{uuid.uuid4().hex[:16].upper()}",
                "event_id": str(uuid.uuid4()),
                "run_id": self.run_id,
                "scenario_id": self.scenario_id,
                "schema_version": "1.0",
                "source": "runtime.core",
                "sequence": self.sequence,
                "type": event_type,
                "severity": severity,
                "message": message,
                "payload": deepcopy(payload or {}),
                "simulation_time": round(self.elapsed_seconds, 3),
                "wall_time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
        )

    def _expire_faults(self) -> None:
        active: list[dict[str, Any]] = []
        for fault in self.faults:
            if self.elapsed_seconds < fault["expires_at"]:
                active.append(fault)
            elif fault.get("active", True):
                fault["active"] = False
                self._emit("fault.cleared", "info", f"{fault['target']} 장애 해제", fault)
        self.faults = active

    async def control(self, action: str, speed: float | None = None) -> dict:
        async with self._lock:
            if speed is not None:
                self.speed = speed
            if action == "start":
                self.running = True
            elif action == "pause":
                self.running = False
            elif action == "reset":
                self.running = False
                self.elapsed_seconds = 0.0
                self.faults.clear()
                self.run_id = f"RUN-{uuid.uuid4().hex[:12].upper()}"
                self.started_at = datetime.now(timezone.utc)
            elif action == "step":
                self.running = False
                self.elapsed_seconds += max(self.speed, 1.0)
            self._emit(f"runtime.{action}", "info", f"런타임 {action}", {"speed": self.speed})
            self._refresh_telemetry()
            return self.status()

    async def set_speed(self, speed: float) -> dict:
        async with self._lock:
            self.speed = speed
            self._emit("runtime.speed.changed", "info", f"배속 {speed:g}x", {"speed": speed})
            return self.status()

    async def select_scenario(self, scenario_id: str) -> dict:
        valid = {item["id"] for item in self.scenarios}
        if scenario_id not in valid:
            raise ValueError("알 수 없는 시나리오입니다.")
        async with self._lock:
            self.scenario_id = scenario_id
            self.elapsed_seconds = 0.0
            self.faults.clear()
            self.run_id = f"RUN-{uuid.uuid4().hex[:12].upper()}"
            self.started_at = datetime.now(timezone.utc)
            self._emit("scenario.loaded", "info", f"{scenario_id} 시나리오 로드")
            return self.status()

    async def inject_fault(self, request: dict) -> dict:
        async with self._lock:
            fault = {
                "id": f"FLT-{self.sequence:06d}-{len(self.faults) + 1:02d}",
                **request,
                "active": True,
                "created_at": self.elapsed_seconds,
                "expires_at": self.elapsed_seconds + request["duration_seconds"],
            }
            self.faults.append(fault)
            self._emit("fault.injected", "warning", f"{fault['target']} · {fault['kind']}", fault)
            return deepcopy(fault)

    async def mission_action(self, mission_id: str, action: str) -> dict:
        return await self._missions.mission_action(mission_id, action)

    def validate_mission(self, mission_id: str) -> dict:
        return self._missions.validate_mission(mission_id)

    async def mutate_task(self, payload: dict[str, Any]) -> dict:
        return await self._missions.mutate_task(payload)

    async def replan_mission(self, mission_id: str, apply: bool = True) -> dict:
        return await self._missions.replan_mission(mission_id, apply)

    async def device_action(self, device_id: str, action: str) -> dict:
        async with self._lock:
            device = next((d for d in self.devices if d["id"] == device_id), None)
            if not device:
                raise ValueError("장비를 찾을 수 없습니다.")
            device.update(apply_device_action(deepcopy(device), action))
            self._emit(f"hil.{action}", "info", f"{device_id} · {action}", device)
            return deepcopy(device)

    def hil_preflight(self) -> dict:
        return preflight(deepcopy(self.devices), self.status())

    async def run_hil_sequence(self, sequence_id: str) -> dict:
        async with self._lock:
            preflight = self.hil_preflight()
            steps = [
                {"id": "S1", "name": "Preflight", "status": "passed" if preflight["passed"] else "failed"},
                {"id": "S2", "name": "Clock Sync", "status": "passed" if all((not d["connected"]) or d.get("clock_state") == "LOCKED" for d in self.devices) else "failed"},
                {"id": "S3", "name": "Channel Loopback", "status": "passed" if all((not d["connected"]) or d["health"] >= 80 for d in self.devices) else "failed"},
                {"id": "S4", "name": "Safety Interlock", "status": "passed" if not any(f.get("severity") == "high" for f in self.faults) else "failed"},
            ]
            if sequence_id == "fault_recovery":
                steps.append({"id": "S5", "name": "Fault Recovery", "status": "passed" if not self.faults else "failed"})
            status = "completed" if all(step["status"] == "passed" for step in steps) else "failed"
            self._emit("hil.sequence.completed", "info" if status == "completed" else "warning", f"{sequence_id} · {status}", {"sequence_id": sequence_id, "steps": steps})
            return {"sequence_id": sequence_id, "run_id": self.run_id, "status": status, "steps": steps, "preflight": preflight}

    async def set_recording(self, enabled: bool) -> dict:
        async with self._lock:
            self.recording = enabled
            self._emit("recording.started" if enabled else "recording.stopped", "info", "시험 기록 ON" if enabled else "시험 기록 OFF")
            return {"run_id": self.run_id, "recording": self.recording}

    def status(self) -> dict:
        return {
            "running": self.running,
            "speed": self.speed,
            "elapsed_seconds": round(self.elapsed_seconds, 3),
            "scenario_id": self.scenario_id,
            "sequence": self.sequence,
            "active_faults": deepcopy(self.faults),
            "started_at": self.started_at.isoformat(),
            "run_id": self.run_id,
            "mode": self.mode,
            "scenario_version": self.scenario_version,
            "random_seed": self.random_seed,
            "recording": self.recording,
            "data_quality": self.data_quality,
        }

    def _refresh_telemetry(self) -> None:
        self.current_telemetry = calculate_telemetry(self.elapsed_seconds, deepcopy(self.faults))
        self._last_snapshot_second = int(self.elapsed_seconds)

    def telemetry(self) -> dict:
        return {
            "type": "telemetry",
            "runtime": self.status(),
            "telemetry": deepcopy(self.current_telemetry),
            "events": deepcopy(list(self.events)[:12]),
            "devices": deepcopy(self.devices),
            "missions": deepcopy(self.missions),
            "wall_time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "data_quality": {"status": self.data_quality, "mode": self.mode, "source": "deterministic-sim", "sequence": self.sequence},
        }



