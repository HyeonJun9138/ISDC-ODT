import test from 'node:test';
import assert from 'node:assert/strict';
import { SatelliteModelLayer } from '../../../digital_twin/visualization/satellite_model.js';

// Cesium is a WebGL boundary. Keep projection inputs and the documented 2D
// setView contract visible: destination height controls orthographic map width.
function fixture() {
  let motionMs = 0;
  const frames = new Set();
  class Cartesian3 {
    constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
    static fromDegrees(x, y, z) { return new Cartesian3(x, y, z); }
    static clone(a) { return new Cartesian3(a.x, a.y, a.z); }
    static subtract(a, b, out) { Object.assign(out, { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }); return out; }
    static magnitude(a) { return Math.hypot(a.x, a.y, a.z); }
    static multiplyByScalar(a, n, out) { Object.assign(out, { x: a.x * n, y: a.y * n, z: a.z * n }); return out; }
    static normalize(a, out) { return this.multiplyByScalar(a, 1 / this.magnitude(a), out); }
    static dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
    static cross(a, b, out) { Object.assign(out, { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }); return out; }
  }
  const Cesium = {
    Cartesian3, SceneMode: { MORPHING: 0, SCENE2D: 2, SCENE3D: 3 }, Matrix4: { IDENTITY: 'world' },
    HeadingPitchRange: class { constructor(heading, pitch, range) { Object.assign(this, { heading, pitch, range }); } },
    Math: { toRadians: degrees => degrees * Math.PI / 180 },
    Transforms: { eastNorthUpToFixedFrame: here => ({ here }) },
  };
  const views = [];
  const camera = {
    position: new Cartesian3(100, 200, 8_000_000), direction: new Cartesian3(0, 0, -1),
    up: new Cartesian3(-0.5, 0.8, 0), right: new Cartesian3(0.8, 0.5, 0),
    frustum: { left: -1_000_000, right: 1_000_000, top: 500_000, bottom: -500_000 },
    cancelFlight() {}, lookAtTransform(frame) { this.transform = frame; }, lookAt() {},
    setView(options) {
      views.push(options);
      const width = options.destination.z;
      this.frustum = { left: -width / 2, right: width / 2, top: width / 4, bottom: -width / 4 };
    },
  };
  const viewer = { camera, scene: { mode: 2, preUpdate: { addEventListener(fn) { frames.add(fn); return () => frames.delete(fn); } } } };
  const layer = new SatelliteModelLayer({ viewer, cesium: Cesium, timeSource: () => new Date(0), motionNow: () => motionMs });
  layer.positionAt = date => date.getTime() < 0 ? null : { longitude: date.getTime() ? -179.9 : 179.9, latitude: 40, altitude: 420 };
  return { layer, viewer, camera, views, advance(ms = 3000) {
    for (let elapsed = 0; elapsed < ms;) { const dt = Math.min(16, ms - elapsed); motionMs += dt; elapsed += dt; for (const frame of [...frames]) frame(); }
  } };
}

test('2D focus uses a north-up geographic map view, not the 3D body heading or metre-scale range', () => {
  const { layer, camera, views, advance } = fixture();
  assert.equal(layer.focus(new Date(0)), true);
  assert.equal(views.length, 0, 'focus is queued, not a teleport');
  advance();
  assert.equal(layer.tracking, true);
  assert.equal(views.at(-1)?.destination.x, 179.9);
  assert.equal(views.at(-1).destination.y, 40);
  assert.ok(views.at(-1).destination.z >= 100_000, 'retain map context instead of a 20 m body close-up');
  assert.deepEqual({ ...camera.up }, { x: 0, y: 1, z: 0 });
  assert.deepEqual({ ...camera.direction }, { x: 0, y: 0, z: -1 });
  assert.equal(camera.transform, 'world');
});

test('2D wheel zoom reduces the orthographic width around the selected longitude, even across Earth', () => {
  const { layer, camera, views, advance } = fixture();
  // A planar map must not use the 3D Earth-occlusion / camera-forward predicate.
  assert.equal(layer.zoomBy(120), true);
  assert.equal(layer.tracking, true);
  assert.equal(views.length, 0, 'input does not snap the map to a new width');
  advance();
  assert.equal(views.at(-1).destination.x, 179.9);
  assert.equal(views.at(-1).destination.y, 40);
  const width = camera.frustum.right - camera.frustum.left;
  assert.ok(width > 1_600_000 && width < 1_800_000);
  assert.equal(camera.frustum.top / camera.frustum.right, 0.5, 'aspect ratio stays unchanged');
  layer.zoomBy(-120);
  advance();
  assert.ok(Math.abs(camera.frustum.right - camera.frustum.left - 2_000_000) < 1e-6);
});

test('2D following recentres across the date line without changing the map scale or north-up axes', () => {
  const { layer, camera, views } = fixture();
  layer.tracking = true;
  layer.update(new Date(1000));
  assert.equal(views.at(-1)?.destination.x, -179.9);
  assert.equal(views.at(-1).destination.y, 40);
  assert.equal(views.at(-1).destination.z, 2_000_000);
  assert.deepEqual({ ...camera.up }, { x: 0, y: 1, z: 0 });
});

test('2D zoom-out without following and unavailable target leave the ordinary map camera alone', () => {
  const { layer, views } = fixture();
  assert.equal(layer.zoomBy(-120), false);
  layer.positionAt = () => null;
  assert.equal(layer.zoomBy(120), false);
  assert.equal(layer.focus(new Date(0)), false);
  assert.equal(views.length, 0);
});

test('wheel, pending focus and frame updates do not mutate the camera during scene morphing', () => {
  const { layer, viewer, views } = fixture();
  viewer.scene.mode = 0;
  assert.equal(layer.focus(new Date(0)), false);
  assert.equal(layer.zoomBy(120), true, 'consume the wheel without entering either camera calculation');
  layer.tracking = true;
  layer.update(new Date(0));
  assert.equal(views.length, 0);
});

test('releasing a 2D follow target never starts a 3D Earth-facing flight', () => {
  const { layer, camera } = fixture();
  layer.tracking = true;
  camera.positionWC = { x: 10, y: 20, z: 30 };
  camera.upWC = { x: 0, y: 1, z: 0 };
  camera.flyTo = () => assert.fail('2D release must preserve the current planar view');
  layer.untrack({ aimAtEarth: true });
  assert.equal(layer.tracking, false);
});

test('a direct 2D drag releases following without jumping to the unfinished focus endpoint', () => {
  const { layer, camera, views, advance } = fixture();
  camera.positionCartographic = { longitude: 0, latitude: 0 };
  layer.focus(new Date(0)); advance(160);
  const before = views.at(-1).destination.x;
  assert.ok(before > 0 && before < 179);
  assert.equal(typeof layer.interruptCamera, 'function');
  layer.interruptCamera();
  const count = views.length;
  advance();
  assert.equal(views.length, count, 'the user now owns map panning');
  assert.equal(views.at(-1).destination.x, before);
  assert.equal(layer.tracking, false);
});
