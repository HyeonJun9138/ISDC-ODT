"""ICD-08 incoming wire format. Out-of-range metrics are evidence gaps, not zero."""
from datetime import datetime, timedelta
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictFloat, StrictInt, field_validator


class SecurityObservation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    contract_version: Literal["1.0"]
    source: Literal["SIM"]
    run_id: str = Field(min_length=1)
    sample_id: str = Field(min_length=1)
    sim_elapsed_s: StrictFloat | StrictInt = Field(ge=0, allow_inf_nan=False)
    observed_at: str
    running: StrictBool
    auth_percent: StrictFloat | StrictInt | None = None
    throughput_mbps: StrictFloat | StrictInt | None = None
    loss_percent: StrictFloat | StrictInt | None = None
    devices: list[dict] = Field(default_factory=list)

    @field_validator("devices")
    @classmethod
    def device_evidence(cls, value):
        for device in value:
            identifier = device.get("id")
            if not isinstance(identifier, str) or not identifier.strip() or type(device.get("connected")) is not bool:
                raise ValueError("장비 정보에는 문자열 id와 불리언 connected가 필요합니다.")
        return value

    @field_validator("run_id", "sample_id")
    @classmethod
    def identifier(cls, value):
        if not value.strip():
            raise ValueError("비어 있는 식별자는 허용하지 않습니다.")
        return value

    @field_validator("observed_at")
    @classmethod
    def utc_timestamp(cls, value):
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.utcoffset() != timedelta(0):
            raise ValueError("UTC ISO 8601 시각이 필요합니다.")
        return value
