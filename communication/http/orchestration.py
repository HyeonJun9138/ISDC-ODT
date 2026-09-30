"""ICD-03 endpoints between the twin console and the constellation operations module."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from digital_twin.contracts.orchestration import OrchestrationUnavailable
from .dependencies import orchestration_of
from .orchestration_schemas import CommitRequest, PlanRequest

router = APIRouter()


async def _guarded(call, *args):
    try:
        return await run_in_threadpool(call, *args)
    except OrchestrationUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@router.post("/api/orchestration/plan")
async def orchestration_plan(request: Request, command: PlanRequest) -> dict:
    return await _guarded(orchestration_of(request).plan, command.model_dump())


@router.post("/api/orchestration/commit")
async def orchestration_commit(request: Request, command: CommitRequest) -> dict:
    return await _guarded(orchestration_of(request).commit, command.model_dump())


@router.get("/api/orchestration/status")
async def orchestration_status(request: Request) -> dict:
    module = orchestration_of(request)
    try:
        return await run_in_threadpool(module.status)
    except OrchestrationUnavailable as error:
        return {"module": "orchestration", "implementation": getattr(module, "implementation", "unknown"), "placement": "remote",
                "endpoint": getattr(module, "base_url", None), "reachable": False, "detail": str(error)}
