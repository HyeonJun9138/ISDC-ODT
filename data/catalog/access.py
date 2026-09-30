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
from .request_guard import RequestGuard, UpstreamHeldOff
from .settings import CELESTRAK_ALLOWED_GROUPS, CELESTRAK_GROUP_LABELS, CELESTRAK_CACHE_SECONDS, CELESTRAK_PROFILE_CACHE_SECONDS


class Catalog:
    def __init__(self, source: CatalogSource, cache: CatalogCache, guard: RequestGuard | None = None):
        self.source = source
        self.disk = cache
        # The per-process locks below order this instance's own work. They say
        # nothing about the other processes sharing this address, which is what
        # blocked us: the schedule on disk is what covers those.
        self.guard = guard if guard is not None else RequestGuard(cache.directory / 'request_guard.json')
        self._cache: dict[str, dict] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._profile_cache: dict[int, dict] = {}
        self._profile_locks: dict[int, asyncio.Lock] = {}

    async def _take_slot(self, request_key: str, interval: float) -> None:
        """Raise unless this request may go out now."""
        stopped = await asyncio.to_thread(self.guard.stopped)
        if stopped:
            raise UpstreamHeldOff(f'CelesTrak {stopped} 응답으로 자동 수집이 중지되어 있습니다. '
                                  '원인을 확인한 뒤 재개해야 합니다.')
        if not await asyncio.to_thread(self.guard.claim, request_key, interval):
            wait = await asyncio.to_thread(self.guard.seconds_until_allowed, request_key)
            raise UpstreamHeldOff(f'같은 주소에서 최근에 같은 요청이 나갔습니다. '
                                  f'약 {max(1, round(wait / 60))}분 뒤에 다시 시도합니다.')

    async def _note_outcome(self, request_key: str, interval: float, error: Exception | None) -> None:
        """Record what the provider did, so the next attempt is scheduled from
        it rather than from a timer that forgets on restart."""
        if error is None:
            await asyncio.to_thread(self.guard.record_success, request_key, interval)
            return
        code = getattr(getattr(error, 'response', None), 'status_code', None)
        await asyncio.to_thread(self.guard.record_failure, request_key, interval, code)

    def _without_upstream(self, key, cached, reason, limit, offset, query, orbit):
        """The answer when the provider was not asked, or did not answer. The
        order is unchanged: a snapshot we hold, then the group's own policy."""
        if cached and cached.get('items'):
            return self._result('celestrak-stale', key, cached['items'], cached['fetched_at'],
                                limit, offset, query, orbit, stale=True, warning=reason)
        if key in {'active', 'starlink', 'oneweb'}:
            return self._result('upstream-unavailable', key, [], None, limit, offset, query, orbit,
                                stale=True, warning=f'CelesTrak 정책 또는 상류 오류로 초기 스냅샷을 사용할 수 없습니다: {reason}')
        items = [_normalize(item) for item in deepcopy(DEMO_SATELLITES)]
        return self._result('demo-fallback', key, items, datetime.now(timezone.utc).isoformat(timespec='seconds'),
                            limit, offset, query, orbit, truncated=False, warning=reason)

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
            # Keyed by the upstream group, not by the name asked for: two
            # unregistered names both resolve to STATIONS, and downloading it
            # twice for them was one of the ways requests multiplied.
            request_key = f'gp:{upstream}'
            try:
                await self._take_slot(request_key, CELESTRAK_CACHE_SECONDS)
                known = await asyncio.to_thread(self.guard.validator, request_key)
                payload = await self.source.fetch_gp(upstream, known)
                if payload is None:
                    # The provider answered that our snapshot is current. That is
                    # a success, and it costs a few hundred bytes rather than the
                    # whole catalog.
                    await self._note_outcome(request_key, CELESTRAK_CACHE_SECONDS, None)
                    if not (cached and cached.get('items')):
                        raise ValueError('변경 없음 응답을 받았으나 보관된 스냅샷이 없습니다.')
                    cached = {**cached, 'loaded_at': time.monotonic()}
                    self._cache[key] = cached
                    return self._result('celestrak-cache', key, cached['items'], cached['fetched_at'],
                                        limit, offset, query, orbit)
                items = [_normalize(item) for item in payload]
                fetched_at = datetime.now(timezone.utc).isoformat(timespec='seconds')
                self._cache[key] = {'loaded_at': time.monotonic(), 'fetched_at': fetched_at, 'items': items}
                await asyncio.to_thread(self.disk.save, key, fetched_at, items)
                await self._note_outcome(request_key, CELESTRAK_CACHE_SECONDS, None)
                await asyncio.to_thread(self.guard.record_validator, request_key,
                                        getattr(self.source, 'last_modified', ''))
                return self._result('celestrak-live', key, items, fetched_at, limit, offset, query, orbit)
            except UpstreamHeldOff as exc:
                # Not a provider failure: nothing was asked, so nothing is counted.
                return self._without_upstream(key, cached, str(exc), limit, offset, query, orbit)
            except Exception as exc:
                await self._note_outcome(request_key, CELESTRAK_CACHE_SECONDS, exc)
                return self._without_upstream(key, cached, str(exc), limit, offset, query, orbit)

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
            request_key = f'satcat:{catalog_number}'
            try:
                await self._take_slot(request_key, CELESTRAK_PROFILE_CACHE_SECONDS)
                record = await self.source.fetch_satcat(catalog_number)
                payload = {'source': 'celestrak-satcat',
                           'fetched_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                           'catalog': record, 'gp': gp_item}
                self._profile_cache[catalog_number] = {'loaded_at': time.monotonic(), 'payload': payload}
                await self._note_outcome(request_key, CELESTRAK_PROFILE_CACHE_SECONDS, None)
                return deepcopy(payload)
            except UpstreamHeldOff as exc:
                if not gp_item:
                    raise ValueError(f'NORAD {catalog_number} 상세정보를 불러올 수 없습니다: {exc}') from exc
                return {'source': 'gp-cache', 'fetched_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                        'catalog': _satcat_fallback_from_gp(gp_item), 'gp': gp_item,
                        'warning': f'SATCAT 메타데이터를 요청하지 않았습니다: {exc}'}
            except Exception as exc:
                await self._note_outcome(request_key, CELESTRAK_PROFILE_CACHE_SECONDS, exc)
                if not gp_item:
                    raise ValueError(f'NORAD {catalog_number} 상세정보를 불러올 수 없습니다: {exc}') from exc
                return {'source': 'gp-cache', 'fetched_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                        'catalog': _satcat_fallback_from_gp(gp_item), 'gp': gp_item,
                        'warning': f'SATCAT 메타데이터를 사용할 수 없어 현재 GP 정보만 표시합니다: {exc}'}
