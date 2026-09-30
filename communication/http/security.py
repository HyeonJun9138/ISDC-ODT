"""ICD-08 endpoints and query-driven forwarding of copied DT SIM observations."""
from copy import deepcopy
from threading import RLock

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from digital_twin.contracts.security import SecurityLink, SecurityUnavailable
from .dependencies import runtime_of
from .security_schemas import SecurityObservation

router = APIRouter()


def security_of(request: Request) -> SecurityLink:
    return request.app.state.security


def unavailable_status(module, error):
    return {"module": "security", "implementation": getattr(module, "implementation", "unknown"),
        "version": "unknown", "contract_version": "1.0", "source": "SIM",
        "placement": "remote" if getattr(module, "base_url", None) else "embedded",
        "endpoint": getattr(module, "base_url", None), "reachable": False, "run_id": None,
        "observed_at": None, "detail": str(error), "scope": "실제 보안 기능 미구현"}


async def _guarded(call, *args):
    try:
        return await run_in_threadpool(call, *args)
    except SecurityUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


class SecurityBridge:
    """Serialize console transactions, not a second DT state owner or background service."""
    def __init__(self):
        self.lock = RLock()

    def dashboard(self, module, payload, after):
        status = payload["runtime"]
        metrics = payload.get("telemetry", {})
        elapsed = status["elapsed_seconds"]
        run_id = status["run_id"]
        message = {"contract_version": "1.0", "source": "SIM", "run_id": run_id,
            "sample_id": f"{run_id}:{elapsed}", "sim_elapsed_s": elapsed,
            "observed_at": payload["wall_time"], "running": status["running"],
            "auth_percent": metrics.get("auth_percent"), "throughput_mbps": metrics.get("throughput_mbps"),
            "loss_percent": metrics.get("loss_percent"), "devices": deepcopy(payload.get("devices", []))}
        with self.lock:
            overview = module.observe(message)
            module_status = module.status()
            events = module.events(after)
            observation = overview.get("observation") if isinstance(overview, dict) else None
            if (not isinstance(observation, dict) or observation.get("run_id") != run_id
                    or not isinstance(module_status, dict) or module_status.get("run_id") != run_id
                    or not isinstance(events, dict) or events.get("run_id") != run_id):
                raise SecurityUnavailable("보안 모듈의 관측, 상태와 이력이 같은 실행을 가리키지 않습니다.")
            return {"module": module_status, "overview": overview, "events": events,
                "runtime": {key: status.get(key) for key in ("run_id", "elapsed_seconds", "running", "speed", "mode")}}


@router.post("/api/security/observations")
async def observe(request: Request, message: SecurityObservation):
    return await _guarded(security_of(request).observe, message.model_dump())


@router.get("/api/security/overview")
async def overview(request: Request):
    return await _guarded(security_of(request).overview)


@router.get("/api/security/events")
async def events(request: Request, after: int = Query(default=0, ge=0)):
    return await _guarded(security_of(request).events, after)


@router.get("/api/security/status")
async def status(request: Request):
    module = security_of(request)
    try:
        return await run_in_threadpool(module.status)
    except SecurityUnavailable as error:
        return JSONResponse(status_code=503, content=unavailable_status(module, error))


@router.get("/api/security/dashboard")
async def dashboard(request: Request, after: int = Query(default=0, ge=0)):
    module = security_of(request)
    # Synchronous snapshot on the event-loop thread cannot interleave with runtime mutation.
    payload = runtime_of(request).telemetry()
    try:
        return await run_in_threadpool(request.app.state.security_bridge.dashboard, module, payload, after)
    except SecurityUnavailable as error:
        return JSONResponse(status_code=503, content={"module": unavailable_status(module, error),
            "overview": None, "events": {"events": [], "latest": 0, "run_id": payload["runtime"]["run_id"]},
            "runtime": payload["runtime"]})
