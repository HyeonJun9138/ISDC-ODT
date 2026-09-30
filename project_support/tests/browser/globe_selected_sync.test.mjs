import test from 'node:test';
import assert from 'node:assert/strict';

import { loadGlobe } from './load_globe.mjs';
const { GlobeController } = await loadGlobe();

class CallbackProperty {
  constructor(getter, isConstant) { this.getter = getter; this.isConstant = isConstant; }
  getValue() { return this.getter(); }
}
const positionsOf = entity => (entity.polyline.positions.getValue ? entity.polyline.positions.getValue() : entity.polyline.positions);
class PolylineCollection {
  constructor() { this.items = []; }
  add(options) { const line = { show: true, ...options }; this.items.push(line); return line; }
}
const primitivesMock = () => ({ items: [], add(primitive) { this.items.push(primitive); return primitive; }, remove(primitive) { this.items = this.items.filter(p => p !== primitive); } });
class Material {
  constructor({ fabric, translucent }) { this.fabric = fabric; this.translucent = translucent; this.uniforms = fabric.uniforms; }
  static fromType(type, uniforms) { return { type, ...uniforms }; }
}
Material.ColorType = 'Color';

function globeWithSelection() {
  globalThis.window = {
    Cesium: {
      Cartesian3: { fromDegrees: (lon, lat, h) => ({ lon, lat, h }), distance: (a, b) => Math.abs(a.h - b.h) },
      Color: { fromCssColorString: css => ({ css, withAlpha: alpha => ({ css, alpha }) }) },
      ArcType: { NONE: 0 },
      CallbackProperty,
      PolylineCollection,
      Material,
    },
  };
  const globe = new GlobeController({}, {}, { sunElement: {} });
  const added = [];
  globe.viewer = { entities: { add(entity) { added.push(entity); return entity; }, removeAll() {} }, scene: { requestRender() {}, primitives: primitivesMock() } };
  globe.selectedId = '1';
  globe.records.set('1', { item: {} });
  globe.entities.set('1', { position: null, show: true });
  globe.labels.set('1', { position: null, show: true });
  globe.selectedLabel = { position: null, show: true };
  globe.positionAt = (_, date) => ({ longitude: 126.9, latitude: 37.5, altitude: 400 + date.getTime() / 1000, velocity: 7.6 });
  globe.elevationAt = () => 80;
  return { globe, added };
}

test('per-frame sync moves the marker, labels and observer line onto the propagated position', () => {
  const { globe, added } = globeWithSelection();
  globe.syncSelected(new Date(0));
  assert.deepEqual(globe.entities.get('1').position, { lon: 126.9, lat: 37.5, h: 400_000 });
  assert.deepEqual(globe.labels.get('1').position, { lon: 126.9, lat: 37.5, h: 400_000 });
  assert.deepEqual(globe.selectedLabel.position, { lon: 126.9, lat: 37.5, h: 400_000 });
  assert.equal(added.length, 0, 'the observer line is not an entity: entity lines are evaluated before the per-frame body sync');
  const link = globe.stationLink;
  assert.equal(link.id, 'selected-station-link');
  assert.equal(globe.viewer.scene.primitives.items[0], globe.stationLinkCollection, 'the line lives in a primitive collection');
  assert.equal(link.positions[0].h, 400_000);
  globe.syncSelected(new Date(1000));
  assert.equal(globe.stationLinkCollection.items.length, 1, 'the observer line is reused instead of recreated every frame');
  assert.equal(link.positions[0].h, 401_000);
  assert.equal(link.show, true);
  assert.equal(globe.positions.get('1').altitude, 401);
});

test('the observer line hides below the elevation mask and when tracks are switched off', () => {
  const { globe, added } = globeWithSelection();
  globe.syncSelected(new Date(0));
  const link = globe.stationLink;
  globe.elevationAt = () => -10;
  globe.syncSelected(new Date(1000));
  assert.equal(link.show, false);
  globe.elevationAt = () => 45;
  globe.syncSelected(new Date(2000));
  assert.equal(link.show, true);
  assert.equal(globe.toggleTracks(), false);
  assert.equal(link.show, false);
  assert.equal(globe.toggleTracks(), true);
  assert.equal(link.show, true);
  assert.equal(globe.stationLinkCollection.items.length, 1);
});

test('a failed propagation leaves the marker alone for the once-per-second update to hide', () => {
  const { globe, added } = globeWithSelection();
  globe.syncSelected(new Date(0));
  globe.positionAt = () => null;
  globe.syncSelected(new Date(1000));
  assert.equal(globe.stationLink.positions[0].h, 400_000);
  assert.equal(globe.positions.get('1').altitude, 400);
});

test('the trajectory is sampled one second apart around the reference time and coarsely elsewhere', () => {
  const { globe, added } = globeWithSelection();
  const sampled = [];
  const reference = new Date(600_000);
  globe.records.set('1', { item: { MEAN_MOTION: 15 } }); // 96 minute period
  globe.positionAt = (_, date) => { sampled.push(date.getTime() - reference.getTime()); return { longitude: 0, latitude: 0, altitude: 500 }; };
  globe.rebuildPath('1', reference);
  assert.ok(sampled.includes(0), 'the body position at the reference time is on the line');
  const dense = sampled.filter(offset => Math.abs(offset) <= 45_000);
  assert.equal(dense.length, 901, 'ten samples per second inside the 90 second dense window');
  const coarse = sampled.filter(offset => Math.abs(offset) > 45_000);
  assert.ok(coarse.length >= 110 && coarse.length <= 121, `coarse samples cover the rest of the period, received ${coarse.length}`);
  assert.ok(Math.min(...sampled) <= -96 * 30_000 + 1 && Math.max(...sampled) >= 96 * 30_000 - 48_000, 'the line spans a full period');
  assert.deepEqual(sampled, [...sampled].sort((a, b) => a - b), 'samples are in time order');
  const path = added.find(entity => entity.id === 'selected-orbit-path');
  assert.equal(positionsOf(path).length, sampled.length);
  assert.equal(path.polyline.positions.isConstant, false);
  globe.rebuildPath('1', new Date(700_000));
  assert.equal(added.filter(entity => entity.id === 'selected-orbit-path').length, 1, 'rebuilding reuses the entity');
});

