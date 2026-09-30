import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);
const dynamicsUrl = new URL('digital_twin/simulation/browser/satellite_dynamics.js', root).href;
const librarySource = (await readFile(new URL('digital_twin/model_library/browser/satellite_nodes.js', root), 'utf8')).replace(/\/static\/simulation\/satellite_dynamics\.js(?:\?[^'"]*)?/, dynamicsUrl);
const libraryUrl = `data:text/javascript;base64,${Buffer.from(librarySource).toString('base64')}`;
const library = await import(libraryUrl);
const typesSource = (await readFile(new URL('digital_twin/model_library/browser/mission_types.js', root), 'utf8')).replace('/static/model_library/satellite_nodes.js', libraryUrl);
const types = await import(`data:text/javascript;base64,${Buffer.from(typesSource).toString('base64')}`);

const T0 = Date.UTC(2026, 8, 8, 0, 0, 0);
const node = (name, bus, extra = {}) => library.createNode({ name, bus, ...extra, orbit: { altitude_km: 550, inclination: 53, raan: 0, mean_anomaly: 0, epoch: T0 } }, { epoch: T0, id: `NODE-${name}`, catalogNumber: 900001 });

test('a mission gets the kind defaults, a name and validation against the deployed sets', () => {
  const mission = types.createMission({ kind: 'observe', params: { target_name: '독도', latitude: 37.24, longitude: 131.86 } }, { id: 'MSN-0001', now: T0 });
  assert.equal(mission.name, '관측 인도 · 독도');
  assert.equal(mission.params.product_mb, 800);
  assert.equal(mission.status, 'draft');
  assert.equal(mission.deadline, new Date(T0 + 6 * 3600_000).toISOString());
  assert.deepEqual(types.validateMission(mission), []);
  assert.deepEqual(types.validateMission({ ...mission, deadline: mission.window_start }), ['인도 기한은 시작 시각보다 뒤여야 합니다.']);
  assert.ok(types.validateMission(types.createMission({ kind: 'relay' }, { id: 'X', now: T0 })).some(error => error.includes('출발')));
  const relay = types.createMission({ kind: 'relay', params: { source: 'satellite:NODE-A', destination: 'station:GS-1', volume_mb: 10 } }, { id: 'MSN-0002', now: T0 });
  assert.deepEqual(types.validateMission(relay, { satellites: [{ id: 'NODE-A' }], stations: [{ id: 'GS-1' }] }), []);
  assert.ok(types.validateMission(relay, { satellites: [], stations: [{ id: 'GS-1' }] })[0].includes('NODE-A'));
  assert.equal(types.normalizeMission({ name: 'no id' }), null);
  assert.equal(types.normalizeMission({ id: 'MSN-9', kind: 'pickup', status: 'weird' }, T0).status, 'draft');
  assert.equal(types.missionLabel(types.createMission({ kind: 'fleet_update', params: { satellites: ['a', 'b'] } }, { id: 'F', now: T0 })), '군집 소프트웨어 갱신 · 2 기');
});

test('capabilities come from the active equipment and the bus', () => {
  const eo = types.satelliteCapabilities(node('EO', 'eo_smallsat'));
  assert.equal(eo.camera, true);
  assert.equal(eo.compute_mbps, types.COMPUTE_RATE_MBPS.eo_smallsat);
  assert.equal(eo.storage_gb, 2000);
  assert.equal(eo.storage_free_mb, 2_000_000);
  assert.deepEqual(eo.rf_bands, ['X', 'S']);
  const comms = types.satelliteCapabilities(node('C', 'comms_small'), { storageFreeMb: 1234 });
  assert.equal(comms.camera, false);
  assert.equal(comms.storage_gb, types.DEFAULT_STORAGE_GB);
  assert.equal(comms.storage_free_mb, 1234);
  assert.equal(comms.oisl, true);
  const safe = types.satelliteCapabilities(node('S', 'eo_smallsat', { mode: 'safe' }));
  assert.equal(safe.camera, false, 'safe mode turns the payload off');
  assert.deepEqual(safe.rf_bands, ['S']);
});

test('execution phase and task status follow the analysis time', () => {
  const tasks = [{ id: 't1', start: new Date(T0 + 60_000).toISOString(), end: new Date(T0 + 120_000).toISOString() }, { id: 't2', start: new Date(T0 + 180_000).toISOString(), end: new Date(T0 + 240_000).toISOString() }];
  const base = types.createMission({ kind: 'compute', deadline: new Date(T0 + 3600_000).toISOString(), plan: { feasible: true, tasks }, status: 'committed' }, { id: 'M', now: T0 });
  assert.equal(types.taskStatusAt(tasks[0], T0), 'planned');
  assert.equal(types.taskStatusAt(tasks[0], T0 + 90_000), 'running');
  assert.equal(types.taskStatusAt(tasks[0], T0 + 130_000), 'done');
  assert.equal(types.missionPhase(base, T0).status, 'committed');
  assert.equal(types.missionPhase(base, T0 + 150_000).progress, 0.5);
  assert.equal(types.missionPhase(base, T0 + 300_000).status, 'completed');
  assert.equal(types.missionPhase({ ...base, status: 'planned' }, T0 + 300_000).status, 'planned');
  assert.equal(types.missionPhase({ ...base, status: 'aborted' }, T0).status, 'aborted');
  const late = { ...base, deadline: new Date(T0 + 200_000).toISOString() };
  assert.equal(types.missionPhase(late, T0 + 210_000).status, 'failed', 'past the deadline with work remaining');
  assert.equal(types.missionPhase({ ...base, plan: null, status: 'draft' }, T0).status, 'draft');
});
