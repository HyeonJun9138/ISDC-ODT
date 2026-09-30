"""HTTP forwarder to a data management module running in another process (ICD-01 over HTTP).

The remote side must expose the same endpoints this application serves under
/api/data-management. Failures are reported as DataManagementUnavailable so the caller can show
the module as disconnected instead of pretending it answered.
"""
from __future__ import annotations

import httpx

from digital_twin.contracts.data_management import DataManagementUnavailable


class RemoteDataManagement:
    implementation = "remote"

    def __init__(self, base_url: str, *, timeout_s: float = 2.5, client: httpx.Client | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = client or httpx.Client(base_url=self.base_url, timeout=timeout_s)
        self.scope_id: str | None = None

    def for_scope(self, scope_id: str):
        status = self._call("GET", "/api/data-management/status")
        if status.get("scope_contract") != "isolated-v1":
            raise DataManagementUnavailable("외부 데이터 관리 모듈이 범위 분리 계약 isolated-v1을 지원하지 않습니다.")
        scoped = RemoteDataManagement(self.base_url, client=self._client)
        scoped.scope_id = scope_id
        return scoped

    def _call(self, method: str, path: str, **kwargs) -> dict:
        if self.scope_id:
            field = "json" if method == "POST" else "params"
            kwargs[field] = {**kwargs.get(field, {}), "scope_id": self.scope_id}
        try:
            response = self._client.request(method, path, **kwargs)
        except httpx.HTTPError as error:
            raise DataManagementUnavailable(f"데이터 관리 모듈 {self.base_url} 응답 없음: {error.__class__.__name__}") from error
        if response.status_code >= 500:
            raise DataManagementUnavailable(f"데이터 관리 모듈 {self.base_url} 오류 응답 {response.status_code}")
        if response.status_code >= 400:
            detail = ""
            try:
                detail = str(response.json().get("detail") or "")
            except ValueError:
                pass
            raise ValueError(detail or f"데이터 관리 요청 거부 ({response.status_code})")
        try:
            result = response.json()
        except ValueError as error:
            raise DataManagementUnavailable("데이터 관리 모듈이 JSON 응답을 반환하지 않았습니다.") from error
        if not isinstance(result, dict) or (self.scope_id and (result.get("scope_id") != self.scope_id or result.get("scope_contract") != "isolated-v1")):
            raise DataManagementUnavailable("외부 데이터 관리 모듈 응답의 운용 범위가 일치하지 않습니다.")
        return result

    def update_nodes(self, message: dict) -> dict:
        return self._call("POST", "/api/data-management/nodes", json=message)

    def ingest(self, message: dict) -> dict:
        return self._call("POST", "/api/data-management/ingest", json=message)

    def request(self, message: dict) -> dict:
        return self._call("POST", "/api/data-management/requests", json=message)

    def action(self, message: dict) -> dict:
        return self._call("POST", "/api/data-management/actions", json=message)

    def overview(self) -> dict:
        return self._call("GET", "/api/data-management/overview")

    def objects(self, filters: dict | None = None) -> dict:
        params = {key: value for key, value in (filters or {}).items() if value not in (None, "")}
        return self._call("GET", "/api/data-management/objects", params=params)

    def nodes(self) -> dict:
        return self._call("GET", "/api/data-management/nodes")

    def events(self, after: int = 0) -> dict:
        return self._call("GET", "/api/data-management/events", params={"after": int(after or 0)})

    def status(self) -> dict:
        remote = self._call("GET", "/api/data-management/status")
        return {**remote, "placement": "remote", "endpoint": self.base_url, "reachable": True}

    def close(self) -> None:
        self._client.close()
