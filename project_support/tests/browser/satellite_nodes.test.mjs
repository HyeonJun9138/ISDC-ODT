import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The library imports the dynamics through the served /static path; tests rewrite it to the file.
const source = await readFile(new URL('../../../digital_twin/model_library/browser/satellite_nodes.js', import.meta.url), 'utf8');
const dynamics = new URL('../../../digital_twin/simulation/browser/satellite_dynamics.js', import.meta.url).href;
const library = await import(`data:text/javascript;base64,${Buffer.from(source.replace(/\/static\/simulation\/satellite_dynamics\.js(?:\?[^'"]*)?/, dynamics)).toString('base64')}`);
const { createNode, cloneNode, normalizeNode, validateNode, nodeCatalogItem, powerBudget, activeOislTerminals, generateFormation, formationSummary, normalizeFormationParams, BUS_PRESETS, EQUIPMENT_CATALOG, createEquipment, nodeMass } = library;
const EPOCH = Date.UTC(2026, 8, 7);
let counter = 0;
const idFactory = () => { counter += 1; return { id: `NODE-${String(counter).padStart(4, '0')}`, catalogNumber: 900000 + counter }; };

test('a node takes bus defaults, a valid orbit and equipment filtered by the link policy', () => {
  const node = createNode({ name: 'ODT-1', bus: 'comms_small' }, { epoch: EPOCH, id: 'NODE-0001', catalogNumber: 900001, linkPolicy: 'ring' });
  assert.equal(node.model_key, 'oneweb');
  assert.equal(node.power.generation_w, BUS_PRESETS.comms_small.generation_w);
  assert.equal(node.orbit.epoch, EPOCH);
  assert.deepEqual(validateNode(node), []);
  const terminals = node.equipment.filter(item => EQUIPMENT_CATALOG[item.catalog].kind === 'oisl');
  assert.deepEqual(terminals.map(item => [item.role, item.enabled]), [['fore', true], ['aft', true], ['left', false], ['right', false]]);
  assert.equal(activeOislTerminals(node).length, 2);
  assert.ok(nodeMass(node) > BUS_PRESETS.comms_small.mass_kg);
  const unknownBus = createNode({ bus: 'nope' }, { epoch: EPOCH });
  assert.equal(unknownBus.bus, 'comms_small');
});

test('validation names every problem and never repairs the definition', () => {
  const node = createNode({ name: ' ' }, { epoch: EPOCH });
  node.orbit.altitude_km = 50;
  node.mode = 'party';
  node.equipment.push({ id: 'x', catalog: 'laser_cannon' });
  node.equipment[0].role = 'sideways';
  node.power.bus_w = -1;
  const errors = validateNode(node);
  assert.equal(errors.length, 6, errors.join('\n'));
  assert.equal(node.orbit.altitude_km, 50);
  assert.deepEqual(validateNode(null), ['노드 정의가 없습니다.']);
});

test('operating modes switch equipment and the power balance follows sunlight', () => {
  const node = createNode({ bus: 'flat_panel' }, { epoch: EPOCH });
  const nominal = powerBudget(node, { sunlit: true });
  assert.equal(nominal.generation_w, 4500);
  assert.equal(nominal.consumption_w, 400 + 4 * 120 + 90 + 8 + 5);
  const eclipse = powerBudget(node, { sunlit: false });
  assert.equal(eclipse.generation_w, 0);
  assert.equal(eclipse.margin_w, -eclipse.consumption_w);
  node.mode = 'safe';
  assert.equal(powerBudget(node, { sunlit: true }).consumption_w, 400 + 8 + 5);
  assert.equal(activeOislTerminals(node).length, 0);
  node.mode = 'standby';
  assert.equal(activeOislTerminals(node).length, 0);
  node.mode = 'nominal';
  const oneActive = new Set([node.equipment[0].id]);
  assert.equal(powerBudget(node, { sunlit: true, activeTerminals: oneActive }).consumption_w, 400 + 120 + 90 + 8 + 5);
});

test('catalog items carry GP-like elements, the node propagator flag and the chosen model', () => {
  const node = createNode({ name: 'ODT-A1', model_key: 'starlink_flat', orbit: { altitude_km: 550, inclination: 53, raan: 120, mean_anomaly: 45 } }, { epoch: EPOCH, id: 'NODE-0007', catalogNumber: 900007 });
  const item = nodeCatalogItem(node);
  assert.equal(item.NORAD_CAT_ID, 900007);
  assert.equal(item.OBJECT_NAME, 'ODT-A1');
  assert.equal(item.OBJECT_ID, 'NODE-0007');
  assert.equal(item.dynamics, 'kepler_j2');
  assert.equal(item.model_key, 'starlink_flat');
  assert.equal(item.ORBIT_REGIME, 'LEO');
  assert.equal(item.RA_OF_ASC_NODE, 120);
  assert.ok(item.MEAN_MOTION > 15 && item.MEAN_MOTION < 15.1);
  assert.equal(item.MEAN_MOTION_DOT, 0);
  assert.notEqual(item.orbit, node.orbit, 'the item holds a copy of the orbit');
  node.orbit.altitude_km = 10;
  assert.equal(nodeCatalogItem(node).ORBIT_REGIME, undefined, 'an invalid orbit yields no derived fields');
});

