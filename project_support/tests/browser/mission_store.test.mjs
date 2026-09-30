import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);
const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const dynamicsUrl = new URL('digital_twin/simulation/browser/satellite_dynamics.js', root).href;
const libraryUrl = dataUrl((await readFile(new URL('digital_twin/model_library/browser/satellite_nodes.js', root), 'utf8')).replace(/\/static\/simulation\/satellite_dynamics\.js(?:\?[^'"]*)?/, dynamicsUrl));
const typesUrl = dataUrl((await readFile(new URL('digital_twin/model_library/browser/mission_types.js', root), 'utf8')).replace('/static/model_library/satellite_nodes.js', libraryUrl));
const { createMissionStore, MISSIONS_KEY, MAX_MISSIONS } = await import(dataUrl((await readFile(new URL('user_application/web/scripts/missions/mission_store.js', root), 'utf8')).replace('/static/model_library/mission_types.js', typesUrl)));

const T0 = Date.UTC(2026, 8, 8, 0, 0, 0);
function memoryStorage() {
  const data = new Map();
  return { getItem: key => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, value), data };
}
const context = { satellites: [{ id: 'NODE-1' }], stations: [{ id: 'GS-1' }] };

test('missions are added with validation, planned, committed and logged; everything persists', () => {
  const storage = memoryStorage();
  let now = T0;
  const store = createMissionStore({ storage, now: () => now });
  const events = [];
  store.subscribe(event => events.push(event));
  store.load();
  assert.equal(store.missions.length, 0);
  const rejected = store.add({ kind: 'relay', params: { source: 'satellite:NODE-1', destination: 'satellite:NODE-1' } }, context);
  assert.equal(rejected.mission, null);
  assert.ok(rejected.errors.length);
  const { mission, errors } = store.add({ kind: 'observe', params: { target_name: '서울', latitude: 37.5, longitude: 127 } }, context);
  assert.deepEqual(errors, []);
  assert.equal(mission.id, 'MSN-0001');
  assert.equal(store.selectedId, mission.id);
  assert.equal(store.log.at(-1).kind, 'created');
  now += 60_000;
  const plan = { feasible: true, tasks: [{ id: 'MSN-0001-T01', satellite: 'NODE-1', start: new Date(T0 + 3600_000).toISOString(), end: new Date(T0 + 3660_000).toISOString() }], summary: { satellites: ['NODE-1'] } };
  const planned = store.setPlan(mission.id, plan);
  assert.equal(planned.status, 'planned');
  assert.equal(planned.plan.version, 1);
  assert.equal(planned.plan.source, 'orchestrator');
  assert.equal(store.setPlan(mission.id, plan).plan.version, 2, 'replanning bumps the version');
  store.setStatus(mission.id, 'committed', '실행 승인');
  assert.equal(store.find(mission.id).committed_at, new Date(now).toISOString());
  assert.equal(store.setPlan(mission.id, { ...plan, feasible: false, reasons: ['기한 초과'] }).status, 'committed', 'a replan keeps a committed mission committed');
  assert.equal(store.log.at(-1).kind, 'infeasible');
  assert.deepEqual(store.update(mission.id, { params: { latitude: 200 } }, context), ['관측 지점의 위도와 경도가 필요합니다.']);
  assert.deepEqual(store.update(mission.id, { params: { latitude: 36 } }, context), []);
  assert.equal(store.find(mission.id).plan, null, 'editing the request drops the plan');
  assert.equal(store.find(mission.id).status, 'draft');
  const copy = store.duplicate(mission.id);
  assert.equal(copy.id, 'MSN-0002');
  assert.equal(copy.name, `${mission.name} 사본`);
  const saved = JSON.parse(storage.getItem(MISSIONS_KEY));
  assert.equal(saved.missions.length, 2);
  const reloaded = createMissionStore({ storage, now: () => now });
  reloaded.load();
  assert.equal(reloaded.missions.length, 2);
  assert.equal(reloaded.selectedId, 'MSN-0002');
  assert.equal(reloaded.find('MSN-0001').params.latitude, 36);
  assert.equal(reloaded.add({ kind: 'compute' }, context).mission.id, 'MSN-0003', 'ids continue after the stored ones');
  assert.equal(store.remove('MSN-0001'), true);
  assert.equal(store.remove('MSN-0001'), false);
  assert.deepEqual(events.slice(0, 4), ['load', 'add', 'plan', 'plan']);
});

test('the mission limit is enforced', () => {
  const store = createMissionStore({ storage: memoryStorage(), now: () => T0 });
  store.load();
  for (let index = 0; index < MAX_MISSIONS; index += 1) store.add({ kind: 'compute' }, context);
  assert.throws(() => store.add({ kind: 'compute' }, context), RangeError);
});
