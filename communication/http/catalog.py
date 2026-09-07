from __future__ import annotations

from fastapi import APIRouter, Request, Path, Query
from .dependencies import catalog_of

router = APIRouter()


@router.get("/api/satellites")
async def satellites(request: Request, 
    group: str = Query(default="active", max_length=32),
    limit: int = Query(default=0, ge=0, le=50_000, description="0이면 필터 결과 전체 반환"),
    offset: int = Query(default=0, ge=0),
    q: str = Query(default="", max_length=100),
    orbit: str = Query(default="all", pattern="^(all|LEO|MEO|GEO|HEO)$"),
) -> dict:
    return await catalog_of(request).get_satellites(group=group, limit=limit, offset=offset, query=q, orbit=orbit)


@router.get("/api/satellites/{catalog_number}")
async def satellite_profile(request: Request, 
    catalog_number: int = Path(ge=1, le=999_999_999, description="NORAD Catalog Number"),
) -> dict:
    return await catalog_of(request).get_satellite_profile(catalog_number)


@router.get("/api/satellite-groups")
async def satellite_groups(request: Request) -> dict:
    return {"items": catalog_of(request).catalog_groups()}
