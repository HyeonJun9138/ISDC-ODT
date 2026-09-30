import test from 'node:test';
import assert from 'node:assert/strict';

// A selected body's trajectory hugs the globe at LEO altitude inside a cloud of ~16k same-coloured
// points, so the line was drawn but never seen. Selection now dims every other point and the line
// carries a dark outline, which is what makes the trajectory legible against the catalogue.

import { loadGlobe } from './load_globe.mjs';
const { GlobeController } = await loadGlobe();

const colour = (css, alpha = 1) => ({ css, alpha, withAlpha(next) { return colour(css, next); } });
class CallbackProperty {
  constructor(getter, isConstant) { this.getter = getter; this.isConstant = isConstant; }
  getValue() { return this.getter(); }
}
class PolylineOutlineMaterialProperty { constructor(options) { Object.assign(this, options); } }
class PolylineCollection {
  constructor() { this.items = []; }
  add(options) { const line = { show: true, ...options }; this.items.push(line); return line; }
}
const dimmed = alpha => alpha >= .5 && alpha < .7;

function globeWithCatalog() {
  globalThis.window = {
    Cesium: {
      Cartesian3: { fromDegrees: (lon, lat, h) => ({ lon, lat, h }) },
      Cartesian2: class { constructor(x, y) { this.x = x; this.y = y; } },
      NearFarScalar: class { constructor(near, nearValue, far, farValue) { Object.assign(this, { near, nearValue, far, farValue }); } },
      LabelStyle: { FILL_AND_OUTLINE: 1 },
      Color: { fromCssColorString: colour, WHITE: colour('white'), TRANSPARENT: colour('transparent', 0) },
      ArcType: { NONE: 0 },
      CallbackProperty,
      PolylineOutlineMaterialProperty,
      PolylineCollection,
      Material: { ColorType: 'Color', fromType: (type, uniforms) => ({ type, ...uniforms }) },
    },
  };
  const globe = new GlobeController({ style: {} }, {}, { sunElement: {} });
  const added = [];
  globe.viewer = {
    entities: { add(entity) { added.push(entity); return entity; }, removeAll() {} },
    scene: { requestRender() {}, canvas: { style: {} }, primitives: { add: primitive => primitive, remove() {} }, globe: { enableLighting: true, dynamicAtmosphereLighting: true, baseColor: null } },
  };
  globe.items = [
    { OBJECT_NAME: 'A', ORBIT_REGIME: 'LEO', MEAN_MOTION: 15 },
    { OBJECT_NAME: 'B', ORBIT_REGIME: 'LEO', MEAN_MOTION: 15 },
    { OBJECT_NAME: 'C', ORBIT_REGIME: 'GEO', MEAN_MOTION: 1 },
  ];
  globe.items.forEach((item, index) => {
    const id = String(index + 1);
    globe.records.set(id, { item, record: null, index });
    globe.entities.set(id, { color: colour('#ff9f43', .98), pixelSize: 6.5, outlineWidth: 0, show: true, position: null });
  });
  globe.positionAt = () => ({ longitude: 0, latitude: 0, altitude: 500, velocity: 7.6 });
  globe.elevationAt = () => 80;
  return { globe, added };
}

const alphaOf = (globe, id) => globe.entities.get(id).color.alpha;

test('selecting a body dims every other point, switching re-dims the previous one and clearing restores them', () => {
  const { globe } = globeWithCatalog();
  globe.select('1', false);
  assert.equal(alphaOf(globe, '1'), 1, 'the selected point keeps its full highlight colour');
  assert.ok(dimmed(alphaOf(globe, '2')), `other points are dimmed but stay readable, alpha ${alphaOf(globe, '2')}`);
  assert.ok(dimmed(alphaOf(globe, '3')), 'dimming applies regardless of orbit class');
  globe.select('2', false);
  assert.equal(alphaOf(globe, '2'), 1);
  assert.ok(dimmed(alphaOf(globe, '1')), 'the previously selected point joins the dimmed background');
  globe.clearSelection();
  assert.equal(alphaOf(globe, '1'), .98, 'no selection: the catalogue alpha comes back');
  assert.equal(alphaOf(globe, '2'), .98);
  assert.equal(alphaOf(globe, '3'), .98);
});

test('hovering a dimmed point brightens it and leaving it re-dims it', () => {
  const { globe } = globeWithCatalog();
  globe.select('1', false);
  globe.setHovered('3', null);
  assert.equal(alphaOf(globe, '3'), 1);
  globe.setHovered(null, null);
  assert.ok(dimmed(alphaOf(globe, '3')));
});

test('a point added while a body is selected starts dimmed', () => {
  const { globe } = globeWithCatalog();
  globe.pointCollection = { add: options => options };
  globe.labelCollection = { add: options => options };
  globe.select('1', false);
  const item = { OBJECT_NAME: 'D', ORBIT_REGIME: 'LEO' };
  globe.records.set('4', { item, record: null, index: 3 });
  globe.addCesiumEntity('4', item, 3);
  assert.ok(dimmed(alphaOf(globe, '4')), `alpha ${alphaOf(globe, '4')}`);
  globe.clearSelection();
  assert.equal(alphaOf(globe, '4'), .98);
});

