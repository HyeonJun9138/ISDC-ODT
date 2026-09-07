from __future__ import annotations

from fastapi import APIRouter, Request
from .dependencies import runtime_of
from .schemas import MissionAction, MissionTaskMutation, MissionReplanRequest

router = APIRouter()


@router.post("/api/missions/action")
async def mission_action(request: Request, command: MissionAction) -> dict:
    runtime = runtime_of(request)
    return await runtime.mission_action(command.mission_id, command.action)


@router.post("/api/missions/tasks")
async def mission_task(request: Request, command: MissionTaskMutation) -> dict:
    runtime = runtime_of(request)
    return await runtime.mutate_task(command.model_dump())


@router.get("/api/missions/{mission_id}/validate")
async def mission_validate(request: Request, mission_id: str) -> dict:
    runtime = runtime_of(request)
    return runtime.validate_mission(mission_id)


@router.post("/api/missions/replan")
async def mission_replan(request: Request, command: MissionReplanRequest) -> dict:
    runtime = runtime_of(request)
    return await runtime.replan_mission(command.mission_id, command.apply)
