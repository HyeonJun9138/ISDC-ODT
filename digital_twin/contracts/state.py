from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RuntimeSnapshot:
    """Detached read model. Nested dictionaries are copies, not live state."""

    current_telemetry: dict
    missions: list[dict]
    faults: list[dict]
    data_quality: str
    elapsed_seconds: float
    sequence: int
    run_id: str
    scenario_id: str
    mode: str
    recording: bool
