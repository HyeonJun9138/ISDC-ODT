"""Accepted SDC deployments and explicitly scoped ICD-01 exchanges."""
from __future__ import annotations

import threading
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, Request
from starlette.concurrency import run_in_threadpool

from digital_twin.contracts.data_management import DataDeploymentConflict, DataManagementUnavailable
from .data_deployment_schemas import DataDeploymentCommand
from .dependencies import data_management_of, runtime_of
from .schemas import ConsoleActionRequest, ConsoleServiceRequest, DataActionRequest, DataIngestMessage, DataServiceRequest, StorageTopology

router = APIRouter()
SCOPE_CONTRACT = "isolated-v1"


def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _scope(module, scope_id):
    method = getattr(module, "for_scope", None)
    if method is None:
        raise DataManagementUnavailable("데이터 관리 모듈이 범위 분리 계약 isolated-v1을 지원하지 않습니다.")
    return method(scope_id)


class DataManagementBridge:
    """Transport delivery cursor only; accepted deployment and run belong to runtime."""

    def __init__(self):
        self.lock = threading.RLock()
        self.last_scope = None
        self.last_elapsed = None
        self.last_sync = None

    def sync(self, module, context):
        with self.lock:
            scope_id = context["deployment"]["scope_id"]
            scoped = _scope(module, scope_id)
            elapsed = float(context["runtime"]["elapsed_seconds"])
            stamp = {"time": _now_iso(), "sim_elapsed_s": elapsed, "scope_id": scope_id}
            scoped.update_nodes({**stamp, "nodes": context["inputs"]["nodes"]})
            begin = context["started_s"] if self.last_scope != scope_id or self.last_elapsed is None else self.last_elapsed
            products = context["products"](context["inputs"], begin, elapsed)
            ingest = None
            for offset in range(0, len(products), 2000):
                report = scoped.ingest({**stamp, "products": products[offset:offset + 2000]})
                if ingest is None:
                    ingest = {**report, "accepted": [], "rejected": []}
                ingest["accepted"].extend(report.get("accepted", []))
                ingest["rejected"].extend(report.get("rejected", []))
            # An unavailable ingest leaves the cursor intact; product refs make retries idempotent.
            self.last_scope, self.last_elapsed = scope_id, elapsed
            self.last_sync = {**stamp, "nodes": len(context["inputs"]["nodes"]), "products": len(products), "ingest": ingest}
            return scoped, self.last_sync


def bridge_of(request):
    return request.app.state.data_management_bridge


async def _guarded(call, *args):
    try:
        return await run_in_threadpool(call, *args)
    except DataManagementUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


def _icd_scope(request, scope_id):
    if not scope_id:
        raise HTTPException(status_code=409, detail="ICD 요청에는 scope_id가 필요합니다.")
    return _scope(data_management_of(request), scope_id)


async def _icd_write(request, message, method):
    body = message.model_dump(by_alias=True, exclude_none=True)
    return await _guarded(lambda: getattr(_icd_scope(request, body.get("scope_id")), method)(body))


@router.post("/api/data-management/nodes")
async def data_management_nodes_update(request: Request, message: StorageTopology):
    return await _icd_write(request, message, "update_nodes")


@router.post("/api/data-management/ingest")
async def data_management_ingest(request: Request, message: DataIngestMessage):
    return await _icd_write(request, message, "ingest")


@router.post("/api/data-management/requests")
async def data_management_request(request: Request, message: DataServiceRequest):
    return await _icd_write(request, message, "request")


@router.post("/api/data-management/actions")
async def data_management_action(request: Request, message: DataActionRequest):
    return await _icd_write(request, message, "action")


@router.get("/api/data-management/overview")
async def data_management_overview(request: Request, scope_id: str | None = None):
    return await _guarded(lambda: _icd_scope(request, scope_id).overview())


@router.get("/api/data-management/objects")
async def data_management_objects(request: Request, cls: str | None = Query(default=None, alias="class"), node: str | None = None,
                                  status: str | None = None, query: str | None = None, limit: int = Query(default=200, ge=1, le=1000), scope_id: str | None = None):
    return await _guarded(lambda: _icd_scope(request, scope_id).objects({"class": cls, "node": node, "status": status, "query": query, "limit": limit}))


