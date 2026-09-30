import test from 'node:test';
import assert from 'node:assert/strict';

import { loadGlobe } from './load_globe.mjs';
const { GlobeController } = await loadGlobe();

test('failed propagation removes the last good point instead of freezing a false position', () => {
  globalThis.window = {};
  const globe = new GlobeController({}, {}, { sunElement: {} });
  globe.updateSunIndicator = () => {};
  globe.records.set('1', { item: {} });
  globe.positions.set('1', { altitude: 400 });
  globe.entities.set('1', { show: true });
  globe.labels.set('1', { show: true });
  globe.selectedId = '1';
  globe.selectedPath = { polyline: { show: true } };
  globe.update(new Date(1000));
  assert.equal(globe.positions.has('1'), false);
  assert.equal(globe.entities.get('1').show, false);
  assert.equal(globe.labels.get('1').show, false);
  assert.equal(globe.selectedPath.polyline.show, false);
});

test('Cesium lighting clock follows the same paused UTC as propagated positions', () => {
  globalThis.window = { Cesium: { JulianDate: { fromDate: date => date.getTime() } } };
  const globe = new GlobeController({}, {}, { sunElement: {} });
  globe.viewer = { clock: { currentTime: 999, shouldAnimate: true }, scene: { requestRender() {} } };
  globe.updateSunIndicator = () => {};
  globe.update(new Date(0));
  assert.equal(globe.viewer.clock.currentTime, 0);
  assert.equal(globe.viewer.clock.shouldAnimate, false);
});

test('selecting a satellite uses the analysis cursor rather than wall clock or stale cache', () => {
  globalThis.window = {};
  const at = new Date(0);
  let received;
  const globe = new GlobeController({}, {}, { sunElement: {}, onSelect: (_, p) => { received = p; } });
  globe.currentDate = at;
  globe.records.set('1', { item: {} });
  globe.positions.set('1', { altitude: 999 });
  globe.positionAt = (_, date) => { assert.equal(date, at); return { altitude: 400 }; };
  globe.select('1', false);
  assert.deepEqual(received, { altitude: 400 });
});

test('home framing fits Earth and LEO shell even in a wide short viewport', () => {
  let altitude;
  globalThis.window = { Cesium: { Cartesian3: { fromDegrees: (_x, _y, z) => { altitude = z; return {}; } }, Math: { toRadians: d => d * Math.PI / 180 } } };
  const globe = new GlobeController({}, {}, { sunElement: {} });
  globe.viewer = { scene: { canvas: { clientWidth: 680, clientHeight: 265 } }, camera: { frustum: { fov: Math.PI / 3 }, flyTo: () => {} } };
  globe.home();
  assert.ok(altitude > 30_000_000 && altitude < 45_000_000, `wide view needs adequate distance, received ${altitude}`);
});

test('selecting invalid orbital elements clears the previous satellite trajectory immediately', () => {
  globalThis.window = { Cesium: {} };
  const globe = new GlobeController({}, {}, { sunElement: {} });
  globe.records.set('2', { item: { MEAN_MOTION: null } });
  globe.selectedPath = { polyline: { show: true } };
  globe.rebuildPath('2', new Date(0));
  assert.equal(globe.selectedPath.polyline.show, false);
});

test('pass sampling reports unavailable future states rather than claiming complete coverage', () => {
  const globe = new GlobeController({}, {}, { sunElement: {} });
  globe.currentDate = new Date(0);
  globe.positionAt = (_, date) => date.getTime() === 0 ? { latitude: 0, longitude: 0, altitude: 500 } : null;
  let missing = 0, total = 0;
  const result = globe.predictPasses('1', 'SEOUL', 1, { onSample: position => { total++; if (!position) missing++; } });
  assert.equal(result.length, 0);
  assert.ok(missing > 100);
  assert.equal(total - missing, 1);
});

test('catalog filters hide unrelated globe points while keeping the selection available', () => {
  const globe = new GlobeController({}, {}, { sunElement: {} });
  for (const id of ['1', '2', '3']) { globe.entities.set(id, {show: true}); globe.positions.set(id, {}); }
  globe.selectedId = '3';
  assert.equal(typeof globe.setVisibleSatellites, 'function');
  globe.setVisibleSatellites(['1']);
  assert.equal(globe.entities.get('1').show, true);
  assert.equal(globe.entities.get('2').show, false);
  assert.equal(globe.entities.get('3').show, true);
});