test('a Walker delta formation spreads planes over 360 degrees with phasing between planes', () => {
  counter = 0;
  const nodes = generateFormation({ preset: 'walker_delta', planes: 3, per_plane: 4, phasing: 1, altitude_km: 550, inclination: 53, prefix: 'W', bus: 'comms_small' }, { epoch: EPOCH, idFactory, formationId: 'FRM-1' });
  assert.equal(nodes.length, 12);
  assert.deepEqual(nodes.slice(0, 5).map(node => node.name), ['W-A1', 'W-A2', 'W-A3', 'W-A4', 'W-B1']);
  assert.deepEqual([...new Set(nodes.map(node => node.orbit.raan))], [0, 120, 240]);
  assert.deepEqual(nodes.slice(0, 4).map(node => node.orbit.mean_anomaly), [0, 90, 180, 270]);
  assert.equal(nodes[4].orbit.mean_anomaly, 30, 'plane B is phased by F * 360 / T = 30 degrees');
  assert.equal(nodes[8].orbit.mean_anomaly, 60);
  assert.deepEqual(nodes.map(node => node.formation.id), Array(12).fill('FRM-1'));
  assert.deepEqual([nodes[5].formation.plane, nodes[5].formation.index], [1, 1]);
  assert.equal(nodes[0].id, 'NODE-0001');
  assert.equal(nodes[11].catalog_number, 900012);
  for (const node of nodes) assert.deepEqual(validateNode(node), []);
});

test('star, train and single presets normalise their parameters', () => {
  const star = normalizeFormationParams({ preset: 'walker_star', planes: 6, per_plane: 2, raan_spread: 360, phasing: 9 });
  assert.equal(star.raan_spread, 180);
  assert.equal(star.phasing, 5, 'phasing is capped at planes - 1');
  const starNodes = generateFormation(star, { epoch: EPOCH, idFactory });
  assert.deepEqual([...new Set(starNodes.map(node => node.orbit.raan))], [0, 30, 60, 90, 120, 150]);
  const train = generateFormation({ preset: 'train', per_plane: 3, spacing_deg: 5, planes: 4, prefix: 'T' }, { epoch: EPOCH, idFactory });
  assert.deepEqual(train.map(node => [node.name, node.orbit.raan, node.orbit.mean_anomaly]), [['T-1', 0, 0], ['T-2', 0, 5], ['T-3', 0, 10]]);
  const single = generateFormation({ preset: 'single', planes: 3, per_plane: 3, prefix: 'SOLO', altitude_km: 35786, inclination: 0 }, { epoch: EPOCH, idFactory });
  assert.equal(single.length, 1);
  assert.equal(single[0].name, 'SOLO');
  assert.equal(nodeCatalogItem(single[0]).ORBIT_REGIME, 'GEO');
  const clamped = normalizeFormationParams({ altitude_km: 99999, inclination: -5, planes: 0, link_policy: 'x', bus: 'y' });
  assert.deepEqual([clamped.altitude_km, clamped.inclination, clamped.planes, clamped.link_policy, clamped.bus], [60000, 0, 1, 'grid', 'comms_small']);
  assert.throws(() => generateFormation({ preset: 'single' }, { epoch: EPOCH }), TypeError);
});

test('the formation summary reports counts, spacing and the intra-plane chord', () => {
  const summary = formationSummary({ preset: 'walker_delta', planes: 6, per_plane: 4, phasing: 2, altitude_km: 550, inclination: 53 });
  assert.equal(summary.total, 24);
  assert.equal(summary.raanStep, 60);
  assert.equal(summary.anomalyStep, 90);
  assert.equal(summary.phaseOffset, 30);
  assert.ok(Math.abs(summary.intraPlaneRangeKm - 2 * 6928.137 * Math.SQRT1_2) < 1e-6);
  assert.ok(summary.periodMinutes > 95 && summary.periodMinutes < 96);
  assert.equal(summary.regime, 'LEO');
  assert.equal(formationSummary({ preset: 'single', altitude_km: 550 }).anomalyStep, 0);
  assert.equal(formationSummary({ preset: 'train', per_plane: 1, spacing_deg: 20, altitude_km: 550 }).anomalyStep, 0);
});

test('clones and normalised stored nodes keep their orbit but regenerate equipment ids', () => {
  const node = createNode({ name: 'Origin', bus: 'cubesat_3u' }, { epoch: EPOCH, id: 'NODE-0001', catalogNumber: 900001 });
  node.formation = { id: 'FRM-9', preset: 'train', plane: 0, index: 0, params: {} };
  const copy = cloneNode(node, { id: 'NODE-0002', catalogNumber: 900002, epoch: EPOCH });
  assert.equal(copy.name, 'Origin 사본');
  assert.equal(copy.formation, null);
  assert.deepEqual(copy.orbit, node.orbit);
  assert.notEqual(copy.equipment[0].id, node.equipment[0].id);
  assert.equal(copy.equipment[0].catalog, 'oisl_mini');
  const stored = normalizeNode({ id: 'NODE-0003', name: 'Stored', orbit: { altitude_km: 700, inclination: 98, epoch: EPOCH }, equipment: [{ catalog: 'eo_camera' }, { catalog: 'bogus' }, { catalog: 'oisl_standard', role: 'weird', enabled: false }] }, EPOCH);
  assert.equal(stored.orbit.altitude_km, 700);
  assert.equal(stored.orbit.raan, 0, 'missing fields take definition defaults');
  assert.deepEqual(stored.equipment.map(item => [item.catalog, item.role, item.enabled]), [['eo_camera', null, true], ['oisl_standard', 'auto', false]]);
  assert.equal(normalizeNode({ name: 'no id' }), null);
  assert.throws(() => createEquipment('bogus'), RangeError);
});