test('switching to the light theme recolours points, labels and the trajectory and lifts the imagery', () => {
  const colour = css => ({ css, withAlpha(alpha) { return { css, alpha }; } });
  globalThis.window = {
    Cesium: {
      Cartesian3: { fromDegrees: (lon, lat, h) => ({ lon, lat, h }) },
      Color: { fromCssColorString: colour },
      ArcType: { NONE: 0 },
    },
  };
  const globe = new GlobeController({}, {}, { sunElement: {} });
  const scene = { globe: { enableLighting: true, dynamicAtmosphereLighting: true, baseColor: null }, requestRender() {} };
  globe.viewer = { scene, entities: { add(entity) { return entity; } } };
  globe.imageryLayer = { brightness: .56, contrast: 1.28, saturation: .5, gamma: .88 };
  globe.items = [{ ORBIT_REGIME: 'LEO' }, { ORBIT_REGIME: 'MEO' }];
  globe.records.set('1', { item: { ORBIT_REGIME: 'LEO' } });
  globe.records.set('2', { item: { ORBIT_REGIME: 'MEO' } });
  globe.entities.set('1', { color: null, pixelSize: 0, outlineWidth: 0 });
  globe.entities.set('2', { color: null, pixelSize: 0, outlineWidth: 0 });
  globe.labels.set('1', { fillColor: null });
  globe.selectedId = '1';
  globe.selectedLabel = { fillColor: null };
  globe.selectedPath = { polyline: { material: null } };
  globe.setTheme('light');
  assert.equal(globe.theme, 'light');
  assert.equal(scene.globe.enableLighting, false, 'no day/night shading in light mode');
  assert.ok(globe.imageryLayer.brightness > 1, 'imagery is lifted, not dimmed');
  assert.equal(scene.globe.baseColor.css, '#c9d6e3');
  assert.equal(globe.entities.get('2').color.css, '#8f8a12', 'MEO points use the darker light-mode colour');
  assert.equal(globe.entities.get('1').color.css, '#d35400', 'the selected point keeps its selected colour');
  assert.equal(globe.labels.get('1').fillColor.css, '#d35400');
  assert.equal(globe.selectedLabel.fillColor.css, '#d35400');
  assert.equal(globe.selectedPath.polyline.material.css, '#d35400');
  globe.setTheme('dark');
  assert.equal(scene.globe.enableLighting, true);
  assert.ok(globe.imageryLayer.brightness < 1, 'the dark scene restores the emphasis dimming');
  assert.equal(globe.entities.get('2').color.css, '#e6ed55');
  assert.equal(globe.selectedPath.polyline.material.css, '#efff62');
  globe.setTheme('nonsense');
  assert.equal(globe.theme, 'dark', 'unknown themes fall back to dark');
});

test('clearing the selection restores the plain point and hides the highlighted label, trajectory and observer line', () => {
  const { globe, added } = globeWithSelection();
  globalThis.window.Cesium.Color.WHITE = 'white';
  globe.items = [{ ORBIT_REGIME: 'LEO' }];
  globe.syncSelected(new Date(0));
  globe.selectedPath = { polyline: { show: true } };
  globe.entities.get('1').pixelSize = 21;
  globe.clearSelection();
  assert.equal(globe.selectedId, null);
  assert.equal(globe.entities.get('1').pixelSize, globe.basePointSize(), 'the point falls back to the catalogue style');
  assert.equal(globe.labels.get('1').show, false);
  assert.equal(globe.labels.get('1').fillColor, 'white');
  assert.equal(globe.selectedLabel.show, false);
  assert.equal(globe.selectedPath.polyline.show, false);
  assert.equal(globe.stationLink.show, false, 'the observer line is hidden');
  globe.clearSelection();
  assert.equal(globe.selectedId, null, 'clearing twice is harmless');
});

test('the observer line carries flowing packets spaced in screen pixels whose phase advances each frame', () => {
  const { globe } = globeWithSelection();
  const listeners = [];
  globe.viewer.scene.preUpdate = { addEventListener(fn) { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); } };
  globe.syncSelected(new Date(0));
  const link = globe.stationLink;
  assert.equal(link.material.fabric.type, 'SpaceTwinLinkFlow');
  assert.match(link.material.fabric.source, /czm_getMaterial/);
  assert.equal(link.material.translucent, true);
  assert.match(link.material.fabric.source, /v_polylineAngle/, 'spacing is measured along the line in screen space, like PolylineDash');
  assert.match(link.material.fabric.source, /dFdx\(s\)/, 'the screen derivative of st.s fixes the body-to-station direction');
  assert.equal(link.material.uniforms.spacing, 96);
  globe.positionAt = () => ({ longitude: 126.9, latitude: 37.5, altitude: 1600, velocity: 7.6 });
  globe.syncSelected(new Date(1000));
  assert.equal(listeners.length, 1, 'one per-frame animator is registered for the line');
  globe.animateStationLink(2500);
  assert.equal(link.material.uniforms.time, 3.5, '2.5 s at 1.4 cycles per second');
  const before = link.material.uniforms.time;
  globe.elevationAt = () => -5;
  globe.syncSelected(new Date(2000));
  globe.animateStationLink(9000);
  assert.equal(link.material.uniforms.time, before, 'a hidden line is not animated');
});
