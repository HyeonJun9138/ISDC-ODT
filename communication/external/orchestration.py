"""HTTP forwarder to a constellation operations module running in another process (ICD-03 over HTTP).

The remote side must expose the same endpoints this application serves under /api/orchestration.
Failures are reported as OrchestrationUnavailable so the console shows the module as disconnected
instead of pretending it answered.
"""
from __future__ import annotations

import httpx

from digital_twin.contracts.orchestration import OrchestrationUnavailable


class RemoteOrchestration:
    implementation = "remote"

    def __init__(self, base_url: str, *, timeout_s: float = 4.0, client: httpx.Client | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = client or httpx.Client(base_url=self.base_url, timeout=timeout_s)

    def _call(self, method: str, path: str, **kwargs) -> dict:
        try:
            response = self._client.request(method, path, **kwargs)
        except httpx.HTTPError as error:
            raise OrchestrationUnavailable(f"군집 운용 모듈 {self.base_url} 응답 없음: {error.__class__.__name__}") from error
        if response.status_code >= 500:
            raise OrchestrationUnavailable(f"군집 운용 모듈 {self.base_url} 오류 응답 {response.status_code}")
        if response.status_code >= 400:
            detail = ""
            try:
                detail = str(response.json().get("detail") or "")
            except ValueError:
                pass
            raise ValueError(detail or f"군집 운용 요청 거부 ({response.status_code})")
        return response.json()

    def plan(self, request: dict) -> dict:
        return self._call("POST", "/api/orchestration/plan", json=request)

    def commit(self, message: dict) -> dict:
        return self._call("POST", "/api/orchestration/commit", json=message)

    def status(self) -> dict:
        remote = self._call("GET", "/api/orchestration/status")
        return {**remote, "placement": "remote", "endpoint": self.base_url, "reachable": True}

    def close(self) -> None:
        self._client.close()
