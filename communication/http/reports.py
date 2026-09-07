from __future__ import annotations

from datetime import datetime, timezone
from copy import deepcopy
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
from .dependencies import runtime_of, queries_of
from data.exports import summary_csv

router = APIRouter()


@router.get("/api/reports/summary.csv")
async def report_csv(request: Request) -> StreamingResponse:
    runtime = runtime_of(request)
    payload = summary_csv(queries_of(request).evaluate(runtime.snapshot()))
    return StreamingResponse(
        iter([payload]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="spacetwin-report.csv"'},
    )


@router.get("/api/reports/snapshot.json")
async def report_json(request: Request) -> JSONResponse:
    runtime = runtime_of(request)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "runtime": runtime.status(),
        "analytics": queries_of(request).evaluate(runtime.snapshot()),
        "events": deepcopy(list(runtime.events)),
    }
    return JSONResponse(payload, headers={"Content-Disposition": 'attachment; filename="spacetwin-snapshot.json"'})
