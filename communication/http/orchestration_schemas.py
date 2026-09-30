"""Wire schemas of ICD-03 (constellation operations) messages.

The mission request carries what the twin computed; nested records keep extra fields so the ICD
can grow without a schema change on this side. Only the top-level shape is enforced here; the
module validates the rest and reports domain errors as 400.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class MissionRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str = Field(min_length=1, max_length=80)
    kind: Literal["observe", "compute", "relay", "pickup", "fleet_update"]
    priority: int = Field(default=3, ge=1, le=5)
    window_start: str | None = Field(default=None, max_length=40)
    deadline: str = Field(min_length=1, max_length=40)
    params: dict = Field(default_factory=dict)


class PlanWindows(BaseModel):
    model_config = ConfigDict(extra="allow")

    contacts: list[dict] = Field(default_factory=list, max_length=20000)
    target_access: list[dict] = Field(default_factory=list, max_length=5000)
    crosslinks: list[dict] = Field(default_factory=list, max_length=5000)
    eclipses: list[dict] = Field(default_factory=list, max_length=20000)


class CommitRequest(BaseModel):
    """OR-03 실행 확정·중단 통보 (digital twin → constellation operations)."""

    model_config = ConfigDict(extra="allow")

    time: str = Field(min_length=1, max_length=40)
    mission_id: str = Field(min_length=1, max_length=80)
    decision: Literal["commit", "abort"]
    version: int = Field(default=1, ge=0)
    tasks: list[dict] = Field(default_factory=list, max_length=2000)


class PlanRequest(BaseModel):
    """OR-01 임무 편성 요청 (digital twin → constellation operations)."""

    model_config = ConfigDict(extra="allow")

    time: str = Field(min_length=1, max_length=40)
    mission: MissionRequest
    satellites: list[dict] = Field(default_factory=list, max_length=2000)
    stations: list[dict] = Field(default_factory=list, max_length=200)
    windows: PlanWindows = Field(default_factory=PlanWindows)
    mesh: dict[str, list[str]] = Field(default_factory=dict)
    exclude: list[str] = Field(default_factory=list, max_length=2000)
