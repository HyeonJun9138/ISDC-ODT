"""Offline review: count outbound attempts with MockTransport, never contact CelesTrak.

Run from the repository: python -m project_support.tools.audit_celestrak_requests
This records existing behavior rather than changing application policy.
"""
import asyncio
import json
import socket
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import httpx

from communication.external.celestrak import CelesTrakSource
from data.catalog.access import Catalog
from data.catalog.cache import CatalogCache

GP = {'OBJECT_NAME': 'AUDIT SAT', 'OBJECT_ID': '2026-001A', 'NORAD_CAT_ID': 99901,
      'MEAN_MOTION': 15.1, 'ECCENTRICITY': 0.001, 'INCLINATION': 97.4,
      'EPOCH': '2026-09-07T00:00:00'}


async def run_audit(root):
    results = {}

    async def gp_case(name, status, *, stale=False, concurrent=False):
        calls = []

        def handler(request):
            calls.append(str(request.url))
            return httpx.Response(status, json=[GP] if status == 200 else {'error': 'mock only'})

        disk = CatalogCache(root / name)
        if stale:
            disk.save('active', (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat(), [GP])
        catalog = Catalog(CelesTrakSource(transport=httpx.MockTransport(handler)), disk)
        if concurrent:
            replies = await asyncio.gather(*(catalog.get_satellites() for _ in range(50)))
        else:
            replies = [await catalog.get_satellites(query=str(i)) for i in range(50)]
        results[name] = {'local_calls': 50, 'mock_outbound_calls': len(calls),
                         'returned_sources': dict(Counter(r['source'] for r in replies))}

    await gp_case('fresh_success', 200)
    await gp_case('cold_403', 403)
    await gp_case('expired_403', 403, stale=True)
    await gp_case('expired_503', 503, stale=True)
    await gp_case('concurrent_403', 403, concurrent=True)

    calls = []
    def missing_profile(request):
        calls.append(str(request.url))
        return httpx.Response(404, json={'error': 'mock missing'})
    catalog = Catalog(CelesTrakSource(transport=httpx.MockTransport(missing_profile)), CatalogCache(root / 'profile'))
    for _ in range(50):
        try:
            await catalog.get_satellite_profile(99901)
        except ValueError:
            pass
    results['profile_404'] = {'local_calls': 50, 'mock_outbound_calls': len(calls)}

    calls = []
    def profile_ok(request):
        calls.append(str(request.url))
        return httpx.Response(200, json=[{'NORAD_CAT_ID': 99901}])
    for _ in range(2):
        catalog = Catalog(CelesTrakSource(transport=httpx.MockTransport(profile_ok)), CatalogCache(root / 'profile_restart'))
        await catalog.get_satellite_profile(99901)
    results['profile_new_instances'] = {'instances': 2, 'mock_outbound_calls': len(calls)}

    calls = []
    async def simultaneous_success(request):
        calls.append(str(request.url))
        await asyncio.sleep(0.01)  # Only coordinate two in-memory transports.
        return httpx.Response(200, json=[GP])
    catalogs = [Catalog(CelesTrakSource(transport=httpx.MockTransport(simultaneous_success)),
                        CatalogCache(root / 'shared')) for _ in range(2)]
    await asyncio.gather(*(catalog.get_satellites() for catalog in catalogs))
    results['two_instances_shared_disk'] = {'instances': 2, 'mock_outbound_calls': len(calls)}

    calls = []
    def redirect(request):
        calls.append(str(request.url))
        if request.url.path.endswith('gp.php'):
            return httpx.Response(301, headers={'Location': 'https://celestrak.org/mock-target'})
        return httpx.Response(200, json=[GP])
    catalog = Catalog(CelesTrakSource(transport=httpx.MockTransport(redirect)), CatalogCache(root / 'redirect'))
    response = await catalog.get_satellites()
    results['301_followed_automatically'] = {'local_calls': 1, 'mock_outbound_calls': len(calls), 'source': response['source']}

    calls = []
    def groups(request):
        calls.append(request.url.params['GROUP'])
        return httpx.Response(200, json=[GP])
    catalog = Catalog(CelesTrakSource(transport=httpx.MockTransport(groups)), CatalogCache(root / 'groups'))
    for group in ('active', 'starlink', 'unknown_a', 'unknown_b'):
        await catalog.get_satellites(group=group)
    results['group_requests'] = {'mock_outbound_groups': calls}
    return results


async def offline_audit(directory):
    # Windows' event loop creates a local socketpair before entering this coroutine.
    with patch.object(socket.socket, 'connect', side_effect=AssertionError('Network forbidden during audit')):
        return await run_audit(directory)


if __name__ == '__main__':
    with TemporaryDirectory(prefix='spacetwin-offline-audit-') as directory:
        print(json.dumps(asyncio.run(offline_audit(Path(directory))), ensure_ascii=False, indent=2))
