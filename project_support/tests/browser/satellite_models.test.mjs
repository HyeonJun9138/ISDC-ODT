import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createModelResolver, describeMatch, loadSatelliteModels, objectKind } from '../../../user_application/web/scripts/orbit/satellite_models.js';

const model = (key, extra = {}) => ({
  key, provider: 'nasa', title: `${key} title`, label: `${key} label`, file: `${key}.glb`, thumbnail: `${key}.jpg`,
  size_m: 10, extent: 5, exact: { norad: [], names: [] }, series: { norad: [], names: [] }, family: { names: [] }, ...extra,
});
const manifest = Object.freeze({
  schema: 2,
  sources: {
    nasa: { credit: 'NASA 3D Resources', repository: 'https://github.com/nasa/NASA-3D-Resources' },
    spacetwin: { credit: 'SpaceTwin 자체 제작', repository: '' },
  },
  display: { minimum_pixel_size: 12 },
  representatives: { station: 'iss', cubesat: 'cube', 'payload:LEO': 'leo', 'payload:MEO': 'meo', 'payload:GEO': 'geo', 'payload:HEO': 'heo' },
  models: [
    model('iss', { size_m: 109, extent: 45.5, exact: { norad: [25544], names: ['^ISS \\(ZARYA\\)$'] }, orientation: { heading: 90 } }),
    model('landsat', { exact: { norad: [39084], names: [] }, series: { norad: [49260], names: ['^LANDSAT 9$'] } }),
    model('goes', { series: { norad: [], names: ['^GOES \\d+$'] } }),
    model('starlink', { provider: 'spacetwin', size_m: 29, extent: 28.9, family: { names: ['^STARLINK'] } }),
    model('cube', { size_m: 0.7, extent: 0.7 }),
    model('leo'), model('meo'), model('geo'), model('heo'),
  ],
});
const resolve = createModelResolver(manifest);

test('object kind comes from SATCAT type first and then from GP naming conventions', () => {
  assert.equal(objectKind({ OBJECT_NAME: 'FALCON 9 R/B' }), 'rocket');
  assert.equal(objectKind({ OBJECT_NAME: 'COSMOS 2251 DEB' }), 'debris');
  assert.equal(objectKind({ OBJECT_NAME: 'QUIET NAME' }, { OBJECT_TYPE: 'R/B' }), 'rocket');
  assert.equal(objectKind({ OBJECT_NAME: 'QUIET NAME' }, { OBJECT_TYPE: 'DEB' }), 'debris');
  assert.equal(objectKind({ OBJECT_NAME: 'ISS (ZARYA)' }), 'station');
  assert.equal(objectKind({ OBJECT_NAME: 'CSS (TIANHE)' }), 'station');
  assert.equal(objectKind({ OBJECT_NAME: 'FLOCK 4X 12' }), 'cubesat');
  assert.equal(objectKind({ OBJECT_NAME: 'KITSUNE 6U' }), 'cubesat');
  assert.equal(objectKind({ OBJECT_NAME: 'STARLINK-34396' }), 'payload');
  assert.equal(objectKind({}), 'payload');
});

test('exact matches win, carry asset urls, real-size scale and provider credit', () => {
  const iss = resolve({ NORAD_CAT_ID: 25544, OBJECT_NAME: 'ISS (ZARYA)', ORBIT_REGIME: 'LEO' });
  assert.equal(iss.key, 'iss');
  assert.equal(iss.quality, 'exact');
  assert.equal(iss.url, '/static/assets/models/iss.glb');
  assert.equal(iss.thumbnail, '/static/assets/models/iss.jpg');
  assert.equal(iss.minimumPixelSize, 12);
  assert.equal(iss.sizeMeters, 109);
  assert.ok(Math.abs(iss.scale - 109 / 45.5) < 1e-12, 'scale converts native units to metres');
  assert.deepEqual(iss.orientation, { heading: 90, pitch: 0, roll: 0 });
  assert.equal(iss.provider, 'nasa');
  assert.equal(iss.credit, 'NASA 3D Resources');
  assert.equal(iss.creditUrl, 'https://github.com/nasa/NASA-3D-Resources');
  assert.equal(resolve({ NORAD_CAT_ID: '39084', OBJECT_NAME: 'LANDSAT 8' }).quality, 'exact');
  assert.equal(resolve({ NORAD_CAT_ID: 1, OBJECT_NAME: 'HST' }).key, 'leo', 'unknown names fall through to the representative');
  const unmeasured = createModelResolver({ ...manifest, models: [model('leo', { extent: 0 })], representatives: { 'payload:LEO': 'leo' } });
  assert.equal(unmeasured({ NORAD_CAT_ID: 1, OBJECT_NAME: 'X' }).scale, 1, 'no extent means native units');
});

