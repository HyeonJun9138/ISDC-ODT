"""Contract between the twin's HTTP adapter and the constellation operations module (ICD-03).

The twin sends one mission request with the windows it computed and receives the assigned tasks
and a verdict; when the operator confirms or aborts a plan the twin notifies the module so it can
hold the assigned intervals. Whether the module runs in this process or on another computer is
decided at the composition root; callers only see this contract.
"""
from __future__ import annotations

from typing import Protocol


class OrchestrationUnavailable(RuntimeError):
    """The configured orchestration endpoint did not answer."""


class OrchestrationLink(Protocol):
    def plan(self, request: dict) -> dict:
        """OR-01 임무 편성 요청 in, OR-02 역할 배정 결과 out."""

    def commit(self, message: dict) -> dict:
        """OR-03 실행 확정·중단 통보 in, acknowledgement with the held intervals out."""

    def status(self) -> dict:
        """OR-04 모듈 상태: implementation, version, placement, endpoint, sequence, last update, committed plans."""
