"""Per-link quality figures computed by the data fabric from the geometry the twin reports.

Inputs are one link record of the ICD-02 network message. Outputs are usable/unusable with a
reason, the one-way delay in ms, the capacity in Mbps, a 0-100 quality figure, the Eb/N0 margin
in dB and a bit error rate. The RF budget is a plain Friis budget; the optical margin is the
geometric margin the twin already reports relative to the terminal's rated range. These are
representative engineering figures for a stand-in, not a validated link budget.
"""
from __future__ import annotations

import math
from typing import Any

SPEED_OF_LIGHT_KM_S = 299_792.458
BOLTZMANN_DBW_HZ_K = -228.6
FIBER_VELOCITY_FACTOR = 0.67
OISL_PROCESSING_MS = 1.5
GROUND_PROCESSING_MS = 4.0
TERRESTRIAL_PROCESSING_MS = 3.0
REQUIRED_EBNO_DB = 9.6          # uncoded QPSK at 1e-5
IMPLEMENTATION_LOSS_DB = 6.0    # pointing, polarisation, implementation and rain allowance
ATMOSPHERIC_ZENITH_DB = {"Ka": 0.8, "X": 0.3, "S": 0.2}
MINIMUM_BER = 1e-15
USABLE_OISL_STATES = {"locked"}

LINK_KINDS = ("oisl", "ground", "terrestrial")


def _number(value: Any, default: float | None = None) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def quality_from_margin(margin_db: float | None) -> int:
    """0 % at -10 dB, 50 % at 0 dB, 100 % at +10 dB."""
    if margin_db is None:
        return 0
    return int(max(0, min(100, round(50 + 5 * margin_db))))


def ber_from_margin(margin_db: float | None) -> float:
    """QPSK bit error rate at the required Eb/N0 plus the margin; floored at 1e-15."""
    if margin_db is None:
        return 0.5
    ebno = 10 ** ((REQUIRED_EBNO_DB + margin_db) / 10)
    return max(MINIMUM_BER, min(0.5, 0.5 * math.erfc(math.sqrt(max(0.0, ebno)))))


def capacity_from_margin(data_rate_mbps: float, margin_db: float | None) -> float:
    """Full rate with 3 dB or more of margin, half rate at 0 dB, nothing below."""
    if margin_db is None or margin_db < 0:
        return 0.0
    if margin_db >= 3:
        return data_rate_mbps
    return round(data_rate_mbps * (0.5 + margin_db / 6), 3)


def propagation_ms(range_km: float, velocity_factor: float = 1.0) -> float:
    return range_km / (SPEED_OF_LIGHT_KM_S * velocity_factor) * 1000


def free_space_loss_db(frequency_ghz: float, range_km: float) -> float:
    return 92.45 + 20 * math.log10(frequency_ghz) + 20 * math.log10(range_km)


def atmospheric_loss_db(band: str, elevation_deg: float) -> float:
    zenith = ATMOSPHERIC_ZENITH_DB.get(str(band).upper(), 0.5)
    return zenith / math.sin(math.radians(max(5.0, elevation_deg)))


def rf_margin_db(*, eirp_dbw: float, gt_dbk: float, frequency_ghz: float, range_km: float,
                 data_rate_mbps: float, band: str, elevation_deg: float) -> float:
    cn0 = (eirp_dbw + gt_dbk - free_space_loss_db(frequency_ghz, range_km)
           - IMPLEMENTATION_LOSS_DB - atmospheric_loss_db(band, elevation_deg) - BOLTZMANN_DBW_HZ_K)
    ebno = cn0 - 10 * math.log10(data_rate_mbps * 1e6)
    return round(ebno - REQUIRED_EBNO_DB, 2)


