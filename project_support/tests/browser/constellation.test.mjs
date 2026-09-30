import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Rewrite the served /static import paths to files so the store and the library load in Node.
const root = new URL('../../../', import.meta.url);
const dynamics = new URL('digital_twin/simulation/browser/satellite_dynamics.js', root).href;
const librarySource = (await readFile(new URL('digital_twin/model_library/browser/satellite_nodes.js', root), 'utf8'))
  .replace(/\/static\/simulation\/satellite_dynamics\.js(?:\?[^'"]*)?/, dynamics);
const libraryUrl = `data:text/javascript;base64,${Buffer.from(librarySource).toString('base64')}`;
const storeSource = (await readFile(new URL('user_application/web/scripts/nodes/constellation.js', root), 'utf8'))
  .replace(/\/static\/model_library\/satellite_nodes\.js(?:\?[^'"]*)?/, libraryUrl);
const { createConstellationStore, DRAFT_KEY, DEPLOYED_KEY } = await import(`data:text/javascript;base64,${Buffer.from(storeSource).toString('base64')}`);

class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
}

const EPOCH = Date.UTC(2026, 8, 7);

test('adding, selecting, updating and removing nodes persists the draft set with stable ids', () => {
  const storage = new FakeStorage();
  const store = createConstellationStore({ storage, now: () => EPOCH });
  store.load();
  assert.deepEqual(store.drafts, []);
  const first = store.add({ name: 'Alpha', bus: 'cubesat_3u' });
  const second = store.add({});
  assert.equal(first.id, 'NODE-0001');
  assert.equal(second.name, 'NODE-0002', 'a nameless node is named after its id');
  assert.equal(store.selectedId, second.id);
  assert.equal(first.catalog_number, 900001);
  const errors = store.update(first.id, { ...first, name: 'Alpha 2', orbit: { ...first.orbit, altitude_km: 700 } });
  assert.deepEqual(errors, []);
  assert.equal(store.find(first.id).orbit.altitude_km, 700);
  assert.equal(store.find(first.id).catalog_number, 900001, 'catalog numbers cannot be changed by an update');
  assert.deepEqual(store.update(first.id, { ...first, orbit: { ...first.orbit, altitude_km: 10 } }).length, 1);
  assert.equal(store.find(first.id).orbit.altitude_km, 700, 'an invalid update leaves the node untouched');
  assert.equal(store.select(first.id), first.id);
  assert.equal(store.select('NODE-9999'), null);
  assert.equal(store.remove(second.id), true);
  assert.equal(store.remove(second.id), false);
  const reloaded = createConstellationStore({ storage, now: () => EPOCH + 1000 });
  reloaded.load();
  assert.deepEqual(reloaded.drafts.map(node => [node.id, node.name]), [['NODE-0001', 'Alpha 2']]);
  assert.equal(reloaded.add({}).id, 'NODE-0003', 'the sequence continues after a reload');
  assert.ok(JSON.parse(storage.getItem(DRAFT_KEY)).nodes.length === 2);
});

test('deployment copies the draft set, tracks drift from it and survives reload', () => {
  const storage = new FakeStorage();
  const store = createConstellationStore({ storage, now: () => EPOCH });
  store.load();
  assert.equal(store.isDirty(), false, 'nothing drafted and nothing deployed');
  const node = store.add({ name: 'Relay' });
  assert.equal(store.isDirty(), true);
  const deployed = store.deploy();
  assert.equal(deployed.length, 1);
  assert.equal(store.deployedAt, new Date(EPOCH).toISOString());
  assert.equal(store.isDirty(), false);
  assert.notEqual(store.deployed[0], store.drafts[0], 'the deployed set is a copy');
  store.update(node.id, { ...node, name: 'Relay B' });
  assert.equal(store.isDirty(), true);
  assert.equal(store.deployed[0].name, 'Relay', 'editing a draft does not change the deployed record');
  store.update(node.id, { ...store.find(node.id), name: 'Relay' });
  assert.equal(store.isDirty(), false, 'a save without a real change is not drift');
  const items = store.deployedItems();
  assert.equal(items[0].NORAD_CAT_ID, 900001);
  assert.equal(items[0].dynamics, 'kepler_j2');
  const reloaded = createConstellationStore({ storage, now: () => EPOCH });
  reloaded.load();
  assert.equal(reloaded.deployed.length, 1);
  assert.equal(reloaded.isDirty(), false);
  reloaded.recall();
  assert.equal(reloaded.deployed.length, 0);
  assert.equal(JSON.parse(storage.getItem(DEPLOYED_KEY)).nodes.length, 0);
});

test('formation groups, duplicates and clearing keep the selection valid and notify listeners', () => {
  const store = createConstellationStore({ storage: new FakeStorage(), now: () => EPOCH });
  const events = [];
  store.subscribe(event => events.push(event));
  store.load();
  const ids = [store.nextIds(), store.nextIds()];
  store.addMany(ids.map((id, index) => ({ id: id.id, catalog_number: id.catalogNumber, name: `F${index}`, formation: { id: 'FRM-1' }, orbit: {} })));
  const copy = store.duplicate(ids[0].id);
  assert.equal(copy.name, 'F0 사본');
  assert.equal(copy.formation, null);
  assert.equal(store.selectedId, copy.id);
  assert.deepEqual(store.removeFormation('FRM-1'), ids.map(id => id.id));
  assert.equal(store.drafts.length, 1);
  assert.equal(store.selectedId, copy.id);
  assert.deepEqual(store.removeFormation('FRM-1'), []);
  store.clear();
  assert.equal(store.selectedId, null);
  assert.deepEqual(events, ['load', 'add', 'add', 'remove', 'remove']);
});

test('corrupt or missing storage yields an empty working set without throwing', () => {
  const storage = new FakeStorage();
  storage.setItem(DRAFT_KEY, '{not json');
  storage.setItem(DEPLOYED_KEY, JSON.stringify({ nodes: [{ id: 'NODE-0002', orbit: { altitude_km: 500, inclination: 45 } }, 'junk'] }));
  const store = createConstellationStore({ storage, now: () => EPOCH });
  store.load();
  assert.deepEqual(store.drafts, []);
  assert.equal(store.deployed.length, 1, 'the well-formed deployed node survives');
  assert.equal(store.deployed[0].orbit.epoch, EPOCH, 'a missing epoch takes the load time');
  assert.equal(store.add({}).id, 'NODE-0003', 'ids continue after the highest stored catalog number');
  const detached = createConstellationStore({ storage: null });
  detached.load();
  assert.equal(detached.add({ name: 'memory only' }).name, 'memory only');
});
