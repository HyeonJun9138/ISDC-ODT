import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const base = new URL('../../../user_application/web/scripts/orbit/', import.meta.url);
// Dynamic imports allow a missing implementation to fail as an explicit requirement.
async function moduleAt(name) {
  const module = await import(new URL(name, base)).catch(() => null);
  assert.ok(module, `${name} must provide the orbit console logic`);
  return module;
}

test('missing numeric values remain unknown instead of turning into zero', async () => {
  const { finiteNumber, displayNumber } = await moduleAt('catalog.js');
  for (const value of [null, undefined, '', ' ', false, 'bad', Infinity]) {
    assert.equal(finiteNumber(value), null);
    assert.equal(displayNumber(value, 2), '—');
  }
  assert.equal(displayNumber(0, 2), '0.00');
});

test('GP epochs without timezone are UTC and missing epochs stay unknown', async () => {
  const { utcMillis, epochAgeHours } = await moduleAt('catalog.js');
  assert.equal(utcMillis('1970-01-01T00:00:00'), 0);
  assert.equal(utcMillis(null), null);
  assert.equal(utcMillis('bad'), null);
  assert.equal(epochAgeHours({ EPOCH: '1970-01-01T00:00:00' }, 3600000), 1);
  assert.equal(epochAgeHours({ EPOCH: null }, 3600000), null);
});

test('filter and numeric sort keep unknowns last in either direction without mutating input', async () => {
  const { selectCatalog } = await moduleAt('catalog.js');
  const items = [
    { OBJECT_NAME: '<ISS>', NORAD_CAT_ID: 10, ORBIT_REGIME: 'LEO', EPOCH: null },
    { OBJECT_NAME: 'ISS B', NORAD_CAT_ID: 2, ORBIT_REGIME: 'LEO', EPOCH: '1970-01-01T00:00:00Z' },
    { OBJECT_NAME: 'GPS', NORAD_CAT_ID: 4, ORBIT_REGIME: 'MEO', EPOCH: '1970-01-01T01:00:00Z' },
  ];
  assert.deepEqual(selectCatalog(items, { query: 'iss', sort: 'id' }).map(x => x.NORAD_CAT_ID), [2, 10]);
  assert.deepEqual(selectCatalog(items, { orbit: 'MEO' }).map(x => x.NORAD_CAT_ID), [4]);
  assert.deepEqual(selectCatalog(items, { favoritesOnly: true, favorites: new Set(['10']) }).map(x => x.NORAD_CAT_ID), [10]);
  assert.deepEqual(selectCatalog(items, { sort: 'age', direction: 'desc', now: 7200000 }).map(x => x.NORAD_CAT_ID), [2, 4, 10]);
  assert.deepEqual(selectCatalog(items, { sort: 'age', now: 7200000 }).map(x => x.NORAD_CAT_ID), [4, 2, 10]);
  assert.equal(items[0].NORAD_CAT_ID, 10);
});

test('catalog markup never turns external object names into executable HTML', async () => {
  const { escapeMarkup } = await moduleAt('catalog.js');
  assert.equal(escapeMarkup('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});

test('analysis clock pauses, steps and resumes continuously without touching server runtime', async () => {
  const { OrbitClock } = await moduleAt('clock.js');
  let wall = 0;
  const clock = new OrbitClock(() => wall);
  wall = 1000;
  assert.equal(clock.now().getTime(), 1000);
  clock.pause(); wall = 5000;
  assert.equal(clock.now().getTime(), 1000);
  clock.step(60);
  assert.equal(clock.now().getTime(), 61000);
  clock.setSpeed(10); clock.play(); wall = 6000;
  assert.equal(clock.now().getTime(), 71000);
  clock.setSpeed(1); wall = 7000;
  assert.equal(clock.now().getTime(), 72000);
  clock.live();
  assert.equal(clock.now().getTime(), 7000);
  assert.equal(clock.speed, 1);
  assert.equal(clock.isLive, true);
});

test('clock rejects invalid seek and rates, accepts Unix epoch zero', async () => {
  const { OrbitClock } = await moduleAt('clock.js');
  const clock = new OrbitClock(() => 123);
  clock.seek(new Date(0));
  assert.equal(clock.now().getTime(), 0);
  assert.equal(clock.running, false);
  assert.throws(() => clock.seek(new Date('bad')), RangeError);
  assert.throws(() => clock.setSpeed(0), RangeError);
  assert.throws(() => clock.step(Infinity), RangeError);
});

test('orbit console exposes independent analysis controls without fake subsystem telemetry', async () => {
  const html = await readFile(new URL('../../../user_application/web/index.html', import.meta.url), 'utf8');
  const orbit = html.split('<!-- ORBIT -->')[1].split('<!-- COMMUNICATION -->')[0];
  for (const id of ['orbit-clock', 'orbit-pause', 'orbit-now', 'satellite-search', 'satellite-list', 'orbit-inspector', 'pass-list']) {
    assert.ok(orbit.includes(`id="${id}"`), `missing accessible control ${id}`);
  }
  for (const id of ['scenario-list', 'node-status-list', 'power-value', 'uplink-value', 'visibility-ring']) {
    assert.ok(!orbit.includes(`id="${id}"`), `unrelated synthetic telemetry remains: ${id}`);
  }
});

test('virtual catalog clamps scroll range and escapes row labels', async () => {
  const { virtualWindow, rowMarkup } = await moduleAt('catalog_view.js');
  assert.deepEqual(virtualWindow(0, 320, 10000), { start: 0, end: 18 });
  const last = virtualWindow(99999999, 320, 10000);
  assert.ok(last.start < 10000 && last.end === 10000);
  const markup = rowMarkup({ OBJECT_NAME: '<img>', NORAD_CAT_ID: 1, EPOCH: null }, 0, 1, '1', new Set(), 0);
  assert.ok(markup.includes('&lt;img&gt;'));
  assert.ok(markup.includes('aria-selected="true"'));
  assert.ok(markup.includes('미제공'));
});

test('selection does not replace a visible row between the two clicks of a double-click', async () => {
  const { createCatalogList } = await moduleAt('catalog_view.js');
  globalThis.ResizeObserver = class { observe() {} };
  let writes = 0;
  const row = { dataset: { satelliteId: '1' }, setAttribute() {} };
  const space = { classList: { contains: () => true }, style: {}, set innerHTML(_) { writes++; } };
  const element = { firstElementChild: space, scrollTop: 0, clientHeight: 320, setAttribute() {}, removeAttribute() {}, addEventListener() {}, querySelectorAll: () => [row] };
  const list = createCatalogList({ element, onSelect() {} });
  list.setItems([{ NORAD_CAT_ID: 1, OBJECT_NAME: 'ISS' }]);
  const before = writes;
  list.select('1', true);
  assert.equal(writes, before, 'keep the event target alive during selection');
});
