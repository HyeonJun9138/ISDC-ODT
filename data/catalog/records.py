from typing import Any
from digital_twin.simulation.orbital_elements import derive_orbit

def _normalize(item: dict[str, Any]) -> dict[str, Any]:
    result = dict(item)
    name = result.get("OBJECT_NAME") or result.get("OBJECT_ID") or "UNKNOWN"
    result["OBJECT_NAME"] = str(name).strip()
    result["NORAD_CAT_ID"] = int(result.get("NORAD_CAT_ID") or 0)
    result["source"] = "celestrak"
    result.update(derive_orbit(result))
    return result


def _filtered_items(items: list[dict[str, Any]], query: str = "", orbit: str = "all") -> list[dict[str, Any]]:
    query = query.strip().lower()
    orbit = orbit.upper()
    result = items
    if query:
        result = [
            item
            for item in result
            if query in str(item.get("OBJECT_NAME", "")).lower()
            or query in str(item.get("OBJECT_ID", "")).lower()
            or query in str(item.get("NORAD_CAT_ID", ""))
        ]
    if orbit != "ALL":
        result = [item for item in result if item.get("ORBIT_REGIME") == orbit]
    return result


def _catalog_page(items: list[dict[str, Any]], offset: int, limit: int) -> list[dict[str, Any]]:
    """Return the full remaining catalog when limit=0, otherwise a bounded page."""
    return items[offset:] if limit == 0 else items[offset : offset + limit]


def _catalog_truncated(filtered_total: int, offset: int, page_count: int, limit: int) -> bool:
    return limit != 0 and offset + page_count < filtered_total


def _satcat_fallback_from_gp(item: dict[str, Any]) -> dict[str, Any]:
    """Build the subset of SATCAT metadata that can be stated from GP data alone."""
    return {
        "OBJECT_NAME": item.get("OBJECT_NAME") or "UNKNOWN",
        "OBJECT_ID": item.get("OBJECT_ID") or "",
        "NORAD_CAT_ID": int(item.get("NORAD_CAT_ID") or 0),
        "OBJECT_TYPE": "",
        "OPS_STATUS_CODE": "",
        "OWNER": "",
        "LAUNCH_DATE": "",
        "LAUNCH_SITE": "",
        "DECAY_DATE": "",
        "PERIOD": item.get("PERIOD_MINUTES"),
        "INCLINATION": item.get("INCLINATION"),
        "APOGEE": item.get("APOGEE_KM"),
        "PERIGEE": item.get("PERIGEE_KM"),
        "RCS": None,
        "DATA_STATUS_CODE": "",
        "ORBIT_CENTER": "EA",
        "ORBIT_TYPE": "ORB",
    }
