import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { nodeStateAt } from '../../../digital_twin/simulation/browser/satellite_dynamics.js';

// Served /static paths are rewritten to files so the browser modules load in Node.
const root = new URL('../../../', import.meta.url);
const fileUrl = path => new URL(path, root).href;
const dynamicsUrl = fileUrl('digital_twin/simulation/browser/satellite_dynamics.js');
const orbitUrl = fileUrl('digital_twin/simulation/browser/orbit.js');
const oislUrl = fileUrl('digital_twin/simulation/browser/oisl.js');
const stationsUrl = fileUrl('digital_twin/model_library/browser/ground_stations.js');
async function load(path, replacements) {
  let source = await readFile(new URL(path, root), 'utf8');
  for (const [from, to] of replacements) source = source.replace(new RegExp(`${from.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?:\\?[^'"]*)?`), to);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
const librarySource = (await readFile(new URL('digital_twin/model_library/browser/satellite_nodes.js', root), 'utf8')).replace(/\/static\/simulation\/satellite_dynamics\.js(?:\?[^'"]*)?/, dynamicsUrl);
const libraryUrl = `data:text/javascript;base64,${Buffer.from(librarySource).toString('base64')}`;
const library = await import(libraryUrl);
const groundLinksSource = (await readFile(new URL('digital_twin/simulation/browser/ground_links.js', root), 'utf8'))
  .replace('/static/simulation/orbit.js', orbitUrl).replace('/static/model_library/ground_stations.js', stationsUrl).replace('/static/model_library/satellite_nodes.js', libraryUrl);
const groundLinksUrl = `data:text/javascript;base64,${Buffer.from(groundLinksSource).toString('base64')}`;
const groundLinks = await import(groundLinksUrl);
const snapshotModule = await load('digital_twin/simulation/browser/network_snapshot.js', [
  ['/static/model_library/satellite_nodes.js', libraryUrl], ['/static/simulation/ground_links.js', groundLinksUrl], ['/static/simulation/oisl.js', oislUrl],
]);
const links = await load('user_application/web/scripts/nodes/links.js', [['/static/model_library/satellite_nodes.js', libraryUrl], ['/static/simulation/oisl.js', oislUrl]]);
const stations = await import(stationsUrl);

const T0 = Date.UTC(2026, 8, 7, 0, 0, 0);
let counter = 0;
function node(name, meanAnomaly, extra = {}) {
  counter += 1;
  return library.createNode({ name, bus: extra.bus || 'comms_small', mode: extra.mode, orbit: { altitude_km: 550, inclination: 53, raan: extra.raan || 0, mean_anomaly: meanAnomaly, epoch: T0 } }, { epoch: T0, id: `NODE-${counter}`, catalogNumber: 900000 + counter });
}
const statesAt = (nodes, date) => new Map(nodes.map(item => [item.id, nodeStateAt(item.orbit, date)]));

test('ground links report visibility, band and budget inputs from the twin geometry', () => {
  const station = stations.createStation({ preset: 'daejeon' }, { id: 'GS-DAEJEON' });
  const sat = node('A', 0);
  const overhead = { latitude: station.latitude, longitude: station.longitude, altitude: 550 };
  const link = groundLinks.groundLink(station, sat, overhead);
  assert.equal(link.id, 'GS-DAEJEON|NODE-1');
  assert.equal(link.kind, 'ground');
  assert.equal(link.state, 'visible');
  assert.equal(link.band, 'Ka', 'the comms bus carries a Ka user link and the site supports Ka');
  assert.ok(link.elevation_deg > 89 && link.range_km > 540 && link.range_km < 560);
  assert.equal(link.frequency_ghz, 20);
  assert.ok(link.eirp_dbw > 39 && link.eirp_dbw < 40, `90 W + 20 dBi ≈ 39.5 dBW, got ${link.eirp_dbw}`);
  assert.ok(link.gt_dbk > 38 && link.gt_dbk < 44);
  const far = groundLinks.groundLink(station, sat, { latitude: -30, longitude: 20, altitude: 550 });
  assert.equal(far.state, 'below_mask');
  assert.ok(far.elevation_deg < 0);
  const safe = node('SAFE', 0, { mode: 'safe' });
  const ttc = groundLinks.groundLink(station, safe, overhead);
  assert.equal(ttc.band, 'S', 'safe mode leaves only the S-band TT&C radio on');
  const noRadio = groundLinks.groundLink(stations.createStation({ preset: 'jeju', bands: ['Ka'] }, { id: 'GS-KA' }), safe, overhead);
  assert.equal(noRadio.state, 'no_radio');
  assert.equal(noRadio.band, null);
  assert.equal(groundLinks.groundLink(station, sat, null), null);
  const mesh = groundLinks.terrestrialLinks([station, stations.createStation({ preset: 'jeju' }, { id: 'GS-JEJU' }), stations.createStation({ preset: 'svalbard' }, { id: 'GS-SVALBARD' })]);
  assert.equal(mesh.length, 3);
  assert.ok(mesh.every(item => item.kind === 'terrestrial' && item.distance_km > 0 && item.data_rate_mbps === 10000));
});

test('the ICD-02 message carries nodes, OISL pairs, ground links, the mesh and folded faults', () => {
  const a = node('A', 0);
  const b = node('B', 20);
  const nodes = [a, b];
  const date = new Date(T0 + 120_000);
  const states = statesAt(nodes, date);
  // The terminal sequence is advanced from the epoch so the pair has had time to slew and lock.
  const first = links.resolveLinks(nodes, statesAt(nodes, new Date(T0)), new Map(), T0);
  const resolved = links.resolveLinks(nodes, states, first.histories, date);
  assert.equal(resolved.pairs.length, 1);
  const site = stations.createStation({ preset: 'daejeon' }, { id: 'GS-DAEJEON' });
  const other = stations.createStation({ preset: 'svalbard' }, { id: 'GS-SVALBARD' });
  const message = snapshotModule.buildNetworkSnapshot({ date, nodes, states, pairs: resolved.pairs, stations: [site, other], faults: [
    { kind: 'link_loss', target: 'B', severity: 'medium', active: true }, { kind: 'latency_spike', target: a.id, severity: 'high', active: true }, { kind: 'power_drop', target: 'A', active: true },
  ] });
  assert.equal(message.time, date.toISOString());
  assert.equal(message.nodes.length, 4);
  const [nodeA, nodeB] = message.nodes;
  assert.equal(nodeA.kind, 'satellite');
  assert.equal(nodeA.generation_mbps, snapshotModule.HOUSEKEEPING_MBPS);
  assert.equal(nodeA.storage_gb, snapshotModule.DEFAULT_STORAGE_GB);
  assert.equal(nodeA.extra_delay_ms, snapshotModule.FAULT_EXTRA_DELAY_MS.high, 'a latency fault on the node id adds delay');
  assert.equal(nodeB.extra_delay_ms, 0);
  assert.equal(message.nodes[2].kind, 'ground');
  const oisl = message.links.filter(link => link.kind === 'oisl');
  assert.equal(oisl.length, 1);
  assert.equal(oisl[0].id, `${a.id}|${b.id}`);
  assert.equal(oisl[0].state, 'locked', 'two minutes after epoch the fore/aft terminals have locked');
  assert.equal(oisl[0].data_rate_mbps, 10000);
  assert.ok(oisl[0].margin_db > 0 && oisl[0].range_km > 2000);
  assert.equal(oisl[0].faulted, true, 'a link loss fault on a satellite name marks its links');
  const ground = message.links.filter(link => link.kind === 'ground');
  assert.equal(ground.length, 4, 'every station × satellite pair with known geometry');
  assert.equal(ground.filter(link => link.faulted).length, 2);
  assert.ok(ground.every(link => ['visible', 'below_mask'].includes(link.state)));
  const mesh = message.links.filter(link => link.kind === 'terrestrial');
  assert.equal(mesh.length, 1);
  assert.equal(mesh[0].faulted, false);
  assert.equal(new Set(message.links.map(link => link.id)).size, message.links.length, 'link ids are unique');
});

test('payload and storage equipment change what a satellite generates and stores', () => {
  const eo = node('EO', 0, { bus: 'eo_smallsat' });
  assert.equal(snapshotModule.generationMbps(eo), snapshotModule.HOUSEKEEPING_MBPS + snapshotModule.PAYLOAD_GENERATION_MBPS.payload);
  assert.equal(snapshotModule.storageGb(eo), 2000, 'the DTN store on the EO bus is 2 TB');
  const safe = node('SAFE', 0, { bus: 'eo_smallsat', mode: 'safe' });
  assert.equal(snapshotModule.generationMbps(safe), snapshotModule.HOUSEKEEPING_MBPS, 'safe mode turns the camera off');
  assert.equal(snapshotModule.storageGb(safe), snapshotModule.DEFAULT_STORAGE_GB, 'safe mode turns the store off too');
});
