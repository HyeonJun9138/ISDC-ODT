from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class RuntimeControl(BaseModel):
    action: Literal["start", "pause", "reset", "step"]
    speed: float | None = Field(default=None, ge=0.1, le=128)


class RuntimeSpeed(BaseModel):
    speed: float = Field(ge=0.1, le=128)


class FaultRequest(BaseModel):
    target: str = Field(min_length=1, max_length=80)
    kind: Literal["link_loss", "power_drop", "thermal_spike", "storage_pressure", "latency_spike"]
    severity: Literal["low", "medium", "high"] = "medium"
    duration_seconds: int = Field(default=60, ge=1, le=3600)


class MissionAction(BaseModel):
    mission_id: str = Field(min_length=1, max_length=80)
    action: Literal["start", "pause", "replan", "abort", "complete"]


class DeviceAction(BaseModel):
    device_id: str = Field(min_length=1, max_length=80)
    action: Literal["connect", "disconnect", "sync", "loopback"]


class ScenarioSelection(BaseModel):
    scenario_id: str = Field(min_length=1, max_length=80)


class LinkBudgetRequest(BaseModel):
    link_id: str = Field(min_length=1, max_length=40)
    frequency_ghz: float = Field(default=26.0, gt=0.1, le=300)
    distance_km: float = Field(default=1200.0, gt=1, le=100000)
    tx_power_w: float = Field(default=20.0, gt=0.01, le=100000)
    tx_gain_dbi: float = Field(default=32.0, ge=-20, le=100)
    rx_gain_dbi: float = Field(default=34.0, ge=-20, le=100)
    misc_losses_db: float = Field(default=3.0, ge=0, le=100)
    bandwidth_mhz: float = Field(default=20.0, gt=0.001, le=100000)
    data_rate_mbps: float = Field(default=10.0, gt=0.001, le=100000)
    system_temp_k: float = Field(default=290.0, gt=1, le=5000)
    required_ebno_db: float = Field(default=7.0, ge=-10, le=50)


class RouteRequest(BaseModel):
    source: str = Field(min_length=1, max_length=40)
    target: str = Field(min_length=1, max_length=40)
    objective: Literal["latency", "reliability", "balanced"] = "balanced"


class MissionTaskMutation(BaseModel):
    mission_id: str = Field(min_length=1, max_length=80)
    task_id: str | None = Field(default=None, max_length=80)
    operation: Literal["create", "update", "delete"]
    lane: Literal["관측", "처리", "저장", "전송", "검증"] | None = None
    name: str | None = Field(default=None, max_length=120)
    start: float | None = Field(default=None, ge=0, le=100)
    duration: float | None = Field(default=None, gt=0, le=100)
    status: Literal["planned", "running", "done", "blocked"] | None = None
    predecessor: str | None = Field(default=None, max_length=80)
    priority: int | None = Field(default=None, ge=1, le=10)


class MissionReplanRequest(BaseModel):
    mission_id: str = Field(min_length=1, max_length=80)
    apply: bool = True


class HilSequenceRequest(BaseModel):
    sequence_id: Literal["preflight", "closed_loop", "fault_recovery"] = "closed_loop"


class RecordingControl(BaseModel):
    enabled: bool
