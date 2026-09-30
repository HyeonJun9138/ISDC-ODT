import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStatic } from './load_static.mjs';

const assembly = await loadStatic('digital_twin/model_library/browser/scenario_assembly.js');
const library = await loadStatic('digital_twin/model_library/browser/satellite_nodes.js');
const T0 = Date.UTC(2026, 8, 8, 0, 0, 0);

const definition = {
  id: 'SDC_POC_01',
  constellation: {
    prefix: 'SDC', preset: 'walker_delta', planes: 4, per_plane: 10, altitude_km: 550, inclination: 53, phasing: 1, raan_start: 0, raan_spread: 60, anomaly_start: 0, bus: 'comms_small', link_policy: 'grid',
    model_key: 'eo_1',
    equipment: { all: ['dtn_store'], roles: { source: ['eo_camera'], gateway: ['x_band_downlink'] } },
    roles: { source: { label: 'N1', plane: 0, index: 2 }, relay: { label: 'N2', plane: 0, index: 3 }, alternate: { label: 'N3', plane: 1, index: 2 }, gateway: { label: 'N4', plane: 0, index: 4, model_key: 'tdrs' } },
  },
  stations: ['daejeon', 'jeju', 'svalbard'],
  missions: [
    { key: 'relay', kind: 'relay', name: 'N1→N4', priority: 2, deadline_hours: 2, commit: true, params: { source: 'satellite:@source', destination: 'satellite:@gateway', volume_mb: 120000, max_latency_ms: 40 } },
    { key: 'observe', kind: 'observe', name: '독도', priority: 3, deadline_hours: 24, params: { target: 'dokdo', max_off_nadir_deg: 60, product_mb: 800, preferred_satellite: '@source' } },
  ],
};

function idFactory() {
  let sequence = 0;
  return () => { sequence += 1; return { id: `NODE-${String(sequence).padStart(4, '0')}`, catalogNumber: 900000 + sequence }; };
}

test('the constellation is laid out with roles, extra equipment and stable ids', () => {
  const { nodes, roles } = assembly.assembleConstellation(definition, { epoch: T0, idFactory: idFactory() });
  assert.equal(nodes.length, 40);
  assert.equal(roles.source.name, 'SDC-A3');
  assert.equal(roles.relay.name, 'SDC-A4');
  assert.equal(roles.alternate.name, 'SDC-B3');
  assert.equal(roles.gateway.name, 'SDC-A5');
  assert.equal(roles.source.role.label, 'N1');
  assert.ok(nodes.every(node => node.equipment.some(item => item.catalog === 'dtn_store')), 'every node stores data');
  assert.ok(roles.source.equipment.some(item => item.catalog === 'eo_camera'));
  assert.ok(roles.gateway.equipment.some(item => item.catalog === 'x_band_downlink'));
  assert.ok(!roles.relay.equipment.some(item => item.catalog === 'eo_camera'));
  assert.equal(nodes.filter(node => node.equipment.filter(item => item.catalog === 'dtn_store').length > 1).length, 0, 'no duplicate equipment');
  assert.equal(library.validateNode(roles.source).length, 0);
  assert.equal(roles.source.orbit.raan, 0);
  assert.equal(roles.alternate.orbit.raan, 15, 'four planes over 60° of RAAN sit 15° apart');
  assert.ok(nodes.every(node => node.formation.id === 'FRM-SCENARIO'));
});

test('the display model comes from the definition, a role may override it and the bus model is the fallback', () => {
  const { nodes, roles } = assembly.assembleConstellation(definition, { epoch: T0, idFactory: idFactory() });
  assert.ok(nodes.filter(node => node !== roles.gateway).every(node => node.model_key === 'eo_1'), 'the scenario model replaces the bus model everywhere');
  assert.equal(roles.gateway.model_key, 'tdrs', 'a role model wins on that satellite');
  assert.equal(roles.gateway.bus, 'comms_small', 'the bus (power, equipment) is unchanged');
  const plainRoles = Object.fromEntries(Object.entries(definition.constellation.roles).map(([key, role]) => [key, { ...role, model_key: undefined }]));
  const plain = { ...definition, constellation: { ...definition.constellation, model_key: undefined, roles: plainRoles } };
  const fallback = assembly.assembleConstellation(plain, { epoch: T0, idFactory: idFactory() });
  assert.equal(fallback.roles.source.model_key, library.BUS_PRESETS.comms_small.model_key, 'without a scenario model the bus model stays');
  const empty = { ...definition, constellation: { ...definition.constellation, model_key: '' } };
  assert.throws(() => assembly.assembleConstellation(empty, { epoch: T0, idFactory: idFactory() }), /model_key/);
});

test('references resolve to node ids and unknown roles or presets are errors', () => {
  const { roles } = assembly.assembleConstellation(definition, { epoch: T0, idFactory: idFactory() });
  assert.equal(assembly.resolveReference('@source', roles), roles.source.id);
  assert.equal(assembly.resolveReference('satellite:@gateway', roles), `satellite:${roles.gateway.id}`);
  assert.equal(assembly.resolveReference('GS-DAEJEON', roles), 'GS-DAEJEON');
  assert.throws(() => assembly.resolveReference('@nobody', roles), /nobody/);
  assert.deepEqual(assembly.resolveDeep({ a: ['@source', 1], b: { c: 'satellite:@relay' } }, roles), { a: [roles.source.id, 1], b: { c: `satellite:${roles.relay.id}` } });
  assert.throws(() => assembly.assembleConstellation({ ...definition, constellation: { ...definition.constellation, roles: { ghost: { plane: 9, index: 0 } } } }, { epoch: T0, idFactory: idFactory() }), /ghost/);
  assert.throws(() => assembly.assembleStations({ stations: ['moon'] }), /moon/);
  const stations = assembly.assembleStations(definition);
  assert.deepEqual(stations.map(station => station.id), ['GS-DAEJEON', 'GS-JEJU', 'GS-SVALBARD']);
  assert.equal(stations[0].preset, 'daejeon');
});

test('missions are built with resolved endpoints, presets and deadlines relative to the scenario start', () => {
  const { roles } = assembly.assembleConstellation(definition, { epoch: T0, idFactory: idFactory() });
  const missions = assembly.assembleMissions(definition, roles, { now: T0 });
  assert.equal(missions.length, 2);
  const relay = missions[0];
  assert.equal(relay.params.source, `satellite:${roles.source.id}`);
  assert.equal(relay.params.destination, `satellite:${roles.gateway.id}`);
  assert.equal(relay.deadline, new Date(T0 + 2 * 3600_000).toISOString());
  assert.equal(relay.commit, true);
  assert.deepEqual(relay.scenario, { id: 'SDC_POC_01', key: 'relay' });
  const observe = missions[1];
  assert.equal(observe.params.target_name, '독도');
  assert.ok(Math.abs(observe.params.latitude - 37.2431) < 1e-6);
  assert.equal(observe.params.preferred_satellite, roles.source.id);
  assert.equal(observe.commit, false);
});

test('templates fill nested context values and mark missing ones', () => {
  assert.equal(assembly.fillTemplate('N1({source})이 {relay.path}로 보낸다 {nothing.here}', { source: 'SDC-A3', relay: { path: 'A3 → A4 → A5' } }), 'N1(SDC-A3)이 A3 → A4 → A5로 보낸다 —');
  assert.equal(assembly.fillTemplate(null, {}), '');
});
