import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The sites module imports the communication console's presets by absolute /static path; load both
// from disk with that import rewritten so the same data is used as in the browser.
const presetsUrl = new URL('../../../digital_twin/model_library/browser/ground_stations.js', import.meta.url).href;
const source = await readFile(new URL('../../../digital_twin/model_library/browser/ground_station_sites.js', import.meta.url), 'utf8');
const { GROUND_STATIONS, SITE_GROUPS, stationGroups, stationsIn } = await import(`data:text/javascript;base64,${Buffer.from(source.replace('/static/model_library/ground_stations.js', presetsUrl)).toString('base64')}`);
const { STATION_PRESETS, validateStation } = await import(presetsUrl);

test('every communication-console preset is a site under its upper-case key with the same coordinates', () => {
  for (const [key, preset] of Object.entries(STATION_PRESETS)) {
    const site = GROUND_STATIONS[key.toUpperCase()];
    assert.ok(site, `preset ${key} is exposed`);
    assert.equal(site.latitude, preset.latitude);
    assert.equal(site.longitude, preset.longitude);
    assert.equal(site.presetKey, key);
  }
});

test('Korea has Seoul, Daejeon, Jeju and Kumsan and the world list spans every group', () => {
  assert.deepEqual(stationsIn('korea').map(site => site.key).sort(), ['DAEJEON', 'JEJU', 'KUMSAN', 'SEOUL']);
  for (const group of SITE_GROUPS) assert.ok(stationsIn(group.key).length >= 2, `${group.key} has representative sites`);
  assert.ok(Object.keys(GROUND_STATIONS).length >= 28);
  for (const key of ['GOLDSTONE', 'MADRID', 'CANBERRA', 'KIRUNA', 'KOUROU', 'USUDA', 'BYALALU', 'SVALBARD', 'TROLL', 'MCMURDO']) assert.ok(GROUND_STATIONS[key], key);
});

test('every site has valid geometry and the descriptive fields the card shows', () => {
  for (const site of Object.values(GROUND_STATIONS)) {
    assert.match(site.key, /^[A-Z0-9_]+$/);
    assert.deepEqual(validateStation({ name: site.name, latitude: site.latitude, longitude: site.longitude, altitude_km: site.altitudeKm, dish_m: site.dishMeters ?? 1, min_elevation_deg: site.minElevationDeg, bands: ['S'] }), [], site.key);
    assert.ok(site.name && site.region && site.role, `${site.key} carries name, region and role`);
    assert.ok(site.bands.length >= 1, `${site.key} lists at least one band`);
    assert.ok(SITE_GROUPS.some(group => group.key === site.group), `${site.key} belongs to a known group`);
  }
});

test('selector groups follow the declared order and sort sites by Korean name inside a group', () => {
  const groups = stationGroups();
  assert.deepEqual(groups.map(group => group.key), SITE_GROUPS.map(group => group.key));
  assert.equal(groups[0].label, '대한민국');
  const korea = groups[0].sites.map(site => site.name);
  assert.deepEqual(korea, [...korea].sort((a, b) => a.localeCompare(b, 'ko')));
  assert.equal(groups.reduce((sum, group) => sum + group.sites.length, 0), Object.keys(GROUND_STATIONS).length, 'every site is in exactly one group');
});
