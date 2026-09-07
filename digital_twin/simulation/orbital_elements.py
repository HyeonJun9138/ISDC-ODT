import math
from datetime import datetime, timezone
from typing import Any

EARTH_RADIUS_KM = 6378.137
EARTH_MU_KM3_S2 = 398600.4418

def derive_orbit(item: dict[str, Any]) -> dict[str, Any]:
    mean_motion = float(item.get("MEAN_MOTION") or 0)
    eccentricity = float(item.get("ECCENTRICITY") or 0)
    if mean_motion > 0:
        period_minutes = 1440.0 / mean_motion
        angular_rate = mean_motion * 2 * math.pi / 86400.0
        semi_major = (EARTH_MU_KM3_S2 / (angular_rate**2)) ** (1 / 3)
        perigee = semi_major * (1 - eccentricity) - EARTH_RADIUS_KM
        apogee = semi_major * (1 + eccentricity) - EARTH_RADIUS_KM
    else:
        period_minutes = semi_major = perigee = apogee = 0.0
    if 1300 <= period_minutes <= 1550 and 30000 <= perigee <= 45000:
        regime = "GEO"
    elif eccentricity >= 0.25 or apogee >= 50000:
        regime = "HEO"
    elif apogee < 2000:
        regime = "LEO"
    elif perigee < 35786:
        regime = "MEO"
    else:
        regime = "GEO"
    epoch_age_hours = None
    try:
        epoch = datetime.fromisoformat(str(item.get("EPOCH")).replace("Z", "+00:00"))
        if epoch.tzinfo is None:
            epoch = epoch.replace(tzinfo=timezone.utc)
        epoch_age_hours = round((datetime.now(timezone.utc) - epoch).total_seconds() / 3600, 2)
    except Exception:
        pass
    return {
        "PERIOD_MINUTES": round(period_minutes, 3),
        "SEMI_MAJOR_AXIS_KM": round(semi_major, 3),
        "PERIGEE_KM": round(perigee, 2),
        "APOGEE_KM": round(apogee, 2),
        "ORBIT_REGIME": regime,
        "EPOCH_AGE_HOURS": epoch_age_hours,
    }
