"""ICD-02 endpoints between the twin console and the data fabric module."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from digital_twin.contracts.data_fabric import DataFabricUnavailable
from .dependencies import data_fabric_of
from .schemas import FabricRouteRequest, NetworkSnapshot

router = APIRouter()


async def _guarded(call, *args):
    try:
        return await run_in_threadpool(call, *args)
    except DataFabricUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@router.post("/api/data-fabric/network")
async def data_fabric_network(request: Request, snapshot: NetworkSnapshot) -> dict:
    return await _guarded(data_fabric_of(request).update, snapshot.model_dump())


@router.post("/api/data-fabric/route")
async def data_fabric_route(request: Request, command: FabricRouteRequest) -> dict:
    return await _guarded(data_fabric_of(request).route, command.source, command.target, command.objective)


@router.get("/api/data-fabric/status")
async def data_fabric_status(request: Request) -> dict:
    fabric = data_fabric_of(request)
    try:
        return await run_in_threadpool(fabric.status)
    except DataFabricUnavailable as error:
        return {"module": "data_fabric", "implementation": getattr(fabric, "implementation", "unknown"), "placement": "remote",
                "endpoint": getattr(fabric, "base_url", None), "reachable": False, "detail": str(error)}
