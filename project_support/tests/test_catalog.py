import asyncio
from datetime import datetime, timedelta, timezone

import httpx
import pytest


GP = {'OBJECT_NAME': 'TEST SAT', 'OBJECT_ID': '2026-001A', 'NORAD_CAT_ID': 99901,
      'MEAN_MOTION': 15.1, 'ECCENTRICITY': 0.001, 'INCLINATION': 97.4,
      'EPOCH': '2026-09-07T00:00:00'}


def make_catalog(tmp_path, handler):
    from communication.external.celestrak import CelesTrakSource
    from data.catalog.cache import CatalogCache
    from data.catalog.access import Catalog

    return Catalog(CelesTrakSource(transport=httpx.MockTransport(handler)), CatalogCache(tmp_path))


def test_fetch_cache_filter_and_profile_share_only_their_catalog(tmp_path):
    calls = []

    def handler(request):
        calls.append(str(request.url))
        if 'records.php' in request.url.path:
            assert request.url.params['CATNR'] == '99901'
            return httpx.Response(200, json=[{'NORAD_CAT_ID': 99901, 'OWNER': 'TEST'}])
        assert request.url.params['GROUP'] == 'ACTIVE'
        assert request.url.params['FORMAT'] == 'JSON'
        return httpx.Response(200, json=[GP])

    catalog = make_catalog(tmp_path, handler)

    async def scenario():
        live = await catalog.get_satellites()
        assert live['source'] == 'celestrak-live'
        assert live['items'][0]['ORBIT_REGIME'] == 'LEO'
        live['items'][0]['OBJECT_NAME'] = 'outside mutation'
        cached = await catalog.get_satellites(query='test', orbit='LEO')
        assert cached['source'] == 'celestrak-cache'
        assert cached['count'] == 1
        assert cached['items'][0]['OBJECT_NAME'] == 'TEST SAT'
        assert (await catalog.get_satellites(query='missing'))['count'] == 0
        profile = await catalog.get_satellite_profile(99901)
        assert profile['catalog']['OWNER'] == 'TEST'
        assert profile['gp']['OBJECT_NAME'] == 'TEST SAT'
        await catalog.get_satellite_profile(99901)

    asyncio.run(scenario())
    assert len(calls) == 2
    assert (tmp_path / 'active.json.gz').is_file()


def unavailable(request):
    return httpx.Response(503, text='unavailable')


def test_stale_disk_snapshot_is_preferred_over_demo(tmp_path):
    from data.catalog.cache import CatalogCache

    cache = CatalogCache(tmp_path)
    cache.save('stations', (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat(), [GP])
    result = asyncio.run(make_catalog(tmp_path, unavailable).get_satellites(group='stations'))
    assert result['source'] == 'celestrak-stale'
    assert result['items'][0]['NORAD_CAT_ID'] == 99901


@pytest.mark.parametrize('group,source,count', [('active', 'upstream-unavailable', 0),
                                               ('stations', 'demo-fallback', 5)])
def test_unavailable_catalog_preserves_group_fallback_policy(tmp_path, group, source, count):
    result = asyncio.run(make_catalog(tmp_path, unavailable).get_satellites(group=group))
    assert result['source'] == source
    assert result['count'] == count


def test_cache_roundtrip_and_corrupt_file_fallback(tmp_path):
    from data.catalog.cache import CatalogCache

    cache = CatalogCache(tmp_path)
    cache.save('stations', datetime.now(timezone.utc).isoformat(), [GP])
    assert cache.load('stations')['items'] == [GP]
    (tmp_path / 'stations.json.gz').write_bytes(b'corrupt')
    assert cache.load('stations') is None


def test_catalog_group_cannot_escape_cache_directory(tmp_path):
    catalog = make_catalog(tmp_path, unavailable)
    with pytest.raises(ValueError):
        asyncio.run(catalog.get_satellites(group='../escape'))


@pytest.mark.parametrize('payload', [{'fetched_at': 123, 'items': []},
                                     {'fetched_at': None, 'items': []}])
def test_invalid_cache_metadata_is_a_cache_miss(tmp_path, payload):
    import gzip
    import json
    from data.catalog.cache import CatalogCache

    with gzip.open(tmp_path / 'stations.json.gz', 'wt', encoding='utf-8') as stream:
        json.dump(payload, stream)
    assert CatalogCache(tmp_path).load('stations') is None
