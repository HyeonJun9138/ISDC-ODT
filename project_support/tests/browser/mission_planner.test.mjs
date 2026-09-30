import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStatic } from './load_static.mjs';

const { createMissionPlanner, faultedPairKeys, faultedStationIds } = await loadStatic('user_application/web/scripts/missions/planner.js');
const library = await loadStatic('digital_twin/model_library/browser/satellite_nodes.js');
const stationsLibrary = await loadStatic('digital_twin/model_library/browser/ground_stations.js');
const T0 = Date.UTC(2026, 8, 8, 0, 0, 0);

let counter = 0;
function node(name, anomaly, extra = {}) {
  counter += 1;
  return library.createNode({ name, bus: 'comms_small', orbit: { altitude_km: 550, inclination: 53, raan: 0, mean_anomaly: anomaly, epoch: T0 }, ...extra }, { epoch: T0, id: `NODE-${counter}`, catalogNumber: 900000 + counter });
}

function fakeOrchestration() {
  const calls = [];
  return {
    calls,
    endpoint: () => ({ base: '', placement: 'server' }),
    async plan(request) { calls.push(['plan', request]); return { feasible: true, tasks: [], summary: { path: Object.keys(request.mesh) }, sequence: calls.length }; },
    async commit(message) { calls.push(['commit', message]); return { accepted: true, held_tasks: message.tasks.length, sequence: calls.length }; },
    async status() { return { reachable: true }; },
  };
}

test('faulted pairs and stations are matched by pair id, node id or name', () => {
  const a = node('N1', 0); const b = node('N2', 20); const c = node('N3', 40);
  const pairs = [{ key: `${a.id}|${b.id}`, a: a.id, b: b.id }, { key: `${b.id}|${c.id}`, a: b.id, b: c.id }];
  assert.deepEqual([...faultedPairKeys(pairs, [a, b, c], [{ kind: 'link_loss', target: `${a.id}|${b.id}`, active: true }])], [`${a.id}|${b.id}`]);
  assert.deepEqual([...faultedPairKeys(pairs, [a, b, c], [{ kind: 'link_loss', target: 'N2', active: true }])].sort(), [`${a.id}|${b.id}`, `${b.id}|${c.id}`].sort(), 'a node fault removes every pair it touches');
  assert.equal(faultedPairKeys(pairs, [a, b, c], [{ kind: 'link_loss', target: 'N2', active: false }]).size, 0);
  assert.equal(faultedPairKeys(pairs, [a, b, c], [{ kind: 'latency_spike', target: 'N2', active: true }]).size, 0);
  const station = stationsLibrary.createStation({ preset: 'daejeon' }, { id: 'GS-DAEJEON' });
  assert.deepEqual([...faultedStationIds([station], [{ kind: 'link_loss', target: '대전', active: true }])], ['GS-DAEJEON']);
});

test('the request carries a mesh without faulted links and the module is told about commits', async () => {
  const a = node('N1', 0); const b = node('N2', 20); const c = node('N3', 40);
  const nodes = [a, b, c];
  const station = stationsLibrary.createStation({ preset: 'daejeon' }, { id: 'GS-DAEJEON' });
  let faults = [];
  const orchestration = fakeOrchestration();
  const planner = createMissionPlanner({ satellites: () => nodes, stations: () => [station], missions: () => [], faults: () => faults, now: () => new Date(T0), orchestration });
  const clear = planner.meshState(nodes, new Date(T0));
  assert.deepEqual(clear.mesh[a.id], [b.id]);
  assert.deepEqual(clear.mesh[b.id].sort(), [a.id, c.id].sort());
  assert.equal(clear.locked, 2);
  faults = [{ id: 'F1', kind: 'link_loss', target: `${a.id}|${b.id}`, active: true }];
  const cut = planner.meshState(nodes, new Date(T0));
  assert.equal(cut.mesh[a.id], undefined, 'the faulted pair leaves the mesh');
  assert.deepEqual(cut.mesh[b.id], [c.id]);
  assert.deepEqual(cut.faulted, [`${a.id}|${b.id}`]);
  const mission = { id: 'MSN-0001', kind: 'relay', priority: 2, window_start: new Date(T0).toISOString(), deadline: new Date(T0 + 7200_000).toISOString(), params: { source: `satellite:${a.id}`, destination: `satellite:${c.id}`, volume_mb: 10 }, exclude: [] };
  const stages = [];
  const { request, answer } = await planner.plan(mission, { onStage: stage => stages.push(stage) });
  assert.deepEqual(stages, ['windows', 'request']);
  assert.deepEqual(request.horizon.faulted_links, [`${a.id}|${b.id}`]);
  assert.equal(request.horizon.locked_links, 2);
  assert.equal(request.mesh[a.id], undefined);
  assert.equal(request.satellites.length, 3);
  assert.ok(request.windows.contacts.every(window => window.station === 'GS-DAEJEON'));
  assert.equal(answer.feasible, true);
  assert.ok(planner.windows, 'the window cache is kept for the timeline');
  const committed = { ...mission, status: 'committed', plan: { version: 3, tasks: [{ id: 'T1', kind: 'crosslink', satellite: a.id, counterpart: b.id, start: new Date(T0).toISOString(), end: new Date(T0 + 60_000).toISOString() }] } };
  const ack = await planner.commit(committed, 'commit');
  assert.equal(ack.held_tasks, 1);
  const [, message] = orchestration.calls.at(-1);
  assert.equal(message.decision, 'commit');
  assert.equal(message.version, 3);
  assert.equal(message.tasks[0].counterpart, b.id);
  await planner.commit(committed, 'abort');
  assert.equal(orchestration.calls.at(-1)[1].tasks.length, 0);
});

test('affected tasks name satellites that left or changed mode and crosslinks over a faulted pair', () => {
  const a = node('N1', 0); const b = node('N2', 20); const c = node('N3', 40, { mode: 'safe' });
  let faults = [{ id: 'F1', kind: 'link_loss', target: `${a.id}|${b.id}`, active: true }];
  const planner = createMissionPlanner({ satellites: () => [a, b, c], stations: () => [], missions: () => [], faults: () => faults, now: () => new Date(T0), orchestration: fakeOrchestration() });
  const iso = offset => new Date(T0 + offset * 1000).toISOString();
  const mission = { status: 'committed', plan: { tasks: [
    { id: 'T1', kind: 'crosslink', satellite: a.id, counterpart: b.id, start: iso(0), end: iso(100) },
    { id: 'T2', kind: 'crosslink', satellite: b.id, counterpart: c.id, start: iso(-200), end: iso(-100) },
    { id: 'T3', kind: 'process', satellite: c.id, start: iso(50), end: iso(80) },
    { id: 'T4', kind: 'transfer', satellite: 'NODE-99', counterpart: 'GS-X', start: iso(120), end: iso(140) },
  ] } };
  const affected = planner.affectedTasks(mission, T0 + 10_000);
  assert.deepEqual(affected.links, [`${a.id}|${b.id}`]);
  assert.deepEqual(affected.satellites.sort(), [c.id, 'NODE-99'].sort());
  assert.deepEqual(affected.tasks, ['T1', 'T3', 'T4'], 'a finished task is not reconfigured');
  faults = [];
  assert.deepEqual(planner.affectedTasks(mission, T0 + 10_000).links, []);
  assert.deepEqual(planner.affectedTasks({ ...mission, status: 'planned' }, T0), { satellites: [], links: [], tasks: [] });
});