test('series and family matches use the model with distinct quality flags', () => {
  const landsat9 = resolve({ NORAD_CAT_ID: 49260, OBJECT_NAME: 'LANDSAT 9', ORBIT_REGIME: 'LEO' });
  assert.equal(landsat9.key, 'landsat');
  assert.equal(landsat9.quality, 'series');
  assert.equal(resolve({ NORAD_CAT_ID: 51850, OBJECT_NAME: 'GOES 18', ORBIT_REGIME: 'GEO' }).quality, 'series');
  const starlink = resolve({ NORAD_CAT_ID: 64436, OBJECT_NAME: 'STARLINK-34396', ORBIT_REGIME: 'LEO' });
  assert.equal(starlink.key, 'starlink');
  assert.equal(starlink.quality, 'representative');
  assert.equal(starlink.provider, 'spacetwin');
  assert.equal(starlink.credit, 'SpaceTwin 자체 제작');
  assert.equal(starlink.creditUrl, '');
  assert.ok(Math.abs(starlink.scale - 29 / 28.9) < 1e-12);
});

test('representatives follow object kind and orbit regime and never claim an exact match', () => {
  const other = resolve({ NORAD_CAT_ID: 2, OBJECT_NAME: 'YAOGAN-30 01', ORBIT_REGIME: 'LEO' });
  assert.equal(other.key, 'leo');
  assert.equal(other.quality, 'representative');
  assert.equal(resolve({ NORAD_CAT_ID: 3, OBJECT_NAME: 'NAVSTAR 81 (USA 342)', ORBIT_REGIME: 'MEO' }).key, 'meo');
  assert.equal(resolve({ NORAD_CAT_ID: 4, OBJECT_NAME: 'KOREASAT 7', ORBIT_REGIME: 'GEO' }).key, 'geo');
  assert.equal(resolve({ NORAD_CAT_ID: 5, OBJECT_NAME: 'MOLNIYA 1-91', ORBIT_REGIME: 'HEO' }).key, 'heo');
  assert.equal(resolve({ NORAD_CAT_ID: 6, OBJECT_NAME: 'UNKNOWN', ORBIT_REGIME: '' }).key, 'leo', 'missing regime uses the LEO representative');
  const tiangong = resolve({ NORAD_CAT_ID: 48274, OBJECT_NAME: 'CSS (TIANHE)', ORBIT_REGIME: 'LEO' });
  assert.equal(tiangong.key, 'iss');
  assert.equal(tiangong.quality, 'representative');
  assert.equal(tiangong.kind, 'station');
  assert.equal(resolve({ NORAD_CAT_ID: 7, OBJECT_NAME: 'FLOCK 4X 12', ORBIT_REGIME: 'LEO' }).key, 'cube');
});

test('rocket bodies and debris receive no model regardless of orbit', () => {
  assert.equal(resolve({ NORAD_CAT_ID: 7, OBJECT_NAME: 'FALCON 9 R/B', ORBIT_REGIME: 'LEO' }), null);
  assert.equal(resolve({ NORAD_CAT_ID: 8, OBJECT_NAME: 'COSMOS 2251 DEB', ORBIT_REGIME: 'LEO' }), null);
  assert.equal(resolve({ NORAD_CAT_ID: 9, OBJECT_NAME: 'OBJECT A', ORBIT_REGIME: 'GEO' }, { OBJECT_TYPE: 'R/B' }), null);
  assert.equal(createModelResolver({ models: [] })({ NORAD_CAT_ID: 25544, OBJECT_NAME: 'ISS (ZARYA)' }), null, 'an empty manifest yields no model');
});

test('a schema 1 manifest with a single source still resolves with NASA credit', () => {
  const legacy = createModelResolver({ source: { credit: 'NASA 3D Resources', repository: 'https://example.test' }, models: [model('leo')], representatives: { 'payload:LEO': 'leo' } });
  const match = legacy({ NORAD_CAT_ID: 1, OBJECT_NAME: 'ANY', ORBIT_REGIME: 'LEO' });
  assert.equal(match.credit, 'NASA 3D Resources');
  assert.equal(match.creditUrl, 'https://example.test');
});

test('match descriptions state provenance, scale basis and never call a model a photograph', () => {
  const none = describeMatch(null);
  assert.equal(none.state, '미배정');
  assert.equal(none.alt, '');
  assert.equal(none.credit, '');
  const exact = describeMatch(resolve({ NORAD_CAT_ID: 25544, OBJECT_NAME: 'ISS (ZARYA)' }));
  assert.equal(exact.state, '3D 모델 (해당 기체)');
  assert.match(exact.note, /실제 촬영 이미지나 현재 자세가 아닙니다/);
  assert.match(exact.note, /대표 치수 약 109 m 기준의 실제 축척/);
  assert.match(exact.alt, /NASA 3D Resources 렌더링/);
  assert.equal(exact.creditUrl, 'https://github.com/nasa/NASA-3D-Resources');
  const series = describeMatch(resolve({ NORAD_CAT_ID: 49260, OBJECT_NAME: 'LANDSAT 9' }));
  assert.equal(series.state, '동일 계열 모델');
  const own = describeMatch(resolve({ NORAD_CAT_ID: 64436, OBJECT_NAME: 'STARLINK-34396', ORBIT_REGIME: 'LEO' }));
  assert.equal(own.state, '자체 제작 대표 형상');
  assert.match(own.note, /제조사 형상이 아니며/);
  assert.equal(own.credit, 'SpaceTwin 자체 제작');
  assert.equal(own.creditUrl, '');
  const representative = describeMatch(resolve({ NORAD_CAT_ID: 2, OBJECT_NAME: 'YAOGAN-30 01', ORBIT_REGIME: 'LEO' }));
  assert.equal(representative.state, '대표 형상');
  assert.match(representative.note, /LEO 탑재체 대표 형상/);
  assert.match(representative.note, /실제 기체 외형이 아니며/);
});

