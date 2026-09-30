import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGlobe } from './load_globe.mjs';
const { GlobeController } = await loadGlobe();

class Vector {
  constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
  static ZERO = new Vector();
  static fromDegrees(x, y, z) { return new Vector(x, y, z); }
  static clone(v) { return new Vector(v.x, v.y, v.z); }
  static magnitude(v) { return Math.hypot(v.x, v.y, v.z); }
  static magnitudeSquared(v) { return this.magnitude(v) ** 2; }
  static multiplyByScalar(v, s, out) { return Object.assign(out, { x: v.x * s, y: v.y * s, z: v.z * s }); }
  static subtract(a, b, out) { return Object.assign(out, { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }); }
  static add(a, b, out) { return Object.assign(out, { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }); }
  static normalize(v, out) { return this.multiplyByScalar(v, 1 / this.magnitude(v), out); }
  static cross(a, b, out) { return Object.assign(out, { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }); }
}
function fixture() {
  let time = 0;
  globalThis.window = { Cesium: {
    Cartesian3: Vector, SceneMode: { MORPHING: 0, SCENE2D: 2, SCENE3D: 3 }, Matrix4: { IDENTITY: 'world' },
    CameraEventType: { PINCH: 1 }, ScreenSpaceEventType: { WHEEL: 2 }, Math: { EPSILON10: 1e-10, toRadians: d => d * Math.PI / 180 },
  } };
  const inputs = new Map(), frames = new Set(), flights = [];
  const canvas = new EventTarget(); canvas.clientWidth = 1000; canvas.clientHeight = 700;
  const camera = {
    positionWC: new Vector(0, 0, 30_000_000), directionWC: new Vector(.1, 0, -1), upWC: new Vector(0, 1, 0), rightWC: new Vector(1, 0, 0),
    frustum: { left: -1_000_000, right: 1_000_000, top: 500_000, bottom: -500_000, fov: Math.PI / 3 },
    cancelFlight() {}, setView({ destination, orientation }) { this.positionWC = destination; this.directionWC = orientation.direction; this.upWC = orientation.up; },
    flyTo(options) { flights.push(options); }, flyHome() {},
    zoomIn(amount) { this.frustum.left += amount / 2; this.frustum.right -= amount / 2; },
    zoomOut(amount) { this.zoomIn(-amount); },
  };
  const scene = { camera, canvas, mode: 3, screenSpaceCameraController: {}, requestRender() {},
    preUpdate: { addEventListener(fn) { frames.add(fn); return () => frames.delete(fn); } } };
  const globe = new GlobeController({}, {}, { sunElement: {}, motionNow: () => time });
  globe.viewer = { camera, scene, screenSpaceEventHandler: { setInputAction(fn, type) { inputs.set(type, fn); } } };
  globe.installCenteredZoom();
  return { globe, camera, scene, flights, canvas, frames,
    wheel(delta) { inputs.get(2)(delta); },
    advance(ms) { for (let done = 0; done < ms;) { const dt = Math.min(16, ms - done); time += dt; done += dt; for (const fn of [...frames]) fn(); } },
  };
}

test('Earth-centred zoom and orientation ease over frames instead of jumping on the wheel', () => {
  const f = fixture(); f.wheel(120);
  assert.equal(Vector.magnitude(f.camera.positionWC), 30_000_000);
  assert.equal(f.camera.directionWC.x, .1);
  f.advance(16);
  assert.ok(Vector.magnitude(f.camera.positionWC) < 30_000_000 && Vector.magnitude(f.camera.positionWC) > 29_000_000);
  assert.ok(f.camera.directionWC.x > 0 && f.camera.directionWC.x < .1);
  f.advance(3000);
  assert.ok(Math.abs(Vector.magnitude(f.camera.positionWC) - 25_058_106.342338) < 1);
});

test('reverse wheel input and a direct drag take over without residual zoom or camera fighting', () => {
  const f = fixture(); f.wheel(240); f.advance(32);
  const before = Vector.magnitude(f.camera.positionWC);
  f.wheel(-120); f.advance(16);
  assert.ok(Vector.magnitude(f.camera.positionWC) > before);
  let interrupted = 0; f.globe.onCameraInput = () => interrupted++;
  f.canvas.dispatchEvent(new Event('pointerdown'));
  const stopped = Vector.magnitude(f.camera.positionWC);
  f.advance(1000);
  assert.equal(Vector.magnitude(f.camera.positionWC), stopped);
  assert.equal(interrupted, 1);
});

test('2D map wheel changes orthographic width smoothly without rotating the map', () => {
  const f = fixture(); f.scene.mode = 2;
  f.wheel(120);
  assert.equal(f.camera.frustum.right - f.camera.frustum.left, 2_000_000);
  f.advance(16);
  const first = f.camera.frustum.right - f.camera.frustum.left;
  assert.ok(first < 2_000_000 && first > 1_900_000);
  f.advance(3000);
  assert.ok(Math.abs(f.camera.frustum.right - f.camera.frustum.left - 1_670_540.4228) < 1);
  assert.equal(f.camera.directionWC.x, .1, 'orthographic zoom must not apply a globe-facing orientation');
});

test('home and station flights replace wheel motion and release the selected-target owner', () => {
  const f = fixture(); let released = 0; f.globe.onCameraMove = () => released++;
  f.wheel(240); f.advance(16); f.globe.home();
  const before = Vector.magnitude(f.camera.positionWC); f.advance(1000);
  assert.equal(Vector.magnitude(f.camera.positionWC), before);
  assert.equal(released, 1);
  assert.equal(typeof f.flights[0].easingFunction, 'function');
  assert.equal(f.flights[0].easingFunction(0), 0); assert.equal(f.flights[0].easingFunction(1), 1);
  assert.equal(f.globe.flyToStation('SEOUL'), true);
  assert.equal(released, 2);
});

test('selected-body takeover cancels the Earth goal and hidden viewports never advance queued motion', () => {
  const f = fixture(); f.wheel(240); f.advance(16);
  f.globe.wheelOverride = () => true; f.wheel(120);
  const stopped = Vector.magnitude(f.camera.positionWC); f.advance(1000);
  assert.equal(Vector.magnitude(f.camera.positionWC), stopped);
  f.globe.wheelOverride = null; f.wheel(240); f.canvas.clientWidth = 0; f.advance(1000);
  f.canvas.clientWidth = 1000; f.advance(1000);
  assert.equal(Vector.magnitude(f.camera.positionWC), stopped, 'hidden-camera goals are cancelled, not replayed on return');
});

test('user input does not force an unfinished 2D/3D morph to jump to its end', () => {
  const f = fixture();
  assert.equal(f.scene.completeMorphOnUserInput, false);
  f.scene.mode = 0; f.wheel(120); f.advance(100);
  assert.equal(Vector.magnitude(f.camera.positionWC), 30_000_000);
});