test('2D morph completion restores north-up axes and disables planar rotation without disabling pan', async () => {
  const listeners = new Set();
  class Cartesian3 { constructor(x, y, z) { Object.assign(this, { x, y, z }); } }
  globalThis.window = { Cesium: { Cartesian3, Matrix4: { IDENTITY: 'world' }, SceneMode: { SCENE3D: 3, SCENE2D: 2, MORPHING: 0 } } };
  const globe = new GlobeController({}, {}, { sunElement: {} });
  const camera = { cancelFlight() {}, lookAtTransform(frame) { this.transform = frame; }, up: { x: 0.5, y: 0.8, z: 0 } };
  const scene = {
    mode: 3, screenSpaceCameraController: { enableRotate: true, enableTranslate: true, enableTilt: true }, requestRender() {},
    morphComplete: { addEventListener(fn) { listeners.add(fn); return () => listeners.delete(fn); } },
    morphTo2D() { this.mode = 0; },
    morphTo3D() { this.mode = 0; },
  };
  globe.viewer = { scene, camera };
  const pending = globe.setSceneMode('2d');
  assert.equal(scene.mode, 0);
  scene.mode = 2;
  for (const done of [...listeners]) done();
  await pending;
  assert.deepEqual({ ...camera.up }, { x: 0, y: 1, z: 0 });
  assert.deepEqual({ ...camera.direction }, { x: 0, y: 0, z: -1 });
  assert.equal(camera.transform, 'world');
  assert.equal(scene.screenSpaceCameraController.enableRotate, false);
  assert.equal(scene.screenSpaceCameraController.enableTilt, false);
  assert.equal(scene.screenSpaceCameraController.enableTranslate, true);
  assert.equal(listeners.size, 0, 'the one-shot morph callback is removed');
  const back = globe.setSceneMode('3d');
  scene.mode = 3;
  for (const done of [...listeners]) done();
  await back;
  assert.equal(scene.screenSpaceCameraController.enableRotate, true);
  assert.equal(scene.screenSpaceCameraController.enableTilt, true);
});

test('2D home uses full-map framing rather than a 3D perspective distance', () => {
  globalThis.window = { Cesium: { SceneMode: { SCENE2D: 2, SCENE3D: 3, MORPHING: 0 }, Cartesian3: { fromDegrees() {} }, Math: { toRadians: value => value } } };
  const globe = new GlobeController({}, {}, { sunElement: {} });
  let duration;
  globe.viewer = { scene: { mode: 2, canvas: { clientWidth: 800, clientHeight: 400 } }, camera: { frustum: {}, flyTo() {}, flyHome(value) { duration = value; } } };
  globe.home(0.5);
  assert.equal(duration, 0.5);
});

test('a trajectory that could not be rebuilt stays hidden on later update ticks instead of re-showing the previous body', () => {
  globalThis.window = { Cesium: { Cartesian3: { fromDegrees: () => ({}) }, Color: { fromCssColorString: () => ({ withAlpha: () => 'colour' }) }, ArcType: { NONE: 0 } } };
  const globe = new GlobeController({}, {}, { sunElement: {} });
  globe.updateSunIndicator = () => {};
  globe.viewer = { entities: { add: entity => entity }, scene: { requestRender() {} } };
  globe.records.set('1', { item: { MEAN_MOTION: 15 } });
  globe.records.set('2', { item: { MEAN_MOTION: null } });
  globe.positionAt = () => ({ longitude: 0, latitude: 0, altitude: 500 });
  globe.selectedId = '1';
  globe.rebuildPath('1', new Date(0));
  assert.equal(globe.selectedPath.polyline.show, true);
  assert.equal(globe.selectedPathId, '1');
  globe.selectedId = '2';
  globe.rebuildPath('2', new Date(0));
  assert.equal(globe.selectedPathPositions.length, 0, 'the previous body\'s points are dropped when the rebuild bails');
  globe.update(new Date(1000));
  assert.equal(globe.selectedPath.polyline.show, false, 'the per-second update must not resurrect the old line');
  assert.equal(globe.toggleTracks(), false);
  assert.equal(globe.toggleTracks(), true);
  assert.equal(globe.selectedPath.polyline.show, false);
  globe.selectedId = '1';
  globe.rebuildPath('1', new Date(2000));
  globe.update(new Date(3000));
  assert.equal(globe.selectedPath.polyline.show, true);
});
