"""Catalog group and freshness policy; deployment paths are injected."""

CELESTRAK_CACHE_SECONDS = 2 * 60 * 60

CELESTRAK_PROFILE_CACHE_SECONDS = 24 * 60 * 60

CELESTRAK_ALLOWED_GROUPS = {
    "stations": "STATIONS",
    "active": "ACTIVE",
    "last30": "LAST-30-DAYS",
    "visual": "VISUAL",
    "weather": "WEATHER",
    "resource": "RESOURCE",
    "geo": "GEO",
    "starlink": "STARLINK",
    "oneweb": "ONEWEB",
    "cubesat": "CUBESAT",
    "science": "SCIENCE",
    "gps": "GPS-OPS",
    "glonass": "GLO-OPS",
    "galileo": "GALILEO",
    "beidou": "BEIDOU",
    "gnss": "GNSS",
}

CELESTRAK_GROUP_LABELS = {
    "stations": "우주정거장/유인 우주체",
    "active": "전체 활성 위성",
    "last30": "최근 30일 발사",
    "visual": "육안 관측 주요 위성",
    "weather": "기상 위성",
    "resource": "지구 관측 위성",
    "geo": "정지궤도 위성",
    "starlink": "Starlink",
    "oneweb": "OneWeb",
    "cubesat": "CubeSat",
    "science": "과학 위성",
    "gps": "GPS 운용 위성",
    "glonass": "GLONASS 운용 위성",
    "galileo": "Galileo",
    "beidou": "BeiDou",
    "gnss": "전체 GNSS",
}
