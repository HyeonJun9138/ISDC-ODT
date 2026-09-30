import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { nodeStateAt } from '../../../digital_twin/simulation/browser/satellite_dynamics.js';

const root = new URL('../../../', import.meta.url);
const fileUrl = path => new URL(path, root).href;
const dynamicsUrl = fileUrl('digital_twin/simulation/browser/satellite_dynamics.js');
const orbitUrl = fileUrl('digital_twin/simulation/browser/orbit.js');
const oislUrl = fileUrl('digital_twin/simulation/browser/oisl.js');
const stationsUrl = fileUrl('digital_twin/model_library/browser/ground_stations.js');
const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const libraryUrl = dataUrl((await readFile(new URL('digital_twin/model_library/browser/satellite_nodes.js', root), 'utf8')).replace(/\/static\/simulation\/satellite_dynamics\.js(?:\?[^'"]*)?/, dynamicsUrl));
const library = await import(libraryUrl);
const typesUrl = dataUrl((await readFile(new URL('digital_twin/model_library/browser/mission_types.js', root), 'utf8')).replace('/static/model_library/satellite_nodes.js', libraryUrl));
const groundLinksUrl = dataUrl((await readFile(new URL('digital_twin/simulation/browser/ground_links.js', root), 'utf8')).replace('/static/simulation/orbit.js', orbitUrl).replace('/static/model_library/ground_stations.js', stationsUrl).replace('/static/model_library/satellite_nodes.js', libraryUrl));
const windows = await import(dataUrl((await readFile(new URL('digital_twin/simulation/browser/mission_windows.js', root), 'utf8'))
  .replace('/static/simulation/orbit.js', orbitUrl).replace('/static/simulation/satellite_dynamics.js', dynamicsUrl).replace('/static/simulation/oisl.js', oislUrl)
  .replace('/static/simulation/ground_links.js', groundLinksUrl).replace('/static/model_library/mission_types.js', typesUrl)));
const stations = await import(stationsUrl);

const T0 = Date.UTC(2026, 8, 8, 0, 0, 0);
const node = (name, bus = 'comms_small', orbit = {}) => library.createNode({ name, bus, orbit: { altitude_km: 550, inclination: 97.6, raan: 120, mean_anomaly: 0, epoch: T0, ...orbit } }, { epoch: T0, id: `NODE-${name}`, catalogNumber: 900001 });

test('the off-nadir cone becomes an elevation mask and the horizon is clamped', () => {
  const mask = windows.elevationForOffNadir(550, 30);
  assert.ok(mask > 55 && mask < 60, `30° off-nadir at 550 km ≈ 57° elevation, got ${mask}`);
  assert.ok(windows.elevationForOffNadir(550, 45) < mask);
  assert.equal(windows.elevationForOffNadir(550, 70), 0, 'a cone past the horizon needs no mask');
  assert.deepEqual(windows.planHorizon(T0, T0 + 6 * 3600_000), { start: T0, end: T0 + 7 * 3600_000, hours: 7 });
  assert.equal(windows.planHorizon(T0, T0 + 40 * 3600_000).hours, 24);
  assert.equal(windows.planHorizon(T0, T0).hours, 2);
});

test('interval scanning finds and refines the true intervals', () => {
  const inside = ms => (ms >= T0 + 1000_000 && ms < T0 + 2000_000) || ms >= T0 + 3500_000;
  const found = windows.scanIntervals(inside, T0, T0 + 4000_000, 30_000, { refineMs: 1000 });
  assert.equal(found.length, 2);
  assert.ok(Math.abs(found[0].start - (T0 + 1000_000)) <= 1000 && Math.abs(found[0].end - (T0 + 2000_000)) <= 1000);
  assert.equal(found[1].truncated, true);
  assert.deepEqual(windows.scanIntervals(() => false, T0, T0 + 60_000, 10_000), []);
  assert.deepEqual(windows.scanIntervals(() => true, T0, T0 + 60_000, 10_000), [{ start: T0, end: T0 + 60_000, truncated: true }]);
});

test('contact, access and eclipse windows come from the twin geometry with the ICD fields', () => {
  const sat = node('A', 'eo_smallsat');
  const daejeon = stations.createStation({ preset: 'daejeon' }, { id: 'GS-DAEJEON' });
  const contacts = windows.contactWindows(sat, daejeon, T0, 24);
  assert.ok(contacts.length >= 2, `a sun-synchronous satellite passes Daejeon several times a day, got ${contacts.length}`);
  const first = contacts[0];
  assert.equal(first.satellite, 'NODE-A');
  assert.equal(first.station, 'GS-DAEJEON');
  assert.equal(first.band, 'X', 'the EO bus carries an X-band downlink');
  assert.equal(first.rate_mbps, 800);
  assert.equal(first.uplink_mbps, 20);
  assert.ok(Date.parse(first.end) > Date.parse(first.start) && first.max_elevation >= daejeon.min_elevation_deg);
  assert.deepEqual(windows.contactWindows(sat, stations.createStation({ preset: 'jeju', bands: ['Ka'] }, { id: 'GS-KA' }), T0, 24), [], 'no shared band, no windows');
  const access = windows.targetAccessWindows(sat, { latitude: daejeon.latitude, longitude: daejeon.longitude }, T0, 24, 45);
  assert.ok(access.length >= 1 && access.length <= contacts.length, 'imaging access needs a steeper pass than a contact');
  assert.ok(access.every(window => window.max_elevation >= window.min_elevation));
  const eclipses = windows.eclipseIntervals(sat, T0, 3);
  assert.ok(eclipses.length >= 1 && eclipses.length <= 3);
  const span = eclipses.map(item => (Date.parse(item.end) - Date.parse(item.start)) / 60_000);
  assert.ok(span.every(minutes => minutes > 5 && minutes < 45), `eclipses last 20–35 min at 550 km, got ${span}`);
});

test('crosslink windows need range and a clear line of sight, and committed tasks become busy intervals', () => {
  const sat = node('A');
  // The "external" satellite flies the same orbit 20° behind: always in range, never occluded.
  const trailing = node('B', 'comms_small', { mean_anomaly: -20 });
  const externalAt = date => nodeStateAt(trailing.orbit, date)?.geodetic || null;
  const near = windows.crosslinkWindows(sat, externalAt, T0, 2, 5000, { externalId: '99999' });
  assert.equal(near.length, 1);
  assert.equal(near[0].external, '99999');
  assert.ok(near[0].min_range_km > 2000 && near[0].min_range_km < 2500);
  assert.deepEqual(windows.crosslinkWindows(sat, externalAt, T0, 2, 1000), [], 'out of range');
  const opposite = node('C', 'comms_small', { mean_anomaly: 180 });
  assert.deepEqual(windows.crosslinkWindows(sat, date => nodeStateAt(opposite.orbit, date)?.geodetic || null, T0, 2, 20000), [], 'Earth blocks the line of sight');
  const busy = windows.busyIntervals([
    { id: 'M1', status: 'committed', plan: { tasks: [{ id: 't1', satellite: 'S1', start: '2026-09-08T01:00:00Z', end: '2026-09-08T01:10:00Z' }, { id: 't2', satellite: 'S2', start: '2026-09-08T00:30:00Z', end: '2026-09-08T00:40:00Z' }] } },
    { id: 'M2', status: 'planned', plan: { tasks: [{ id: 't3', satellite: 'S1', start: '2026-09-08T02:00:00Z', end: '2026-09-08T02:10:00Z' }] } },
    { id: 'M3', status: 'committed', plan: { tasks: [{ id: 't4', satellite: 'S1', start: '2026-09-08T00:00:00Z', end: '2026-09-08T00:05:00Z' }] } },
  ], { except: 'M3' });
  assert.deepEqual(Object.keys(busy).sort(), ['S1', 'S2']);
  assert.deepEqual(busy.S1.map(item => item.task_id), ['t1'], 'planned missions and the excepted mission do not block');
});