@router.get("/api/data-management/nodes")
async def data_management_nodes(request: Request, scope_id: str | None = None):
    return await _guarded(lambda: _icd_scope(request, scope_id).nodes())


@router.get("/api/data-management/events")
async def data_management_events(request: Request, after: int = Query(default=0, ge=0), scope_id: str | None = None):
    return await _guarded(lambda: _icd_scope(request, scope_id).events(after))


def _unavailable(module, error):
    return {"module": "data_management", "implementation": getattr(module, "implementation", "unknown"), "placement": "remote",
            "endpoint": getattr(module, "base_url", None), "reachable": False, "detail": str(error)}


@router.get("/api/data-management/status")
async def data_management_status(request: Request, scope_id: str | None = None):
    module = data_management_of(request)
    try:
        return await run_in_threadpool(lambda: (_scope(module, scope_id) if scope_id else module).status())
    except DataManagementUnavailable as error:
        return _unavailable(module, error)


@router.get("/api/data-management/deployment")
async def data_management_deployment(request: Request):
    return runtime_of(request).data_deployment()


@router.post("/api/data-management/deployment")
async def data_management_deploy(request: Request, command: DataDeploymentCommand):
    async def activate(context):
        return await _guarded(bridge_of(request).sync, data_management_of(request), context)
    try:
        return await runtime_of(request).apply_data_deployment(command.model_dump(), activate)
    except DataDeploymentConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


def _dashboard(request, context, filters, after):
    bridge, module = bridge_of(request), data_management_of(request)
    with bridge.lock:
        try:
            scoped, sync = bridge.sync(module, context)
            return {"runtime": context["runtime"], "deployment": context["deployment"], "sync": sync,
                    "module": scoped.status(), "overview": scoped.overview(), "nodes": scoped.nodes()["nodes"],
                    "objects": scoped.objects(filters), "events": scoped.events(after)}
        except DataManagementUnavailable as error:
            return {"runtime": context["runtime"], "deployment": context["deployment"], "sync": None,
                    "module": _unavailable(module, error), "overview": None, "nodes": [],
                    "objects": {"total": 0, "items": []}, "events": {"items": [], "latest": after}}


@router.get("/api/data-management/dashboard")
async def data_management_dashboard(request: Request, cls: str | None = Query(default=None, alias="class"), node: str | None = None,
                                    status: str | None = None, query: str | None = None, limit: int = Query(default=200, ge=1, le=1000),
                                    after: int = Query(default=0, ge=0)):
    async def consume(context):
        return await run_in_threadpool(_dashboard, request, context, {"class": cls, "node": node, "status": status, "query": query, "limit": limit}, after)
    return await runtime_of(request).with_data_deployment(consume)


def _console_call(request, context, body, method):
    bridge = bridge_of(request)
    with bridge.lock:
        if body.get("scope_id") != context["deployment"]["scope_id"]:
            raise HTTPException(status_code=409, detail="현재 배치 범위가 달라졌습니다. 새로 고침 후 다시 시도하세요.")
        if not any(node["available"] and node["capacity_gb"] > 0 for node in context["inputs"]["nodes"]):
            raise HTTPException(status_code=409, detail="배치된 가용 저장소가 없어 운영 조치를 사용할 수 없습니다.")
        scoped, _ = bridge.sync(data_management_of(request), context)
        stamp = {"time": _now_iso(), "sim_elapsed_s": context["runtime"]["elapsed_seconds"], **body}
        return getattr(scoped, method)(stamp)


async def _console(request, body, method):
    async def consume(context):
        return await _guarded(_console_call, request, context, body.model_dump(by_alias=True, exclude_none=True), method)
    return await runtime_of(request).with_data_deployment(consume)


@router.post("/api/data-management/console/request")
async def console_request(request: Request, body: ConsoleServiceRequest):
    return await _console(request, body, "request")


@router.post("/api/data-management/console/action")
async def console_action(request: Request, body: ConsoleActionRequest):
    return await _console(request, body, "action")


@router.post("/api/data-management/console/snapshot")
async def console_snapshot(request: Request):
    raise HTTPException(status_code=409, detail="DT 운용 스냅샷은 SDC 노드 데이터와 출처 및 보관 정책이 달라 이 화면에서 전송하지 않습니다.")