def _result(link: dict, *, usable: bool, reason: str | None, delay_ms: float, capacity_mbps: float,
            quality: int, margin_db: float | None, ber: float) -> dict[str, Any]:
    return {
        "id": str(link.get("id")),
        "a": str(link.get("a")),
        "b": str(link.get("b")),
        "kind": str(link.get("kind")),
        "usable": bool(usable),
        "reason": reason,
        "delay_ms": round(delay_ms, 3),
        "capacity_mbps": round(capacity_mbps, 3),
        "quality": int(quality),
        "margin_db": None if margin_db is None else round(margin_db, 2),
        "ber": ber,
    }


def oisl_metrics(link: dict) -> dict[str, Any]:
    range_km = _number(link.get("range_km"))
    margin = _number(link.get("margin_db"))
    rate = _number(link.get("data_rate_mbps"), 0.0) or 0.0
    state = str(link.get("state") or "idle")
    faulted = bool(link.get("faulted"))
    delay = (propagation_ms(range_km) if range_km else 0.0) + OISL_PROCESSING_MS
    reason = None
    if faulted:
        reason = "fault"
    elif state not in USABLE_OISL_STATES:
        reason = "not_locked"
    elif margin is None or margin < 0:
        reason = "margin"
    usable = reason is None
    return _result(link, usable=usable, reason=reason, delay_ms=delay,
                   capacity_mbps=capacity_from_margin(rate, margin) if usable else 0.0,
                   quality=quality_from_margin(margin) if state in USABLE_OISL_STATES and not faulted else 0,
                   margin_db=margin, ber=ber_from_margin(margin) if margin is not None else 0.5)


def ground_metrics(link: dict) -> dict[str, Any]:
    range_km = _number(link.get("range_km"))
    elevation = _number(link.get("elevation_deg"))
    mask = _number(link.get("min_elevation_deg"), 5.0) or 0.0
    rate = _number(link.get("data_rate_mbps"), 0.0) or 0.0
    band = str(link.get("band") or "X")
    faulted = bool(link.get("faulted"))
    visible = elevation is not None and range_km is not None and range_km > 0 and elevation >= mask
    margin = None
    if visible:
        eirp = _number(link.get("eirp_dbw"))
        gt = _number(link.get("gt_dbk"))
        frequency = _number(link.get("frequency_ghz"))
        if None not in (eirp, gt, frequency) and rate > 0:
            margin = rf_margin_db(eirp_dbw=eirp, gt_dbk=gt, frequency_ghz=frequency, range_km=range_km,
                                  data_rate_mbps=rate, band=band, elevation_deg=elevation)
    reason = None
    if faulted:
        reason = "fault"
    elif not visible:
        reason = "below_mask"
    elif margin is None:
        reason = "no_budget"
    elif margin < 0:
        reason = "margin"
    usable = reason is None
    delay = (propagation_ms(range_km) if range_km else 0.0) + GROUND_PROCESSING_MS
    return _result(link, usable=usable, reason=reason, delay_ms=delay,
                   capacity_mbps=capacity_from_margin(rate, margin) if usable else 0.0,
                   quality=quality_from_margin(margin) if visible and not faulted else 0,
                   margin_db=margin, ber=ber_from_margin(margin) if margin is not None else 0.5)


def terrestrial_metrics(link: dict) -> dict[str, Any]:
    distance = _number(link.get("distance_km"), 0.0) or 0.0
    rate = _number(link.get("data_rate_mbps"), 10_000.0) or 10_000.0
    faulted = bool(link.get("faulted"))
    delay = propagation_ms(distance, FIBER_VELOCITY_FACTOR) + TERRESTRIAL_PROCESSING_MS
    return _result(link, usable=not faulted, reason="fault" if faulted else None, delay_ms=delay,
                   capacity_mbps=0.0 if faulted else rate, quality=0 if faulted else 100, margin_db=None,
                   ber=MINIMUM_BER)


def link_metrics(link: dict) -> dict[str, Any]:
    kind = str(link.get("kind") or "")
    if kind == "oisl":
        return oisl_metrics(link)
    if kind == "ground":
        return ground_metrics(link)
    if kind == "terrestrial":
        return terrestrial_metrics(link)
    raise ValueError(f"알 수 없는 링크 종류입니다: {kind or '(없음)'}")
