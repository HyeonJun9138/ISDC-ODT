from __future__ import annotations

from datetime import datetime, timezone
from copy import deepcopy
from fastapi import APIRouter, Request
from .dependencies import runtime_of, queries_of

router = APIRouter()


@router.get("/api/health")
async def health(request: Request) -> dict:
    runtime = runtime_of(request)
    return {
        "status": "ok",
        "name": request.app.title,
        "version": request.app.version,
        "time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "runtime": runtime.status(),
    }


@router.get("/api/bootstrap")
async def bootstrap(request: Request) -> dict:
    runtime = runtime_of(request)
    return {
        "runtime": runtime.status(),
        "scenarios": deepcopy(runtime.scenarios),
        "communication": queries_of(request).network(),
        "missions": deepcopy(runtime.missions),
        "analytics": queries_of(request).evaluate(runtime.snapshot()),
        "devices": deepcopy(runtime.devices),
        "events": deepcopy(list(runtime.events)),
    }
