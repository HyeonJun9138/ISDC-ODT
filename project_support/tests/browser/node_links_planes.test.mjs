import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStatic } from './load_static.mjs';

const { resolveLinks, preferredCandidates, planeOf } = await loadStatic('user_application/web/scripts/nodes/links.js');
const library = await loadStatic('digital_twin/model_library/browser/satellite_nodes.js');
const { nodeStateAt } = await loadStatic('digital_twin/simulation/browser/satellite_dynamics.js');
const T0 = Date.UTC(2026, 8, 8, 0, 0, 0);

const statesAt = (nodes, ms) => new Map(nodes.map(node => [node.id, nodeStateAt(node.orbit, ms)]));

function primed(nodes) {
  let histories = new Map();
  for (const back of [120_000, 60_000]) histories = resolveLinks(nodes, statesAt(nodes, T0 - back), histories, T0 - back).histories;
  return resolveLinks(nodes, statesAt(nodes, T0), histories, T0);
}

test('in a dense two-plane grid the fore and aft terminals stay in their own plane and left/right cross planes', () => {
  let sequence = 0;
  const idFactory = () => { sequence += 1; return { id: `NODE-${String(sequence).padStart(4, '0')}`, catalogNumber: 900000 + sequence }; };
  const nodes = library.generateFormation({ preset: 'walker_delta', planes: 2, per_plane: 10, altitude_km: 550, inclination: 53, phasing: 1, raan_start: 0, raan_spread: 30, anomaly_start: 0, bus: 'comms_small', link_policy: 'grid', prefix: 'T' }, { epoch: T0, idFactory, formationId: 'FRM-T' });
  const byName = Object.fromEntries(nodes.map(node => [node.name, node]));
  assert.equal(planeOf(byName['T-A3']), 'FRM-T:0');
  assert.equal(planeOf(byName['T-B3']), 'FRM-T:1');
  const result = primed(nodes);
  const terminal = (name, role) => result.terminals.find(item => item.nodeId === byName[name].id && item.role === role);
  assert.equal(terminal('T-A3', 'fore').targetId, byName['T-A4'].id, 'fore links along the plane even though a B satellite is closer and almost dead ahead');
  assert.equal(terminal('T-A3', 'aft').targetId, byName['T-A2'].id);
  assert.equal(terminal('T-A4', 'aft').targetId, byName['T-A3'].id);
  // Side links come and go as the two planes converge and separate along the orbit, so they are
  // checked over an orbit: whenever a side terminal holds a target, that target is in the other plane.
  let sideSamples = 0;
  for (let minute = 0; minute < 96; minute += 8) {
    const at = T0 + minute * 60_000;
    let histories = new Map();
    for (const back of [120_000, 60_000]) histories = resolveLinks(nodes, statesAt(nodes, at - back), histories, at - back).histories;
    const sample = resolveLinks(nodes, statesAt(nodes, at), histories, at);
    const sides = sample.terminals.filter(item => item.nodeId === byName['T-A3'].id && (item.role === 'left' || item.role === 'right') && item.targetId);
    sideSamples += sides.length ? 1 : 0;
    assert.ok(sides.every(item => planeOf(nodes.find(node => node.id === item.targetId)) === 'FRM-T:1'), 'side terminals never take an in-plane satellite');
    assert.equal(sample.terminals.find(item => item.nodeId === byName['T-A3'].id && item.role === 'fore').targetId, byName['T-A4'].id, `fore stays in plane at minute ${minute}`);
  }
  assert.ok(sideSamples >= 3, `side terminals reach the neighbouring plane during the orbit (${sideSamples} of 12 samples)`);
  const ring = nodes.filter(node => node.formation.plane === 0).map(node => node.id);
  const locked = result.pairs.filter(pair => pair.state === 'locked' && ring.includes(pair.a) && ring.includes(pair.b));
  assert.equal(locked.length, 10, 'the ten in-plane neighbour pairs of plane A are locked after priming');
  // Side selections may be asymmetric (each satellite picks its closest in-sector neighbour), but
  // the in-plane ring never is: a fore terminal's target answers with its aft terminal.
  const planeKey = id => planeOf(nodes.find(node => node.id === id));
  assert.equal(result.pairs.filter(pair => pair.state === 'one_way' && planeKey(pair.a) === planeKey(pair.b)).length, 0, 'in-plane pairs are always two-way');
});

test('the preference is a filter with a fallback and does not apply outside formations or to auto terminals', () => {
  const candidates = [{ id: 'a', plane: 'F:0' }, { id: 'b', plane: 'F:1' }, { id: 'c', plane: null }];
  assert.deepEqual(preferredCandidates(candidates, 'fore', 'F:0').map(item => item.id), ['a']);
  assert.deepEqual(preferredCandidates(candidates, 'right', 'F:0').map(item => item.id), ['b']);
  assert.deepEqual(preferredCandidates(candidates, 'auto', 'F:0').map(item => item.id), ['a', 'b', 'c']);
  assert.deepEqual(preferredCandidates(candidates, 'fore', null).map(item => item.id), ['a', 'b', 'c']);
  let sequence = 0;
  const loose = library.createNode({ name: 'L', bus: 'comms_small', orbit: { altitude_km: 550, inclination: 53, raan: 0, mean_anomaly: 0, epoch: T0 } }, { epoch: T0, id: 'NODE-L', catalogNumber: 900900 });
  const idFactory = () => { sequence += 1; return { id: `NODE-${sequence}`, catalogNumber: 900000 + sequence }; };
  const train = library.generateFormation({ preset: 'train', per_plane: 2, spacing_deg: 20, anomaly_start: 20, altitude_km: 550, inclination: 53, bus: 'comms_small', link_policy: 'ring', prefix: 'R' }, { epoch: T0, idFactory, formationId: 'FRM-R' });
  const result = primed([loose, ...train]);
  const fore = result.terminals.find(item => item.nodeId === 'NODE-L' && item.role === 'fore');
  assert.equal(fore.targetId, train[0].id, 'a satellite outside any formation still links to whatever is ahead of it');
});
