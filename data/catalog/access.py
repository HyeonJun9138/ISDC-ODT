"""Per-application catalog access, freshness, filtering and fallback policy."""
from __future__ import annotations

import asyncio
import time
from copy import deepcopy
from datetime import datetime, timezone

from digital_twin.model_library.satellites import DEMO_SATELLITES
from .cache import CatalogCache
from .contracts import CatalogSource
from .records import _normalize, _filtered_items, _catalog_page, _catalog_truncated, _satcat_fallback_from_gp
from .settings import CELESTRAK_ALLOWED_GROUPS, CELESTRAK_GROUP_LABELS, CELESTRAK_CACHE_SECONDS, CELESTRAK_PROFILE_CACHE_SECONDS


class Catalog:
    def __init__(self, source: CatalogSource, cache: CatalogCache):
        self.source = source
        self.disk = cache
        self._cache: dict[str, dict] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._profile_cache: dict[int, dict] = {}
        self._profile_locks: dict[int, asyncio.Lock] = {}

    def catalog_groups(self) -> list[dict]:
        return [{'id': key, 'upstream': upstream,
                 'label': CELESTRAK_GROUP_LABELS.get(key, key),
                 'cached_total': len(self._cache.get(key, {}).get('items', [])) or None,
                 'cached_at': self._cache.get(key, {}).get('fetched_at')}
                for key, upstream in CELESTRAK_ALLOWED_GROUPS.items()]

    def _result(self, source, group, items, fetched_at, limit, offset, query, orbit, **extra):
        filtered = _filtered_items(items, query, orbit)
        page = _catalog_page(filtered, offset, limit)
        return {'source': source, 'group': group, 'label': CELESTRAK_GROUP_LABELS.get(group, group),
                'items': deepcopy(page), 'count': len(page), 'total': len(items),
                'filtered_total': len(filtered), 'offset': offset, 'limit': limit,
                'truncated': _catalog_truncated(len(filtered), offset, len(page), limit),
                'fetched_at': fetched_at, **extra}

    async def get_satellites(self, group='active', limit=0, offset=0, query='', orbit='all') -> dict:
        key = group.lower()
        self.disk.path(key)  # Validate before it can become a disk path or lock key.
        upstream = CELESTRAK_ALLOWED_GROUPS.get(key, CELESTRAK_ALLOWED_GROUPS['stations'])
        limit, offset = max(0, min(limit, 50_000)), max(0, offset)
        async with self._locks.setdefault(key, asyncio.Lock()):
            cached = self._cache.get(key)
            if not cached:
                cached = await asyncio.to_thread(self.disk.load, key)
                if cached:
                    self._cache[key] = cached
            if cached and time.monotonic() - cached['loaded_at'] < CELESTRAK_CACHE_SECONDS:
                return self._result('celestrak-cache', key, cached['items'], cached['fetched_at'], limit, offset, query, orbit)
            try:
                items = [_normalize(item) for item in await self.source.fetch_gp(upstream)]
                fetched_at = datetime.now(timezone.utc).isoformat(timespec='seconds')
                self._cache[key] = {'loaded_at': time.monotonic(), 'fetched_at': fetched_at, 'items': items}
                await asyncio.to_thread(self.disk.save, key, fetched_at, items)
                return self._result('celestrak-live', key, items, fetched_at, limit, offset, query, orbit)
            except Exception as exc:
                if cached and cached.get('items'):
                    return self._result('celestrak-stale', key, cached['items'], cached['fetched_at'],
                                        limit, offset, query, orbit, stale=True, warning=str(exc))
                if key in {'active', 'starlink', 'oneweb'}:
                    return self._result('upstream-unavailable', key, [], None, limit, offset, query, orbit,
                                        stale=True, warning=f'CelesTrak 정책 또는 상류 오류로 초기 스냅샷을 사용할 수 없습니다: {exc}')
                items = [_normalize(item) for item in deepcopy(DEMO_SATELLITES)]
                return self._result('demo-fallback', key, items, datetime.now(timezone.utc).isoformat(timespec='seconds'),
                                    limit, offset, query, orbit, truncated=False, warning=str(exc))

    def _find_cached_gp(self, catalog_number: int) -> dict | None:
        for catalog in self._cache.values():
            for item in catalog.get('items', []):
                if int(item.get('NORAD_CAT_ID') or 0) == catalog_number:
                    return deepcopy(item)
        return None

    async def get_satellite_profile(self, catalog_number: int) -> dict:
        catalog_number = int(catalog_number)
        async with self._profile_locks.setdefault(catalog_number, asyncio.Lock()):
            cached = self._profile_cache.get(catalog_number)
            if cached and time.monotonic() - cached['loaded_at'] < CELESTRAK_PROFILE_CACHE_SECONDS:
                return deepcopy(cached['payload'])
            gp_item = self._find_cached_gp(catalog_number)
            try:
                record = await self.source.fetch_satcat(catalog_number)
                payload = {'source': 'celestrak-satcat',
                           'fetched_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                           'catalog': record, 'gp': gp_item}
                self._profile_cache[catalog_number] = {'loaded_at': time.monotonic(), 'payload': payload}
                return deepcopy(payload)
            except Exception as exc:
                if not gp_item:
                    raise ValueError(f'NORAD {catalog_number} 상세정보를 불러올 수 없습니다: {exc}') from exc
                return {'source': 'gp-cache', 'fetched_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                        'catalog': _satcat_fallback_from_gp(gp_item), 'gp': gp_item,
                        'warning': f'SATCAT 메타데이터를 사용할 수 없어 현재 GP 정보만 표시합니다: {exc}'}