test('manifest loading tolerates transport failures and malformed payloads', async () => {
  assert.equal(await loadSatelliteModels(async () => ({ ok: false, status: 500 })), null);
  assert.equal(await loadSatelliteModels(async () => { throw new Error('offline'); }), null);
  assert.equal(await loadSatelliteModels(async () => ({ ok: true, json: async () => ({}) })), null);
  assert.equal(await loadSatelliteModels(undefined), null);
  const loaded = await loadSatelliteModels(async url => {
    assert.equal(url, '/static/assets/models/manifest.json');
    return { ok: true, json: async () => manifest };
  });
  assert.equal(loaded, manifest);
});

test('the shipped manifest resolves representatives, constellations and famous exact entries', async () => {
  const shipped = JSON.parse(await readFile(new URL('../../../user_application/web/assets/models/manifest.json', import.meta.url), 'utf8'));
  const resolveShipped = createModelResolver(shipped);
  for (const [scope, key] of Object.entries(shipped.representatives)) {
    assert.ok(shipped.models.some(entry => entry.key === key), `${scope} representative ${key} must exist`);
  }
  const expect = (item, key, quality) => {
    const match = resolveShipped(item);
    assert.equal(match?.key, key, `${item.OBJECT_NAME} -> ${key}`);
    assert.equal(match.quality, quality, `${item.OBJECT_NAME} quality`);
    assert.ok(match.scale > 0 && match.sizeMeters > 0, `${item.OBJECT_NAME} has a real-size scale`);
  };
  expect({ NORAD_CAT_ID: 25544, OBJECT_NAME: 'ISS (ZARYA)', ORBIT_REGIME: 'LEO' }, 'iss', 'exact');
  expect({ NORAD_CAT_ID: 20580, OBJECT_NAME: 'HST', ORBIT_REGIME: 'LEO' }, 'hubble', 'exact');
  expect({ NORAD_CAT_ID: 43013, OBJECT_NAME: 'NOAA 20 (JPSS-1)', ORBIT_REGIME: 'LEO' }, 'suomi_npp', 'series');
  expect({ NORAD_CAT_ID: 51850, OBJECT_NAME: 'GOES 18', ORBIT_REGIME: 'GEO' }, 'goes_r', 'exact');
  expect({ NORAD_CAT_ID: 36411, OBJECT_NAME: 'GOES 15', ORBIT_REGIME: 'GEO' }, 'goes', 'series');
  expect({ NORAD_CAT_ID: 99999, OBJECT_NAME: 'STARLINK-34396', ORBIT_REGIME: 'LEO' }, 'starlink_flat', 'representative');
  expect({ NORAD_CAT_ID: 99998, OBJECT_NAME: 'NAVSTAR 81 (USA 342)', ORBIT_REGIME: 'MEO' }, 'gnss_bus', 'representative');
  expect({ NORAD_CAT_ID: 99997, OBJECT_NAME: 'COSMOS 2559', ORBIT_REGIME: 'MEO' }, 'gnss_bus', 'representative');
  expect({ NORAD_CAT_ID: 99996, OBJECT_NAME: 'ONEWEB-0651', ORBIT_REGIME: 'LEO' }, 'oneweb', 'representative');
  expect({ NORAD_CAT_ID: 99995, OBJECT_NAME: 'FLOCK 4X 12', ORBIT_REGIME: 'LEO' }, 'cubesat_3u', 'representative');
  expect({ NORAD_CAT_ID: 99994, OBJECT_NAME: 'KOREASAT 7', ORBIT_REGIME: 'GEO' }, 'ssl_1300', 'representative');
  expect({ NORAD_CAT_ID: 40482, OBJECT_NAME: 'MMS 1', ORBIT_REGIME: 'HEO' }, 'mms', 'exact');
  assert.equal(resolveShipped({ NORAD_CAT_ID: 99993, OBJECT_NAME: 'CZ-3B R/B', ORBIT_REGIME: 'GEO' }), null);
  const claimed = new Map();
  for (const entry of shipped.models) {
    for (const norad of [...entry.exact.norad, ...entry.series.norad]) {
      assert.ok(!claimed.has(norad), `NORAD ${norad} claimed by ${claimed.get(norad)} and ${entry.key}`);
      claimed.set(norad, entry.key);
    }
  }
});
