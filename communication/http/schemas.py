from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


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


class ScenarioAdvance(BaseModel):
    """Forward-only jump of the simulation clock used by the scenario player."""

    seconds: float = Field(gt=0, le=3600)


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


class NetworkNode(BaseModel):
    """ICD-02 node record: a satellite the twin propagates or a ground station it models."""

    model_config = ConfigDict(extra="allow")

    id: str = Field(min_length=1, max_length=80)
    kind: Literal["satellite", "ground"]
    name: str | None = Field(default=None, max_length=80)
    mode: str | None = Field(default=None, max_length=40)
    generation_mbps: float = Field(default=0.0, ge=0, le=100000)
    storage_gb: float = Field(default=0.0, ge=0, le=1e6)
    extra_delay_ms: float = Field(default=0.0, ge=0, le=100000)


class NetworkLink(BaseModel):
    """ICD-02 link record with the geometry and terminal state the twin observed."""

    model_config = ConfigDict(extra="allow")

    id: str = Field(min_length=1, max_length=160)
    a: str = Field(min_length=1, max_length=80)
    b: str = Field(min_length=1, max_length=80)
    kind: Literal["oisl", "ground", "terrestrial"]
    state: str | None = Field(default=None, max_length=40)
    faulted: bool = False


class NetworkSnapshot(BaseModel):
    """네트워크 상태 갱신 (digital twin → data fabric)."""

    model_config = ConfigDict(extra="allow")

    time: str = Field(min_length=1, max_length=40)
    nodes: list[NetworkNode] = Field(max_length=2000)
    links: list[NetworkLink] = Field(max_length=20000)


class FabricRouteRequest(BaseModel):
    source: str = Field(min_length=1, max_length=80)
    target: str = Field(min_length=1, max_length=80)
    objective: Literal["latency", "reliability", "balanced"] = "balanced"


class ProbeLink(BaseModel):
    """One topology link the settings tab wants checked (module connection probe)."""

    id: str = Field(min_length=1, max_length=40)
    transport: Literal["IPC", "TCP", "UDP", "WebSocket", "gRPC"] = "TCP"
    host: str = Field(default="127.0.0.1", max_length=253)
    port: int = Field(default=0, ge=0, le=65535)
    timeout_s: float = Field(default=1.0, ge=0.1, le=5.0)
    endpoints: list[str] = Field(default_factory=list, max_length=2)


class ProbeRequest(BaseModel):
    links: list[ProbeLink] = Field(default_factory=list, max_length=64)


class DataProduct(BaseModel):
    """ICD-01 product record: one data item a node registers with the data center."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    ref: str = Field(min_length=1, max_length=120)
    class_: str = Field(alias="class", min_length=1, max_length=40)
    source: str = Field(min_length=1, max_length=80)
    size_mb: float = Field(ge=0, le=1e7)
    priority: int = Field(default=1, ge=0, le=9)
    label: str | None = Field(default=None, max_length=120)
    created_s: float | None = Field(default=None, ge=0)


class DataIngestMessage(BaseModel):
    """DM-01 수집 등록 (digital twin → data management)."""

    model_config = ConfigDict(extra="allow")
    scope_id: str | None = Field(default=None, min_length=1, max_length=240)

    time: str = Field(min_length=1, max_length=40)
    sim_elapsed_s: float = Field(ge=0)
    products: list[DataProduct] = Field(max_length=2000)


class DataServiceRequest(BaseModel):
    """DM-02 서비스 요청."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)
    scope_id: str | None = Field(default=None, min_length=1, max_length=240)

    time: str = Field(min_length=1, max_length=40)
    sim_elapsed_s: float = Field(ge=0)
    object_id: str | None = Field(default=None, max_length=80)
    class_: str | None = Field(default=None, alias="class", max_length=40)
    destination: str = Field(min_length=1, max_length=80)
    requester: str = Field(default="operator", max_length=80)


class DataActionRequest(BaseModel):
    """DM-03 운영 조치."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)
    scope_id: str | None = Field(default=None, min_length=1, max_length=240)

    time: str = Field(min_length=1, max_length=40)
    sim_elapsed_s: float = Field(ge=0)
    action: Literal["verify", "heal", "rebalance", "set_replication", "set_filter", "purge_expired"]
    object_id: str | None = Field(default=None, max_length=80)
    class_: str | None = Field(default=None, alias="class", max_length=40)
    replication: int | None = Field(default=None, ge=1, le=5)
    filter: dict | None = None


class StorageNodeRecord(BaseModel):
    """DM-04 storage node record with the availability the twin observed."""

    model_config = ConfigDict(extra="allow")

    id: str = Field(min_length=1, max_length=80)
    name: str | None = Field(default=None, max_length=80)
    kind: Literal["core", "edge", "onboard"]
    capacity_gb: float = Field(ge=0, le=1e9)
    available: bool = True
    reason: str | None = Field(default=None, max_length=120)


class StorageTopology(BaseModel):
    """DM-04 저장 노드 상태 갱신 (digital twin → data management)."""

    model_config = ConfigDict(extra="allow")
    scope_id: str | None = Field(default=None, min_length=1, max_length=240)

    time: str = Field(min_length=1, max_length=40)
    sim_elapsed_s: float = Field(ge=0)
    nodes: list[StorageNodeRecord] = Field(max_length=500)


class ConsoleServiceRequest(BaseModel):
    """Operator request from the console; the twin stamps the ICD time fields."""

    model_config = ConfigDict(populate_by_name=True)
    scope_id: str | None = Field(default=None, min_length=1, max_length=240)

    object_id: str | None = Field(default=None, max_length=80)
    class_: str | None = Field(default=None, alias="class", max_length=40)
    destination: str = Field(min_length=1, max_length=80)


class ConsoleActionRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    scope_id: str | None = Field(default=None, min_length=1, max_length=240)

    action: Literal["verify", "heal", "rebalance", "set_replication", "set_filter", "purge_expired"]
    object_id: str | None = Field(default=None, max_length=80)
    class_: str | None = Field(default=None, alias="class", max_length=40)
    replication: int | None = Field(default=None, ge=1, le=5)
    filter: dict | None = None
