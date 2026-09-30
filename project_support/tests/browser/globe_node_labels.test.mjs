import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGlobe } from './load_globe.mjs';

const { GlobeController } = await loadGlobe();
const color = css => ({ css, withAlpha: alpha => ({ css, alpha }) });
const node = (id, name = `ODT-${id}`) => ({ NORAD_CAT_ID: id, OBJECT_NAME: name, node: true, ORBIT_REGIME: 'LEO' });

function scene({ dense = false } = {}) {
  globalThis.window = { Cesium: {
    Color: { fromCssColorString: color, WHITE: color('white'), TRANSPARENT: color('transparent') },
    Cartesian3: { fromDegrees: (lon, lat, h) => ({ lon, lat, h }) },
    Cartesian2: class { constructor(x, y) { Object.assign(this, { x, y }); } },
    NearFarScalar: class { constructor(near, nearValue, far, farValue) { Object.assign(this, { near, nearValue, far, farValue }); } },
    LabelStyle: { FILL_AND_OUTLINE: 1 },
  } };
  const globe = new GlobeController({}, {}, { sunElement: {} });
  globe.viewer = { scene: { requestRender() {} } };
  globe.pointCollection = { add: options => ({ ...options }) };
  globe.labelCollection = { items: [], add(options) { const label = { ...options }; this.items.push(label); return label; } };
  // Isolate label/point lifecycle from camera, trajectory and observer-line rendering.
  globe.updateSunIndicator = () => {};
  globe.rebuildPath = () => {};
  globe.updateSelectedGeometry = () => {};
  globe.positionAt = (id, date) => ({ longitude: Number(id) + date.getTime() / 1000, latitude: 0, altitude: 500 });
  const items = [node('1'), node('2', 'Renamed node'), { NORAD_CAT_ID: '3', OBJECT_NAME: 'ODT catalog namesake', ORBIT_REGIME: 'LEO' }];
  globe.items = dense ? [...items, ...Array.from({ length: 100 }, (_, i) => ({ NORAD_CAT_ID: String(i + 10), OBJECT_NAME: `GP-${i}` }))] : items;
  globe.items.forEach((item, index) => {
    const id = String(item.NORAD_CAT_ID);
    globe.records.set(id, { item, index });
    globe.addCesiumEntity(id, item, index);
  });
  globe.update(new Date(1000));
  return globe;
}

for (const dense of [false, true]) {
  test(`node names are visible without selecting, including renamed nodes (${dense ? 'dashboard catalog' : 'node/communication catalog'})`, () => {
    const globe = scene({ dense });
    assert.equal(globe.labelsVisible, false);
    assert.equal(globe.labels.get('1')?.show, true);
    assert.equal(globe.labels.get('2')?.show, true);
    assert.equal(globe.labels.get('2').text, 'Renamed node', 'Use the node marker, not an ODT name prefix');
    assert.ok(!globe.labels.get('3')?.show, 'Do not force names on ordinary catalog objects');
    assert.equal(globe.labels.size, dense ? 2 : 3, 'Large catalogs only allocate permanent labels for user nodes');
    assert.equal(globe.labels.get('1').disableDepthTestDistance, 0, 'Earth must occlude far-side labels');
    globe.update(new Date(2000));
    assert.deepEqual(globe.labels.get('1').position, { lon: 3, lat: 0, h: 500_000 });
  });
}

test('filters, missing positions and the ordinary label toggle preserve node label visibility correctly', () => {
  const globe = scene();
  globe.setVisibleSatellites(['1', '3']);
  assert.equal(globe.labels.get('1').show, true);
  assert.equal(globe.labels.get('2').show, false);
  globe.toggleLabels();
  assert.equal(globe.labels.get('3').show, true);
  globe.toggleLabels();
  assert.equal(globe.labels.get('1').show, true);
  assert.equal(globe.labels.get('2').show, false);
  assert.equal(globe.labels.get('3').show, false);
  const positionAt = globe.positionAt;
  globe.positionAt = () => null;
  globe.update(new Date(2000));
  globe.toggleLabels();
  assert.equal(globe.labels.get('1').show, false, 'Unavailable positions must not leave stale names');
  globe.positionAt = positionAt;
  globe.update(new Date(3000));
  assert.equal(globe.labels.get('1').show, true);
  assert.equal(globe.labels.get('2').show, false);
});

test('switching and clearing selection keeps node names but never draws a duplicate selected label', () => {
  const globe = scene({ dense: true });
  globe.select('3', false);
  assert.equal(globe.selectedLabel.show, true);
  globe.select('1', false);
  assert.equal(globe.labels.get('1')?.show, true);
  assert.equal(globe.selectedLabel.show, false, 'The permanent node label replaces the pooled selection label');
  globe.update(new Date(2000));
  globe.toggleLabels();
  assert.equal(globe.selectedLabel.show, false, 'Updates and toggles must not resurrect the duplicate');
  globe.toggleLabels();
  globe.select('2', false);
  assert.equal(globe.labels.get('1').show, true, 'Previous selection remains named');
  assert.equal(globe.labels.get('1').fillColor.css, 'white');
  globe.clearSelection();
  assert.equal(globe.labels.get('2').show, true);
  globe.setVisibleSatellites(['1']);
  globe.select('2', false);
  assert.equal(globe.labels.get('2').show, true, 'Keep the existing selected-object filter exception');
  globe.clearSelection();
  assert.equal(globe.labels.get('2').show, false, 'Clearing selection must restore the filter');
});

test('Canvas fallback also names visible nodes in a large catalog without naming every GP object', () => {
  const globe = scene({ dense: true });
  const texts = [];
  const context = new Proxy({ fillText: text => texts.push(text) }, { get: (target, key) => target[key] ?? (() => {}) });
  globe.fallbackCanvas = { getBoundingClientRect: () => ({ width: 800, height: 600 }), getContext: () => context };
  globe.setVisibleSatellites(['1', '3']);
  globalThis.devicePixelRatio = 1;
  try {
    globe.lastFallbackDrawMs = -Infinity;
    globe.drawFallback();
    assert.ok(texts.includes('ODT-1'));
    assert.ok(!texts.includes('Renamed node'));
    assert.ok(!texts.includes('ODT catalog namesake'));
  } finally {
    delete globalThis.devicePixelRatio;
  }
});
