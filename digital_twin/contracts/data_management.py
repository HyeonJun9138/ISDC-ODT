"""Contract between the twin's HTTP adapter and the data management module (ICD-01).

The data management module is the data center's lifecycle authority: which data objects exist,
where their replicas live across satellite and ground storage, whether they are complete and
consistent, and how service requests are fulfilled. It is distinct from the data fabric
(ICD-02), which moves bits and chooses network paths. Whether the module runs in this process or
on another computer is decided at the composition root; callers only see this contract.
"""
from __future__ import annotations

from typing import Protocol


class DataManagementUnavailable(RuntimeError):
    """The configured data management endpoint did not answer."""


class DataDeploymentConflict(ValueError):
    """The accepted deployment or execution scope differs from the command's expectation."""


class DataManagementLink(Protocol):
    def for_scope(self, scope_id: str) -> "DataManagementLink":
        """Return a separately addressed ICD-01 scope without deleting any other scope."""

    def update_nodes(self, message: dict) -> dict:
        """DM-04 저장 노드 상태 갱신: roster and availability in, node states out."""

    def ingest(self, message: dict) -> dict:
        """DM-01 수집 등록: products in, accepted placements and rejections out."""

    def request(self, message: dict) -> dict:
        """DM-02 서비스 요청: object or class plus destination in, served replica out."""

    def action(self, message: dict) -> dict:
        """DM-03 운영 조치: verify, heal, rebalance, set_replication, set_filter, purge_expired."""

    def overview(self) -> dict:
        """DM-05 상태 보고: stability, pipeline stages, capacity, jobs and alerts."""

    def objects(self, filters: dict | None = None) -> dict:
        """DM-06 카탈로그 조회."""

    def nodes(self) -> dict:
        """DM-07 저장 노드 상태."""

    def events(self, after: int = 0) -> dict:
        """DM-08 이벤트 조회 (sequence greater than `after`)."""

    def status(self) -> dict:
        """DM-09 모듈 상태: implementation, version, placement, endpoint, sequence."""
