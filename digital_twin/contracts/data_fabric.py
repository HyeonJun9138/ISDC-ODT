"""Contract between the twin's HTTP adapter and the data fabric module (ICD-02).

The twin sends its network state and receives link quality, ground paths and store-and-forward
state. Whether the module runs in this process or on another computer is decided at the
composition root; callers only see this contract.
"""
from __future__ import annotations

from typing import Protocol


class DataFabricUnavailable(RuntimeError):
    """The configured data fabric endpoint did not answer."""


class DataFabricLink(Protocol):
    def update(self, snapshot: dict) -> dict:
        """네트워크 상태 갱신: twin nodes and links in, link quality and paths out."""

    def route(self, source: str, target: str, objective: str = "balanced") -> dict:
        """경로 계산 요청 over the last network state."""

    def status(self) -> dict:
        """Implementation, version, placement, endpoint, sequence and last update."""