test('the trajectory is a wide outlined line in the selected colour of the current theme', () => {
  const { globe, added } = globeWithCatalog();
  globe.select('1', false);
  const path = added.find(entity => entity.id === 'selected-orbit-path');
  assert.ok(path, 'the trajectory entity exists');
  assert.ok(path.polyline.width >= 3, `width ${path.polyline.width}`);
  assert.ok(path.polyline.material instanceof PolylineOutlineMaterialProperty, 'outline material separates the line from the point cloud');
  assert.equal(path.polyline.material.color.css, '#efff62');
  assert.ok(path.polyline.material.outlineWidth > 0);
  globe.setTheme('light');
  assert.ok(path.polyline.material instanceof PolylineOutlineMaterialProperty);
  assert.equal(path.polyline.material.color.css, '#d35400', 'the light palette recolours the outlined line');
});

test('SDC mode changes opacity only, preserving original point size, outline and selection geometry', () => {
  const { globe } = globeWithCatalog();
  globe.records.get('1').item.node = true;
  globe.records.get('2').item.node = true;
  globe.records.get('2').item.EPOCH_AGE_HOURS = 96;
  globe.items = Array(16_000).fill({});
  globe.select('1', false);
  const before = new Map([...globe.entities].map(([id, point]) => [id, { ...point }]));
  globe.setSdcMode(true);
  for (const [id, point] of globe.entities) {
    for (const key of ['pixelSize', 'outlineWidth', 'scaleByDistance']) {
      assert.equal(point[key], before.get(id)[key], `${id}: SDC must not change ${key}`);
    }
  }
  const node = globe.entities.get('2');
  assert.equal(node.color.alpha, 1, 'SDC background points stay opaque without getting larger');
  assert.equal(alphaOf(globe, '3'), before.get('3').color.alpha, 'ordinary satellite opacity is unaffected by the SDC toggle');
  globe.setHovered('2', null);
  globe.setHovered(null, null);
  assert.equal(node.pixelSize, before.get('2').pixelSize);
  assert.equal(node.outlineWidth, 0);
  assert.equal(node.color.alpha, 1);
  globe.setTheme('light');
  assert.equal(node.color.alpha, 1);
  globe.setSdcMode(false);
  assert.equal(node.color.alpha, before.get('2').color.alpha);
  assert.equal(node.pixelSize, before.get('2').pixelSize);
  assert.equal(globe.entities.get('1').pixelSize, before.get('1').pixelSize);
});

test('nodes added in SDC mode retain original marker geometry and Earth occlusion', () => {
  const { globe } = globeWithCatalog();
  globe.items = Array(16_000).fill({});
  globe.pointCollection = { add: options => options };
  globe.labelCollection = { add: options => options };
  globe.setSdcMode(true);
  const item = { OBJECT_NAME: 'SDC-NODE', ORBIT_REGIME: 'LEO', node: true };
  globe.records.set('4', { item, record: null, index: 3 });
  globe.addCesiumEntity('4', item, 3);
  const node = globe.entities.get('4');
  assert.equal(node.pixelSize, 2.4);
  assert.equal(node.color.alpha, 1);
  assert.equal(node.outlineWidth, 0);
  assert.equal(node.scaleByDistance.farValue, .58);
  assert.equal(node.disableDepthTestDistance, 0);
  globe.select('4', false);
  assert.equal(node.pixelSize, 8, 'retain original selection size');
  assert.equal(node.outlineWidth, 0);
  globe.clearSelection();
  assert.equal(node.pixelSize, 2.4);
  assert.equal(node.color.alpha, 1);
});

test('catalog size and zoom scaling stay at their original values; only point opacity increases modestly', () => {
  const { globe } = globeWithCatalog();
  globe.pointCollection = { add: options => options };
  globe.labelCollection = { add: options => options };
  const item = { OBJECT_NAME: 'CATALOG', ORBIT_REGIME: 'LEO' };
  globe.records.set('4', { item, record: null, index: 3 });
  for (const [count, originalSize] of [[16_000, 2.4], [3000, 3], [300, 4.5], [40, 6.5]]) {
    globe.items = Array(count).fill({});
    globe.addCesiumEntity('4', item, 3);
    const point = globe.entities.get('4');
    assert.equal(point.pixelSize, originalSize);
    assert.equal(point.outlineWidth, 0, 'no white rings over the globe');
    assert.equal(point.scaleByDistance.nearValue, 1.35);
    assert.equal(point.scaleByDistance.farValue, .58);
  }
  globe.items = Array(16_000).fill({});
  globe.select('1', false);
  assert.ok(alphaOf(globe, '4') >= .5 && alphaOf(globe, '4') <= .65, 'slightly stronger opacity, not the overly bright 0.72 revision');
  assert.equal(globe.entities.get('4').pixelSize, 2.4);
  assert.equal(globe.entities.get('4').outlineWidth, 0);
});
