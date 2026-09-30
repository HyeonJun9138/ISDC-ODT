import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStatic } from './load_static.mjs';

const { createNetworkTwin, MIN_EXCHANGE_INTERVAL_MS } = await loadStatic('user_application/web/scripts/communication/network_twin.js');
const library = await loadStatic('digital_twin/model_library/browser/satellite_nodes.js');
const T0 = Date.UTC(2026, 8, 8, 0, 0, 0);

let counter = 0;
function node(name, anomaly) {
  counter += 1;
  return library.createNode({ name, bus: 'comms_small', orbit: { altitude_km: 550, inclination: 53, raan: 0, mean_anomaly: anomaly, epoch: T0 } }, { epoch: T0, id: `NODE-${counter}`, catalogNumber: 900000 + counter });
}

function fakeFabric() {
  const calls = [];
  let fail = false;
  return {
    calls, set fail(value) { fail = value; },
    endpoint: () => ({ base: '', placement: 'server' }),
    async update(snapshot) { calls.push(snapshot); if (fail) throw Object.assign(new Error('패브릭 응답 없음'), { unavailable: true }); return { sequence: calls.length, implementation: 'stand_in', version: '0.1', links: snapshot.links.map(link => ({ id: link.id, usable: link.state === 'locked' && !link.faulted, quality: 90 })), nodes: snapshot.nodes.map(item => ({ id: item.id, kind: item.kind })), summary: { links: snapshot.links.length } }; },
    async route(source, target, objective) { return { status: 'available', path: [source, target], objective }; },
    async status() { return { placement: 'embedded', implementation: 'stand_in', version: '0.1', reachable: true, endpoint: 'in-process' }; },
  };
}

test('one instant advances the acquisition history once and the fabric receives one message per second', async () => {
  const fabric = fakeFabric();
  let wall = 0;
  const twin = createNetworkTwin({ fabric, clock: () => wall });
  const nodes = [node('A', 0), node('B', 20)];
  const first = twin.tick(new Date(T0), { nodes, stations: [], faults: [] });
  assert.equal(first.links.pairs.length, 1);
  assert.equal(first.links.pairs[0].state, 'locked', 'the history is primed two minutes back');
  const again = twin.tick(new Date(T0), { nodes, stations: [], faults: [] });
  assert.equal(again, first, 'the same instant with the same inputs is served from the cache');
  const later = twin.tick(new Date(T0 + 1000), { nodes, stations: [], faults: [] });
  assert.notEqual(later, first);
  assert.equal(later.snapshot.links[0].faulted, false);
  await twin.exchange();
  assert.equal(fabric.calls.length, 1);
  await twin.exchange();
  assert.equal(fabric.calls.length, 1, 'a second send inside the minimum interval is skipped');
  wall += MIN_EXCHANGE_INTERVAL_MS + 1;
  await twin.exchange();
  assert.equal(fabric.calls.length, 2);
  assert.equal(twin.report.sequence, 2);
  assert.equal(twin.fabricLinks.get(later.snapshot.links[0].id).usable, true);
  assert.equal(twin.reachable(), true);
  assert.equal(twin.fabricState.sequence, 2);
  const faulted = twin.tick(new Date(T0 + 2000), { nodes, stations: [], faults: [{ id: 'F1', kind: 'link_loss', target: later.snapshot.links[0].id, active: true }] });
  assert.equal(faulted.snapshot.links[0].faulted, true, 'runtime faults fold into the message');
  wall += MIN_EXCHANGE_INTERVAL_MS + 1;
  await twin.exchange({ force: true });
  assert.equal(twin.fabricLinks.get(later.snapshot.links[0].id).usable, false);
});

test('a fabric outage clears the verdicts instead of keeping stale ones, and histories can be pruned', async () => {
  const fabric = fakeFabric();
  const twin = createNetworkTwin({ fabric, clock: () => 0 });
  const nodes = [node('A', 0), node('B', 20)];
  twin.tick(new Date(T0), { nodes, stations: [], faults: [] });
  await twin.exchange({ force: true });
  assert.equal(twin.fabricNodes.size, 2);
  fabric.fail = true;
  await twin.exchange({ force: true });
  assert.equal(twin.report, null);
  assert.equal(twin.fabricLinks.size, 0);
  assert.equal(twin.reachable(), false);
  assert.match(twin.fabricState.error, /응답 없음/);
  const events = [];
  twin.subscribe(event => events.push(event));
  await twin.pollStatus();
  assert.deepEqual(events, ['status']);
  assert.equal(twin.fabricState.implementation, 'stand_in');
  const [first, second] = nodes;
  assert.ok([...twin.histories.keys()].some(key => key.startsWith(`${first.id}/`)));
  twin.pruneHistories([second.id]);
  assert.ok(![...twin.histories.keys()].some(key => key.startsWith(`${first.id}/`)));
  assert.ok([...twin.histories.keys()].some(key => key.startsWith(`${second.id}/`)));
  twin.resetHistories();
  assert.equal(twin.histories.size, 0);
  assert.deepEqual(await twin.route(first.id, second.id, 'latency'), { status: 'available', path: [first.id, second.id], objective: 'latency' });
});
