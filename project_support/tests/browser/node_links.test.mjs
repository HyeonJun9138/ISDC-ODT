import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { nodeStateAt } from '../../../digital_twin/simulation/browser/satellite_dynamics.js';

// Served /static paths are rewritten to files so the link resolver loads in Node.
const root = new URL('../../../', import.meta.url);
const dynamicsUrl = new URL('digital_twin/simulation/browser/satellite_dynamics.js', root).href;
const oislUrl = new URL('digital_twin/simulation/browser/oisl.js', root).href;
const librarySource = (await readFile(new URL('digital_twin/model_library/browser/satellite_nodes.js', root), 'utf8'))
  .replace(/\/static\/simulation\/satellite_dynamics\.js(?:\?[^'"]*)?/, dynamicsUrl);
const libraryUrl = `data:text/javascript;base64,${Buffer.from(librarySource).toString('base64')}`;
const library = await import(libraryUrl);
const linksSource = (await readFile(new URL('user_application/web/scripts/nodes/links.js', root), 'utf8'))
  .replace(/\/static\/model_library\/satellite_nodes\.js(?:\?[^'"]*)?/, libraryUrl)
  .replace(/\/static\/simulation\/oisl\.js(?:\?[^'"]*)?/, oislUrl);
const { resolveLinks, linkSummary, pairKey, terminalKey } = await import(`data:text/javascript;base64,${Buffer.from(linksSource).toString('base64')}`);

const T0 = Date.UTC(2026, 8, 7, 0, 0, 0);
let counter = 0;
function node(name, meanAnomaly, extra = {}) {
  counter += 1;
  return library.createNode({ name, bus: 'comms_small', orbit: { altitude_km: 550, inclination: 53, raan: extra.raan || 0, mean_anomaly: meanAnomaly, epoch: T0 }, ...extra }, { epoch: T0, id: `NODE-${counter}`, catalogNumber: 900000 + counter, linkPolicy: extra.linkPolicy || 'grid' });
}
const statesAt = (nodes, date) => new Map(nodes.map(item => [item.id, nodeStateAt(item.orbit, date)]));

test('same-plane neighbours pair fore with aft, slew first and lock after the acquisition dwell', () => {
  const a = node('A', 0);
  const b = node('B', 20);
  const nodes = [a, b];
  const first = resolveLinks(nodes, statesAt(nodes, T0), new Map(), T0);
  const aFore = first.terminals.find(terminal => terminal.nodeId === a.id && terminal.role === 'fore');
  const bAft = first.terminals.find(terminal => terminal.nodeId === b.id && terminal.role === 'aft');
  assert.equal(aFore.targetId, b.id);
  assert.equal(bAft.targetId, a.id);
  assert.equal(aFore.state.phase, 'slewing');
  assert.equal(first.terminals.filter(terminal => terminal.targetId).length, 2, 'left, right and the reverse roles find nothing in their sector');
  assert.equal(first.pairs.length, 1);
  assert.equal(first.pairs[0].key, pairKey(a.id, b.id));
  assert.equal(first.pairs[0].state, 'slewing');
  assert.ok(first.pairs[0].range_km > 2000 && first.pairs[0].range_km < 2500);
  assert.ok(first.histories.has(terminalKey(a.id, aFore.equipmentId)));
  const later = resolveLinks(nodes, statesAt(nodes, T0 + 90_000), first.histories, T0 + 90_000);
  assert.equal(later.pairs[0].state, 'locked');
  const forward = later.terminals.find(terminal => terminal.nodeId === a.id && terminal.targetId === b.id);
  assert.equal(forward.dataRateMbps, 10000);
  assert.ok(forward.margin.margin_db > 0);
  assert.deepEqual(linkSummary(later.pairs), { locked: 1, one_way: 0, acquiring: 0, slewing: 0, blocked: 0, idle: 0, total: 1 });
});

test('explicit targets are kept even when blocked, safe mode removes terminals and stale ids drop out', () => {
  const a = node('A', 0);
  const far = node('FAR', 180);
  const foreTerminal = a.equipment.find(item => item.catalog === 'oisl_standard' && item.role === 'fore');
  foreTerminal.target = far.id;
  const nodes = [a, far];
  const result = resolveLinks(nodes, statesAt(nodes, T0), new Map(), T0);
  const explicit = result.terminals.find(terminal => terminal.equipmentId === foreTerminal.id);
  assert.equal(explicit.targetId, far.id);
  assert.equal(explicit.state.phase, 'blocked');
  assert.equal(explicit.state.blockedBy, 'earth');
  assert.equal(result.pairs[0].state, 'blocked');
  foreTerminal.target = 'NODE-GONE';
  const missing = resolveLinks(nodes, statesAt(nodes, T0), result.histories, T0);
  assert.equal(missing.terminals.find(terminal => terminal.equipmentId === foreTerminal.id).targetId, null, 'a target that no longer exists is not kept');
  foreTerminal.target = 'auto';
  const safe = node('SAFE', 40, { mode: 'safe' });
  const withSafe = resolveLinks([a, safe], statesAt([a, safe], T0), new Map(), T0);
  assert.equal(withSafe.terminals.some(terminal => terminal.nodeId === safe.id), false);
  assert.equal(withSafe.pairs.length, 1, 'A still points at the safe-mode node one way');
  assert.equal(withSafe.pairs[0].state, 'slewing');
});

test('an auto terminal keeps its previous target while feasible and a node without a state stays idle', () => {
  const a = node('A', 0);
  const near = node('NEAR', 15);
  const nearer = node('NEARER', 10);
  const nodes = [a, near];
  const first = resolveLinks(nodes, statesAt(nodes, T0), new Map(), T0);
  const fore = first.terminals.find(terminal => terminal.nodeId === a.id && terminal.role === 'fore');
  assert.equal(fore.targetId, near.id);
  const withNearer = resolveLinks([a, near, nearer], statesAt([a, near, nearer], T0 + 1000), first.histories, T0 + 1000);
  assert.equal(withNearer.terminals.find(terminal => terminal.nodeId === a.id && terminal.role === 'fore').targetId, near.id, 'no flapping to a closer newcomer');
  const states = statesAt(nodes, T0);
  states.set(a.id, null);
  const idle = resolveLinks(nodes, states, new Map(), T0);
  assert.ok(idle.terminals.filter(terminal => terminal.nodeId === a.id).every(terminal => terminal.state.phase === 'idle'));
  assert.equal(idle.pairs.length, 0);
});
