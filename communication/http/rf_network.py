from __future__ import annotations

from fastapi import APIRouter, Request, Query
from .dependencies import runtime_of, queries_of
from .schemas import LinkBudgetRequest, RouteRequest

router = APIRouter()


@router.post("/api/communication/link-budget")
async def link_budget(request: Request, command: LinkBudgetRequest) -> dict:
    return queries_of(request).calculate_link_budget(command.model_dump())


@router.post("/api/communication/route")
async def communication_route(request: Request, command: RouteRequest) -> dict:
    runtime = runtime_of(request)
    return queries_of(request).calculate_route(command.source, command.target, command.objective, runtime.snapshot().faults)


@router.get("/api/communication/contacts")
async def communication_contacts(request: Request, hours: int = Query(default=12, ge=1, le=72)) -> dict:
    items = queries_of(request).contact_plan(hours)
    return {"hours": hours, "count": len(items), "items": items, "provenance": "scenario-contact-plan-v1"}
