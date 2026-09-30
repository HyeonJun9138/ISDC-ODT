"""The accepted SDC data configuration, not the browser's orbit editing draft."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator


class DeploymentEquipment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=80)
    catalog: Literal["oisl_standard", "oisl_long_range", "oisl_mini", "ka_user_link", "x_band_downlink", "s_band_ttc", "eo_camera", "dtn_store", "gnss_receiver"]
    enabled: StrictBool


class DeploymentNode(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=80)
    mode: Literal["nominal", "standby", "safe"]
    equipment: list[DeploymentEquipment] = Field(max_length=100)

    @model_validator(mode="after")
    def unique_equipment(self):
        if len({item.id for item in self.equipment}) != len(self.equipment):
            raise ValueError("노드의 장비 ID가 중복됩니다.")
        return self


class DataDeploymentCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    deployment_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")
    expected_revision: int = Field(ge=0, strict=True)
    nodes: list[DeploymentNode] = Field(max_length=240)

    @model_validator(mode="after")
    def unique_nodes(self):
        if len({item.id for item in self.nodes}) != len(self.nodes):
            raise ValueError("노드 ID가 중복됩니다.")
        return self
