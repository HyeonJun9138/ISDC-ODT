import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);
const stationsUrl = new URL('digital_twin/model_library/browser/ground_stations.js', root).href;
const source = (await readFile(new URL('user_application/web/scripts/communication/ground_segment.js', root), 'utf8')).replace('/static/model_library/ground_stations.js', stationsUrl);
const { createGroundSegmentStore, STATIONS_KEY, MAX_STATIONS } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: key => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, value), data };
}

test('a fresh console starts with the default sites and persists every change', () => {
  const storage = memoryStorage();
  const store = createGroundSegmentStore({ storage });
  const events = [];
  store.subscribe(event => events.push(event));
  store.load();
  assert.deepEqual(store.stations.map(station => station.id), ['GS-DAEJEON', 'GS-JEJU', 'GS-SVALBARD']);
  assert.equal(store.enabled.length, 3);
  const added = store.add({ preset: 'fairbanks' });
  assert.equal(added.id, 'GS-FAIRBANKS');
  assert.equal(store.selectedId, added.id);
  assert.equal(store.availablePresets().some(preset => preset.key === 'fairbanks'), false);
  const custom = store.add({ name: '고흥', latitude: 34.6, longitude: 127.2 });
  assert.equal(custom.preset, null);
  assert.match(custom.id, /^GS-SITE_\d+$/);
  assert.deepEqual(store.update(custom.id, { latitude: 200 }), ['위도는 -90~90°여야 합니다.']);
  assert.deepEqual(store.update(custom.id, { name: '고흥 추적소', min_elevation_deg: 7, bands: ['X'] }), []);
  assert.equal(store.find(custom.id).name, '고흥 추적소');
  assert.equal(store.setEnabled('GS-JEJU', false), true);
  assert.equal(store.enabled.length, 4);
  const saved = JSON.parse(storage.getItem(STATIONS_KEY));
  assert.equal(saved.stations.length, 5);
  const reloaded = createGroundSegmentStore({ storage });
  reloaded.load();
  assert.equal(reloaded.find('GS-JEJU').enabled, false);
  assert.equal(reloaded.find(custom.id).min_elevation_deg, 7);
  assert.equal(reloaded.selectedId, custom.id);
  assert.equal(store.remove('GS-JEJU'), true);
  assert.equal(store.remove('GS-JEJU'), false);
  store.reset();
  assert.equal(store.stations.length, 3);
  assert.deepEqual(events.slice(0, 3), ['load', 'add', 'add']);
});

test('duplicate presets get unique ids and the station limit is enforced', () => {
  const store = createGroundSegmentStore({ storage: memoryStorage() });
  store.load();
  assert.equal(store.add({ preset: 'jeju' }).id, 'GS-JEJU_2');
  while (store.stations.length < MAX_STATIONS) store.add({ name: 'x', latitude: 0, longitude: 0 });
  assert.throws(() => store.add({ preset: 'hobart' }), RangeError);
});
