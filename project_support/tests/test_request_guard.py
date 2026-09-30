"""CelesTrak is asked on a schedule that outlives the process.

The 2026-09-08 review reproduced the paths that got this address blocked: fifty
catalog lookups became fifty upstream requests once a response was not 200, a
failing GP did not stop SATCAT, two instances downloaded the same group, and a
301 was followed silently. These tests hold each of those closed.
"""
import asyncio
import json
import time
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from communication.external.celestrak import CelesTrakSource
from data.catalog.access import Catalog
from data.catalog.cache import CatalogCache
from data.catalog.request_guard import RequestGuard, UpstreamHeldOff, retry_delay_seconds
from data.catalog.settings import CELESTRAK_CACHE_SECONDS

GP = {'OBJECT_NAME': 'TEST SAT', 'OBJECT_ID': '2026-001A', 'NORAD_CAT_ID': 99901,
      'MEAN_MOTION': 15.1, 'ECCENTRICITY': 0.001, 'INCLINATION': 97.4,
      'EPOCH': '2026-09-07T00:00:00'}


class Clock:
    def __init__(self, now=1_000_000.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds
        return self.now


def make_catalog(tmp_path, handler, guard=None):
    return Catalog(CelesTrakSource(transport=httpx.MockTransport(handler)),
                   CatalogCache(tmp_path), guard=guard)


# -- the schedule itself -----------------------------------------------------

def test_a_slot_is_taken_before_the_request_and_only_once(tmp_path):
    clock = Clock()
    guard = RequestGuard(tmp_path / 'request_guard.json', clock=clock)
    assert guard.seconds_until_allowed('gp:active') == 0
    assert guard.claim('gp:active', CELESTRAK_CACHE_SECONDS) is True
    assert guard.claim('gp:active', CELESTRAK_CACHE_SECONDS) is False
    clock.advance(CELESTRAK_CACHE_SECONDS - 1)
    assert guard.claim('gp:active', CELESTRAK_CACHE_SECONDS) is False
    clock.advance(2)
    assert guard.claim('gp:active', CELESTRAK_CACHE_SECONDS) is True


def test_another_process_and_a_restart_both_see_the_claim(tmp_path):
    clock = Clock()
    path = tmp_path / 'request_guard.json'
    assert RequestGuard(path, clock=clock).claim('gp:active', CELESTRAK_CACHE_SECONDS) is True
    assert RequestGuard(path, clock=clock).claim('gp:active', CELESTRAK_CACHE_SECONDS) is False
    clock.advance(600)
    assert RequestGuard(path, clock=clock).claim('gp:active', CELESTRAK_CACHE_SECONDS) is False


@pytest.mark.parametrize('code', [301, 302, 403, 404, 410, 451])
def test_an_answer_that_will_not_change_stops_the_whole_provider(tmp_path, code):
    clock = Clock()
    guard = RequestGuard(tmp_path / 'request_guard.json', clock=clock)
    assert guard.record_failure('gp:active', CELESTRAK_CACHE_SECONDS, code) == f'HTTP {code}'
    # One answer for the provider, not for one group: the address is the client.
    assert guard.stopped() == f'HTTP {code}'
    assert guard.seconds_until_allowed('satcat:99901') == float('inf')
    clock.advance(365 * 86400)
    assert guard.claim('gp:stations', CELESTRAK_CACHE_SECONDS) is False


@pytest.mark.parametrize('code', [429, 500, 503, None])
def test_an_answer_that_might_change_is_only_a_wait(tmp_path, code):
    clock = Clock()
    guard = RequestGuard(tmp_path / 'request_guard.json', clock=clock)
    assert guard.record_failure('gp:active', CELESTRAK_CACHE_SECONDS, code) is None
    assert guard.stopped() is None
    clock.advance(CELESTRAK_CACHE_SECONDS + 1)
    assert guard.claim('gp:active', CELESTRAK_CACHE_SECONDS) is True


def test_a_stop_survives_a_restart_and_only_an_operator_clears_it(tmp_path):
    path = tmp_path / 'request_guard.json'
    RequestGuard(path, clock=Clock()).record_failure('gp:active', CELESTRAK_CACHE_SECONDS, 403)
    restarted = RequestGuard(path, clock=Clock())
    assert restarted.stopped() == 'HTTP 403'
    restarted.resume()
    assert restarted.stopped() is None
    assert restarted.claim('gp:active', CELESTRAK_CACHE_SECONDS) is True


def test_the_wait_never_shortens_and_doubles_while_it_keeps_failing():
    # Asking a failing provider more often than a working one is backwards, and
    # it is what turned a two hour poll into a request every five minutes.
    assert retry_delay_seconds(CELESTRAK_CACHE_SECONDS, 1) >= CELESTRAK_CACHE_SECONDS
    waits = [retry_delay_seconds(CELESTRAK_CACHE_SECONDS, n) for n in range(1, 4)]
    assert waits == [7200, 14400, 21600]
    assert retry_delay_seconds(CELESTRAK_CACHE_SECONDS, 50) == 21600, 'six hours at the most'
    assert retry_delay_seconds(60, 1, 429) == 600


def test_the_journal_records_what_was_actually_asked(tmp_path):
    guard = RequestGuard(tmp_path / 'request_guard.json', clock=Clock(), journal_limit=5)
    guard.claim('gp:active', 1)
    guard.record_failure('gp:active', 1, 503)
    assert [entry['outcome'] for entry in guard.journal()] == ['attempt', 'failure']
    assert guard.journal()[-1]['code'] == 503
    for _ in range(10):
        guard.record_failure('gp:active', 1, 503)
    assert len(guard.journal()) == 5, 'bounded, so the file cannot grow without end'


def test_a_damaged_schedule_does_not_stop_the_catalog(tmp_path):
    path = tmp_path / 'request_guard.json'
    path.write_text('{ not json', encoding='utf-8')
    guard = RequestGuard(path, clock=Clock())
    assert guard.stopped() is None
    assert guard.claim('gp:active', CELESTRAK_CACHE_SECONDS) is True
    assert json.loads(path.read_text(encoding='utf-8'))['requests']['gp:active']['next_allowed'] > 0


def test_a_silly_request_key_is_refused_before_it_reaches_the_file(tmp_path):
    guard = RequestGuard(tmp_path / 'request_guard.json', clock=Clock())
    for key in ('../escape', 'a/b', ''):
        with pytest.raises(ValueError):
            guard.claim(key, 60)


# -- the catalog using it ----------------------------------------------------

def test_fifty_lookups_of_a_refusing_provider_make_one_request(tmp_path):
    """The reproduction from the review: fifty screen actions were fifty
    upstream requests as soon as the answer was not 200."""
    calls = []

    def refuse(request):
        calls.append(str(request.url))
        return httpx.Response(403, text='forbidden')

    catalog = make_catalog(tmp_path, refuse)

    async def scenario():
        for _ in range(50):
            result = await catalog.get_satellites(group='stations')
            assert result['source'] in ('demo-fallback', 'celestrak-stale')

    asyncio.run(scenario())
    assert len(calls) == 1, f'asked {len(calls)} times'
    assert catalog.guard.stopped() == 'HTTP 403'
    assert '중지' in asyncio.run(catalog.get_satellites(group='stations'))['warning']


def test_a_temporary_failure_also_stops_the_repeat_without_stopping_the_provider(tmp_path):
    calls = []

    def unavailable(request):
        calls.append(1)
        return httpx.Response(503, text='unavailable')

    catalog = make_catalog(tmp_path, unavailable)

    async def scenario():
        for _ in range(20):
            await catalog.get_satellites(group='stations')

    asyncio.run(scenario())
    assert len(calls) == 1
    assert catalog.guard.stopped() is None, '503 may come good; it is a wait, not a stop'


def test_a_refused_gp_also_holds_the_satcat_requests_from_the_same_address(tmp_path):
    """The review's finding: nothing tied the two together, so a blocked GP left
    the detail lookups knocking on the same door."""
    calls = []

    def refuse(request):
        calls.append(request.url.path)
        return httpx.Response(403, text='forbidden')

    catalog = make_catalog(tmp_path, refuse)

    async def scenario():
        await catalog.get_satellites(group='stations')
        for _ in range(10):
            with pytest.raises(ValueError):
                await catalog.get_satellite_profile(99901)

    asyncio.run(scenario())
    assert calls == ['/NORAD/elements/gp.php'], 'SATCAT was never asked while the provider is stopped'


def test_two_instances_sharing_a_directory_download_once(tmp_path):
    calls = []

    def respond(request):
        calls.append(1)
        return httpx.Response(200, json=[GP])

    first = make_catalog(tmp_path, respond)
    second = make_catalog(tmp_path, respond)

    async def scenario():
        assert (await first.get_satellites(group='stations'))['source'] == 'celestrak-live'
        # A second server with its own memory, the same disk: one client.
        assert (await second.get_satellites(group='stations'))['source'] in ('celestrak-cache', 'celestrak-stale')

    asyncio.run(scenario())
    assert len(calls) == 1


def test_an_unchanged_catalogue_is_answered_without_downloading_it_again(tmp_path):
    """CelesTrak asks to be asked this way, and it turns a two hourly poll of a
    1.3 MB catalogue into a few hundred bytes."""
    seen = []

    def respond(request):
        seen.append(request.headers.get('if-modified-since'))
        if len(seen) == 1:
            return httpx.Response(200, json=[GP],
                                  headers={'Last-Modified': 'Mon, 08 Sep 2026 10:00:00 GMT'})
        assert request.headers.get('if-modified-since') == 'Mon, 08 Sep 2026 10:00:00 GMT'
        return httpx.Response(304)

    guard = RequestGuard(tmp_path / 'request_guard.json')
    catalog = make_catalog(tmp_path, respond, guard=guard)

    async def scenario():
        assert (await catalog.get_satellites(group='stations'))['source'] == 'celestrak-live'
        # Let the schedule and the in-memory freshness both expire.
        guard.resume()
        catalog._cache['stations']['loaded_at'] -= CELESTRAK_CACHE_SECONDS + 1
        again = await catalog.get_satellites(group='stations')
        assert again['source'] == 'celestrak-cache'
        assert again['items'][0]['OBJECT_NAME'] == 'TEST SAT'

    asyncio.run(scenario())
    assert seen == [None, 'Mon, 08 Sep 2026 10:00:00 GMT']
    assert guard.stopped() is None, 'not modified is a success, not a failure'


def test_a_redirect_is_reported_instead_of_being_followed(tmp_path):
    calls = []

    def moved(request):
        calls.append(request.url.host)
        return httpx.Response(301, headers={'location': 'https://elsewhere.test/gp.php'})

    catalog = make_catalog(tmp_path, moved)
    result = asyncio.run(catalog.get_satellites(group='stations'))
    assert result['source'] == 'demo-fallback'
    assert calls == ['celestrak.org'], 'the redirect target was never requested'
    assert catalog.guard.stopped() == 'HTTP 301', 'a moved address is for a person to look at'


def test_two_unregistered_group_names_do_not_download_stations_twice(tmp_path):
    # Both fall back to STATIONS upstream, so they are one request, not two.
    calls = []

    def respond(request):
        calls.append(request.url.params['GROUP'])
        return httpx.Response(200, json=[GP])

    catalog = make_catalog(tmp_path, respond)

    async def scenario():
        await catalog.get_satellites(group='not_a_group')
        await catalog.get_satellites(group='another_missing_one')

    asyncio.run(scenario())
    assert calls == ['STATIONS']


def test_a_held_off_profile_falls_back_to_what_the_gp_already_says(tmp_path):
    def respond(request):
        if 'records.php' in request.url.path:
            return httpx.Response(200, json=[{'NORAD_CAT_ID': 99901, 'OWNER': 'TEST'}])
        return httpx.Response(200, json=[GP])

    catalog = make_catalog(tmp_path, respond)

    async def scenario():
        await catalog.get_satellites(group='stations')
        first = await catalog.get_satellite_profile(99901)
        assert first['source'] == 'celestrak-satcat'
        catalog._profile_cache.clear()  # a new process would have no memory of it
        second = await catalog.get_satellite_profile(99901)
        assert second['source'] == 'gp-cache'
        assert '요청하지 않았습니다' in second['warning']
        assert second['catalog']['NORAD_CAT_ID'] == 99901

    asyncio.run(scenario())


def test_a_fresh_snapshot_still_answers_without_touching_the_schedule(tmp_path):
    # The guard must not change what a normal, healthy read does.
    cache = CatalogCache(tmp_path)
    cache.save('stations', datetime.now(timezone.utc).isoformat(), [GP])

    def unexpected(request):
        raise AssertionError('a fresh snapshot must not be re-downloaded')

    catalog = make_catalog(tmp_path, unexpected)
    result = asyncio.run(catalog.get_satellites(group='stations'))
    assert result['source'] == 'celestrak-cache'
    assert result['items'][0]['NORAD_CAT_ID'] == 99901
    assert catalog.guard.journal() == []


def test_a_stale_snapshot_is_still_preferred_when_the_provider_is_held_off(tmp_path):
    cache = CatalogCache(tmp_path)
    cache.save('stations', (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat(), [GP])
    guard = RequestGuard(tmp_path / 'request_guard.json')
    guard.claim('gp:STATIONS', CELESTRAK_CACHE_SECONDS)  # somebody else just asked

    def unexpected(request):
        raise AssertionError('the slot was taken; nothing should go out')

    result = asyncio.run(make_catalog(tmp_path, unexpected, guard=guard).get_satellites(group='stations'))
    assert result['source'] == 'celestrak-stale'
    assert result['items'][0]['NORAD_CAT_ID'] == 99901
    assert '분 뒤에 다시 시도' in result['warning']
