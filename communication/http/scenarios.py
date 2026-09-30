"""Scenario catalogue of the console (VF-01 시험 시나리오 정의·주입, embedded).

The scenario definitions are operational configuration assembled by the application; this router
only publishes them. Selecting and advancing the runtime clock stay under /api/scenario and
/api/runtime because they change runtime state.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from .dependencies import runtime_of

router = APIRouter()


def scenario_library_of(request: Request) -> dict:
    return request.app.state.scenario_library


@router.get("/api/scenarios")
async def list_scenarios(request: Request) -> dict:
    library = scenario_library_of(request)
    return {"scenarios": library["summaries"](), "current": runtime_of(request).status().get("scenario_id")}


@router.get("/api/scenarios/{scenario_id}")
async def scenario_detail(request: Request, scenario_id: str) -> dict:
    definition = scenario_library_of(request)["definition"](scenario_id)
    if definition is None:
        raise HTTPException(status_code=404, detail=f"재생 정의가 없는 시나리오입니다: {scenario_id}")
    return definition
