import test from 'node:test';
import assert from 'node:assert/strict';
import { SatelliteModelLayer } from '../../../digital_twin/visualization/satellite_model.js';

class Cartesian3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  static fromDegrees(longitude, latitude, height) { return new Cartesian3(longitude, latitude, height); }
  static clone(v, result = new Cartesian3()) { result.x = v.x; result.y = v.y; result.z = v.z; return result; }
  static subtract(a, b, result) { result.x = a.x - b.x; result.y = a.y - b.y; result.z = a.z - b.z; return result; }
  static magnitude(v) { return Math.hypot(v.x, v.y, v.z); }
  static normalize(v, result) { const m = Cartesian3.magnitude(v); result.x = v.x / m; result.y = v.y / m; result.z = v.z / m; return result; }
  static multiplyByScalar(v, s, result) { result.x = v.x * s; result.y = v.y * s; result.z = v.z * s; return result; }
  static cross(a, b, result) { result.x = a.y * b.z - a.z * b.y; result.y = a.z * b.x - a.x * b.z; result.z = a.x * b.y - a.y * b.x; return result; }
  static dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  static distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
}

function fakeCesium(loads, { occluded = false } = {}) {
  return {
    Cartesian3,
    Matrix3: class { static fromHeadingPitchRoll(hpr) { return { hpr }; } static multiply(a, b) { a.trim = b; return a; } },
    Matrix4: class {
      static fromRotationTranslation(rotation, translation) { return { rotation, translation }; }
      static inverseTransformation(frame) { return { inverseOf: frame }; }
      // The fake ENU frame is a pure translation, so the local offset is world minus origin.
      static multiplyByPoint(inverse, point, result) { return Cartesian3.subtract(point, inverse.inverseOf.enu, result); }
    },
    HeadingPitchRoll: class { constructor(heading, pitch, roll) { Object.assign(this, { heading, pitch, roll }); } },
    HeadingPitchRange: class { constructor(heading, pitch, range) { Object.assign(this, { heading, pitch, range }); } },
    Math: { toRadians: degrees => degrees * Math.PI / 180 },
    Ellipsoid: { WGS84: {} },
    EllipsoidalOccluder: class { isPointVisible() { return !occluded; } },
    Transforms: {
      rotationMatrixFromPositionVelocity: (position, velocity) => ({ position, velocity }),
      eastNorthUpToFixedFrame: position => ({ enu: position }),
    },
    ImageBasedLighting: class { constructor(options) { this.options = options; } },
    Model: {
      async fromGltfAsync(options) {
        loads.push(options);
        return { options, show: options.show, modelMatrix: null, destroyed: false, destroy() { this.destroyed = true; } };
      },
    },
  };
}
fakeCesium.IDENTITY = { identity: true };

function fakeViewer() {
  const items = [];
  const listeners = [];
  let motionMs = 0;
  const camera = {
    position: new Cartesian3(10, 20, 500_300), direction: new Cartesian3(0, 0, -1), up: new Cartesian3(0, 1, 0), right: null,
    get positionWC() { const origin = this.transform?.enu || { x: 0, y: 0, z: 0 }; return new Cartesian3(this.position.x + origin.x, this.position.y + origin.y, this.position.z + origin.z); },
    set positionWC(value) { const origin = this.transform?.enu || { x: 0, y: 0, z: 0 }; this.position = Cartesian3.subtract(value, origin, new Cartesian3()); },
    get directionWC() { return this.direction; }, set directionWC(v) { this.direction = v; },
    get upWC() { return this.up; }, frustum: { fov: Math.PI / 3 },
    transform: 'world', lookAtCalls: [], transformCalls: [], flyToCalls: [], flights: 0,
    lookAt(target, offset) {
      this.lookAtCalls.push({ target, offset });
      this.transform = { enu: target };
      this.position = offset.range !== undefined ? new Cartesian3(0, 0, offset.range) : Cartesian3.clone(offset);
    },
    // Like Cesium, a bare lookAtTransform keeps the world pose: the local position becomes
    // world position minus the frame origin (the fake frame is a pure translation).
    lookAtTransform(transform) {
      const worldPosition = this.positionWC;
      this.transformCalls.push(transform);
      this.transform = transform;
      this.position = transform.enu ? Cartesian3.subtract(worldPosition, transform.enu, new Cartesian3()) : worldPosition;
    },
    flyTo(options) { this.flyToCalls.push(options); },
    cancelFlight() { this.flights += 1; },
  };
  return {
    camera,
    now: () => motionMs,
    advance(ms = 3000) {
      for (let elapsed = 0; elapsed < ms;) {
        const dt = Math.min(16, ms - elapsed); elapsed += dt; motionMs += dt;
        for (const listener of [...listeners]) listener();
      }
    },
    scene: {
      primitives: { items, add(model) { items.push(model); return model; }, remove(model) { const i = items.indexOf(model); if (i >= 0) items.splice(i, 1); return i >= 0; } },
      preUpdate: { listeners, addEventListener(fn) { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); } },
    },
  };
}

// The fake Cartesian3 keeps degrees as raw coordinates, so ten units per second exceeds the
// one-unit threshold the layer uses to reject a degenerate velocity sample.
const orbit = { longitude: 10, latitude: 20, altitude: 500, velocity: 7.6 };
const propagate = date => (date.getTime() < 0 ? null : { ...orbit, longitude: orbit.longitude + date.getTime() / 100 });
const starlink = { satelliteId: 64436, url: '/static/assets/models/starlink_flat.glb', scale: 1.0035, sizeMeters: 29, minimumPixelSize: 12 };

function layerWith(viewer, cesium, options = {}) {
  return new SatelliteModelLayer({ viewer: () => viewer, cesium: () => cesium, timeSource: () => new Date(0), motionNow: viewer.now, ...options });
}

test('selected-body wheel zoom is rendered over frames even while the analysis clock is paused', async () => {
  const viewer = fakeViewer();
  let now = 0;
  const layer = layerWith(viewer, fakeCesium([]), { motionNow: () => now });
  await layer.show(starlink, propagate, new Date(0));
  layer.zoomBy(120);
  assert.equal(Cartesian3.magnitude(viewer.camera.position), 300, 'input queues a goal without moving the camera');
  now = 16; viewer.scene.preUpdate.listeners[0]();
  const first = Cartesian3.magnitude(viewer.camera.position);
  assert.ok(first < 300 && first > 280, 'the first frame is a small step');
  now = 32; viewer.scene.preUpdate.listeners[0]();
  assert.ok(Cartesian3.magnitude(viewer.camera.position) < first);
  assert.equal(layer.model.modelMatrix.translation.x, 10, 'camera time must not advance the paused orbit');
  layer.clear();
});

test('explicit focus does not teleport to the close-up on the input event', async () => {
  const viewer = fakeViewer();
  const layer = layerWith(viewer, fakeCesium([]));
  await layer.show(starlink, propagate, new Date(0));
  layer.focus(new Date(0));
  assert.equal(viewer.camera.lookAtCalls.length, 0, 'the top-down framing is reached through an animation');
  assert.equal(Cartesian3.magnitude(viewer.camera.position), 300);
  layer.clear();
});

test('manual camera input cancels a focus queued behind a pending model download', async () => {
  const viewer = fakeViewer();
  const layer = layerWith(viewer, fakeCesium([]));
  const pending = layer.show(starlink, propagate, new Date(0));
  assert.equal(layer.focus(new Date(0)), false);
  layer.cancelMotion();
  await pending;
  assert.equal(layer.tracking, false, 'a late model must not undo the user\'s newer drag');
  assert.equal(layer.pendingFocus, false);
});

test('an occluded focus stages high enough to reacquire LEO at 600x instead of chasing a stale close-up', async () => {
  const viewer = fakeViewer();
  const layer = layerWith(viewer, fakeCesium([], { occluded: true }));
  await layer.show(starlink, propagate, new Date(0));
  layer.focus(new Date(0));
  const flight = viewer.camera.flyToCalls[0];
  // At 400 km the body advances about 51 degrees in a 1.4 s / 600x flight.
  // Independent horizon geometry: acos(R/cameraRadius) + acos(R/bodyRadius).
  const visibleAngle = Math.acos(6_378_137 / (6_378_137 + flight.destination.z)) + Math.acos(6_378_137 / 6_778_137);
  assert.ok(visibleAngle > 60 * Math.PI / 180);
  flight.complete();
  assert.equal(viewer.camera.flyToCalls.length, 1, 'a still-occluded/missing target must not spawn endless stale flights');
});

test('absolute zoom-out from a distant follow never clamps inward to the close-range ceiling', async () => {
  const viewer = fakeViewer();
  const layer = layerWith(viewer, fakeCesium([]));
  await layer.show(starlink, propagate, new Date(0));
  viewer.camera.positionWC = new Cartesian3(10, 20, 10_500_000);
  layer.engageFromCamera();
  assert.equal(layer.setZoomDistance(11_000_000), true);
  viewer.advance(16);
  assert.ok(Cartesian3.distance(viewer.camera.positionWC, new Cartesian3(10, 20, 500_000)) > 10_000_000);
});

test('hidden follow views cancel queued motion and do not replay it on return', async () => {
  const viewer = fakeViewer();
  viewer.scene.canvas = { clientWidth: 800, clientHeight: 600 };
  const layer = layerWith(viewer, fakeCesium([]));
  await layer.show(starlink, propagate, new Date(0));
  layer.zoomBy(240); viewer.advance(16);
  const before = Cartesian3.magnitude(viewer.camera.position);
  viewer.scene.canvas.clientWidth = 0; viewer.advance();
  viewer.scene.canvas.clientWidth = 800; viewer.advance();
  assert.equal(Cartesian3.magnitude(viewer.camera.position), before);
});

test('showing a model loads it once at real scale and orients it along the velocity frame', async () => {
  const loads = [];
  const viewer = fakeViewer();
  const layer = layerWith(viewer, fakeCesium(loads));
  const model = await layer.show({ satelliteId: 25544, url: '/static/assets/models/iss.glb', scale: 2.39, sizeMeters: 109, minimumPixelSize: 12, orientation: { heading: 90 } }, propagate, new Date(0));
  assert.equal(loads.length, 1);
  assert.deepEqual(loads[0].id, { satelliteId: '25544' });
  assert.equal(loads[0].scale, 2.39);
  assert.equal(loads[0].minimumPixelSize, 12);
  assert.equal(loads[0].allowPicking, true);
  assert.equal(loads[0].imageBasedLighting.options.sphericalHarmonicCoefficients.length, 9);
  assert.equal(viewer.scene.primitives.items[0], model);
  assert.equal(model.show, true);
  assert.deepEqual({ ...model.modelMatrix.translation }, { x: 10, y: 20, z: 500_000 });
  assert.equal(model.modelMatrix.rotation.velocity.x, 1, 'velocity is a unit vector along the sampled motion');
  assert.equal(model.modelMatrix.rotation.trim.hpr.heading, Math.PI / 2);
  await layer.show({ satelliteId: 25544, url: '/static/assets/models/iss.glb', scale: 2.39, sizeMeters: 109 }, propagate, new Date(5000));
  assert.equal(loads.length, 1, 'same satellite, url and scale must not reload');
  assert.equal(model.modelMatrix.translation.x, 60);
  await layer.show({ satelliteId: 25544, url: '/static/assets/models/iss.glb', scale: 1, sizeMeters: 109 }, propagate, new Date(0));
  assert.equal(loads.length, 2, 'a different scale is a different primitive');
});

test('focus frames the body at a range proportional to its real size and follows it every frame', async () => {
  const loads = [];
  const viewer = fakeViewer();
  const changes = [];
  const frames = [];
  const layer = layerWith(viewer, fakeCesium(loads), { onTrackingChange: state => changes.push(state), onFrame: date => frames.push(date.getTime()) });
  assert.equal(layer.focus(new Date(0)), false, 'nothing to follow before a target exists');
  await layer.show(starlink, propagate, new Date(0));
  assert.equal(layer.focus(new Date(0)), true);
  viewer.advance();
  assert.equal(viewer.camera.flights, 1, 'an in-flight camera animation is cancelled first');
  assert.equal(viewer.camera.lookAtCalls.length, 0, 'focus never snaps with lookAt');
  assert.deepEqual({ ...viewer.camera.transform.enu }, { x: 10, y: 20, z: 500_000 });
  assert.ok(Math.abs(Cartesian3.magnitude(viewer.camera.position) - 87) < 1e-6);
  assert.deepEqual(changes, [true]);
  assert.equal(viewer.scene.preUpdate.listeners.length, 1, 'one per-frame updater');
  layer.timeSource = () => new Date(2000);
  frames.length = 0;
  viewer.scene.preUpdate.listeners[0]();
  assert.equal(layer.model.modelMatrix.translation.x, 30, 'the body advanced with the analysis time');
  assert.deepEqual(frames, [2000], 'the owner is told about every frame so markers can follow');
  assert.deepEqual(viewer.camera.transformCalls.at(-1), { enu: layer.model.modelMatrix.translation });
  assert.deepEqual({ ...viewer.camera.position }, { x: 0, y: 0, z: 87 }, 'the local camera offset survives the frame change');
  assert.ok(viewer.camera.right, 'right vector is rebuilt from direction and up');
});

test('framing always looks straight down with north up, and a plain selection keeps the current distance', async () => {
  const viewer = fakeViewer();
  const layer = layerWith(viewer, fakeCesium([]));
  await layer.show(starlink, propagate, new Date(0));
  assert.equal(layer.focus(new Date(0), { keepRange: true }), true);
  viewer.advance();
  assert.equal(Cartesian3.magnitude(viewer.camera.position), 300, 'the camera was 300 units from the body and stays there');
  assert.ok(Cartesian3.distance(viewer.camera.direction, new Cartesian3(0, 0, -1)) < 1e-8);
  assert.deepEqual({ ...viewer.camera.up }, { x: 0, y: 1, z: 0 });
  layer.zoomBy(120);
  viewer.advance();
  const zoomed = Cartesian3.magnitude(viewer.camera.position);
  assert.equal(layer.focus(new Date(0), { keepRange: true }), true, 'recentring while already following');
  viewer.advance();
  assert.equal(Cartesian3.magnitude(viewer.camera.position), zoomed, 'the follow range is kept');
  assert.equal(layer.focus(new Date(0)), true);
  viewer.advance();
  assert.ok(Math.abs(Cartesian3.magnitude(viewer.camera.position) - 87) < 1e-6, 'the locate action moves in to three body sizes');
  assert.ok(Cartesian3.distance(viewer.camera.direction, new Cartesian3(0, 0, -1)) < 1e-8);
});

test('a plain selection requested before the model loads keeps its distance once applied', async () => {
  const viewer = fakeViewer();
  const layer = layerWith(viewer, fakeCesium([]));
  const pending = layer.show(starlink, propagate, new Date(0));
  assert.equal(layer.focus(new Date(0), { keepRange: true }), false);
  assert.deepEqual(layer.pendingFocusOptions, { keepRange: true });
  await pending;
  viewer.advance();
  assert.equal(layer.tracking, true);
  assert.equal(Cartesian3.magnitude(viewer.camera.position), 300);
  assert.equal(layer.pendingFocusOptions, null);
});

test('focus requested before the glTF finishes loading is applied once the model is ready', async () => {
  const loads = [];
  const viewer = fakeViewer();
  const layer = layerWith(viewer, fakeCesium(loads));
  const pending = layer.show(starlink, propagate, new Date(0));
  assert.equal(layer.focus(new Date(0)), false);
  assert.equal(layer.pendingFocus, true);
  await pending;
  viewer.advance();
  assert.equal(layer.tracking, true);
  assert.ok(Math.abs(Cartesian3.magnitude(viewer.camera.position) - 87) < 1e-6);
});

test('objects without a model are still framed on their point marker at a fixed range', async () => {
  const viewer = fakeViewer();
  const layer = layerWith(viewer, fakeCesium([]));
  assert.equal(await layer.show({ satelliteId: 7 }, propagate, new Date(0)), null);
  assert.equal(layer.focus(new Date(0)), true);
  viewer.advance();
  assert.equal(Cartesian3.magnitude(viewer.camera.position), 3000);
  assert.equal(viewer.scene.primitives.items.length, 0);
});

test('a small CubeSat is framed close enough to inspect without enlarging its actual model', async () => {
  const viewer = fakeViewer();
  const layer = layerWith(viewer, fakeCesium([]));
  await layer.show({ satelliteId: 9, url: 'cubesat.glb', sizeMeters: .3, scale: 1, minimumPixelSize: 12 }, propagate, new Date(0));
  layer.focus(new Date(0)); viewer.advance();
  const range = Cartesian3.magnitude(viewer.camera.position);
  assert.ok(range >= 1.5 && range < 3, 'small bodies must not be held at the old 20 m floor');
  assert.equal(layer.model.options.scale, 1);
  assert.equal(layer.model.options.minimumPixelSize, 12);
  layer.focus(new Date(0), { keepRange: true }); viewer.advance();
  assert.ok(Math.abs(Cartesian3.magnitude(viewer.camera.position) - range) < 1e-6, 'recentering preserves a small body\'s close viewing distance');
});

test('zooming in on a visible selected body starts following from the current viewpoint', async () => {
  const viewer = fakeViewer();
  const changes = [];
  const layer = layerWith(viewer, fakeCesium([]), { onTrackingChange: state => changes.push(state) });
  await layer.show(starlink, propagate, new Date(0));
  assert.equal(layer.zoomBy(-120), false, 'zooming out without following stays Earth-centred');
  assert.equal(layer.zoomBy(120), true);
  assert.equal(layer.tracking, true);
  assert.deepEqual(changes, [true]);
  assert.equal(viewer.camera.flights, 1);
  assert.equal(viewer.camera.lookAtCalls.length, 0, 'the view is not re-aimed, so nothing snaps');
  assert.deepEqual({ ...viewer.camera.transformCalls.at(-1).enu }, { x: 10, y: 20, z: 500_000 }, 'the body becomes the frame origin');
  const range = Cartesian3.magnitude(viewer.camera.position);
  assert.equal(range, 300, 'the wheel queues motion without a pose jump');
  viewer.advance();
  assert.ok(Cartesian3.magnitude(viewer.camera.position) < 300);
  assert.deepEqual(viewer.camera.flyToCalls, []);
});

test('a follow that starts far away accelerates over frames without snapping to a range cap', async () => {
  const viewer = fakeViewer();
  viewer.camera.positionWC = new Cartesian3(10, 20, 16_500_300);
  const layer = layerWith(viewer, fakeCesium([]));
  await layer.show(starlink, propagate, new Date(0));
  assert.equal(layer.zoomBy(100), true);
  const range = Cartesian3.magnitude(viewer.camera.position);
  assert.equal(range, 16_000_300);
  viewer.advance(16);
  const inward = Cartesian3.magnitude(viewer.camera.position);
  assert.ok(inward < range && inward > range * .9, 'the first accelerated frame is still small');
  assert.equal(layer.zoomBy(-100), true);
  viewer.advance(16);
  assert.equal(layer.tracking, false, 'zooming back out from far away releases immediately');
  assert.ok(Cartesian3.distance(viewer.camera.positionWC, new Cartesian3(10, 20, 500_000)) > inward, 'the release step still moves outward, never inward');
});

test('zooming in is left to the Earth camera when the body is behind the camera or behind the globe', async () => {
  const hidden = fakeViewer();
  hidden.camera.directionWC = new Cartesian3(0, 0, 1);
  const away = layerWith(hidden, fakeCesium([]));
  await away.show(starlink, propagate, new Date(0));
  assert.equal(away.zoomBy(120), false);
  assert.equal(away.tracking, false);
  const occludedViewer = fakeViewer();
  const occluded = layerWith(occludedViewer, fakeCesium([], { occluded: true }));
  await occluded.show(starlink, propagate, new Date(0));
  assert.equal(occluded.zoomBy(120), false);
  assert.equal(occludedViewer.camera.lookAtCalls.length, 0);
  const sideways = fakeViewer();
  sideways.camera.directionWC = new Cartesian3(1, 0, -0.05);
  const drifted = layerWith(sideways, fakeCesium([]));
  await drifted.show(starlink, propagate, new Date(0));
  assert.equal(drifted.zoomBy(120), true, 'a body that drifted out of frame but is still ahead is re-acquired');
  assert.equal(sideways.camera.transformCalls.length, 1);
});

test('wheel input scales the follow range within limits and zooming far out releases the camera', async () => {
  const viewer = fakeViewer();
  const cesium = fakeCesium([]);
  cesium.Matrix4.IDENTITY = fakeCesium.IDENTITY;
  const changes = [];
  const layer = layerWith(viewer, cesium, { onTrackingChange: state => changes.push(state) });
  await layer.show(starlink, propagate, new Date(0));
  layer.focus(new Date(0));
  viewer.advance();
  assert.equal(layer.zoomBy(120), true);
  viewer.advance();
  const closer = Cartesian3.magnitude(viewer.camera.position);
  assert.ok(closer < 87 && closer > 60, `zooming in shortens the range, received ${closer}`);
  for (let i = 0; i < 40; i++) { layer.zoomBy(240); viewer.advance(); }
  assert.ok(Cartesian3.magnitude(viewer.camera.position) >= 17, 'range never collapses into the body');
  let steps = 0;
  while (layer.tracking && steps < 200) { layer.zoomBy(-240); viewer.advance(); steps += 1; }
  assert.equal(layer.tracking, false, 'zooming out beyond the release distance hands control back');
  assert.equal(viewer.camera.transformCalls.at(-1), fakeCesium.IDENTITY);
  assert.deepEqual(changes, [true, false]);
  assert.equal(viewer.camera.flyToCalls.length, 1, 'the release eases the view toward Earth instead of snapping later');
  const flight = viewer.camera.flyToCalls[0];
  assert.deepEqual({ ...flight.destination }, { ...viewer.camera.positionWC }, 'the camera stays where it is');
  assert.ok(flight.orientation.direction.z < 0 && Math.abs(Cartesian3.dot(flight.orientation.direction, flight.orientation.up)) < 1e-9, 'it turns toward Earth with a perpendicular up vector');
  assert.equal(flight.duration, 0.8);
  assert.equal(layer.zoomBy(-240), false, 'further zoom-out is Earth-centred again');
});

test('a plain untrack keeps the current view and only the wheel release or Escape eases toward Earth', async () => {
  const viewer = fakeViewer();
  const cesium = fakeCesium([]);
  cesium.Matrix4.IDENTITY = fakeCesium.IDENTITY;
  const layer = layerWith(viewer, cesium);
  await layer.show(starlink, propagate, new Date(0));
  layer.focus(new Date(0));
  layer.untrack();
  assert.deepEqual(viewer.camera.flyToCalls, []);
  layer.focus(new Date(0));
  layer.untrack({ aimAtEarth: true });
  assert.equal(viewer.camera.flyToCalls.length, 1);
});

test('untrack restores the world frame once and clear stops following and updating', async () => {
  const viewer = fakeViewer();
  const changes = [];
  const cesium = fakeCesium([]);
  cesium.Matrix4.IDENTITY = fakeCesium.IDENTITY;
  const layer = layerWith(viewer, cesium, { onTrackingChange: state => changes.push(state) });
  await layer.show(starlink, propagate, new Date(0));
  layer.focus(new Date(0));
  layer.untrack();
  layer.untrack();
  assert.deepEqual(changes, [true, false]);
  assert.equal(viewer.camera.transformCalls.at(-1), fakeCesium.IDENTITY);
  assert.equal(viewer.scene.preUpdate.listeners.length, 1, 'the model keeps moving smoothly while shown');
  layer.clear();
  assert.equal(viewer.scene.preUpdate.listeners.length, 0);
  assert.deepEqual(viewer.scene.primitives.items, []);
  assert.equal(layer.positionAt, null);
});

test('selecting another body while following releases the camera instead of teleporting it', async () => {
  const viewer = fakeViewer();
  const cesium = fakeCesium([]);
  cesium.Matrix4.IDENTITY = fakeCesium.IDENTITY;
  const changes = [];
  const layer = layerWith(viewer, cesium, { onTrackingChange: state => changes.push(state) });
  await layer.show(starlink, propagate, new Date(0));
  layer.focus(new Date(0));
  const pending = layer.show({ satelliteId: 25544, url: '/static/assets/models/iss.glb', scale: 2.39, sizeMeters: 109 }, propagate, new Date(0));
  assert.equal(layer.tracking, false, 'the follow frame is dropped as soon as the target changes');
  assert.equal(viewer.camera.transformCalls.at(-1), fakeCesium.IDENTITY);
  assert.deepEqual(changes, [true, false]);
  assert.deepEqual(viewer.camera.flyToCalls, [], 'a plain selection change does not animate the camera');
  await pending;
  assert.equal(layer.tracking, false);
  layer.focus(new Date(0));
  assert.equal(layer.tracking, true, 'an explicit focus on the new body still works');
  await layer.show({ satelliteId: 25544, url: '/static/assets/models/iss.glb', scale: 2.39, sizeMeters: 109 }, propagate, new Date(1000));
  assert.equal(layer.tracking, true, 're-showing the same body keeps following it');
});

test('a pending focus is dropped when the selection moves on before the model loads', async () => {
  const viewer = fakeViewer();
  const layer = layerWith(viewer, fakeCesium([]));
  const first = layer.show(starlink, propagate, new Date(0));
  assert.equal(layer.focus(new Date(0)), false);
  assert.equal(layer.pendingFocus, true);
  const second = layer.show({ satelliteId: 7, url: 'b.glb' }, propagate, new Date(0));
  assert.equal(layer.pendingFocus, false);
  await Promise.all([first, second]);
  assert.equal(layer.tracking, false);
  assert.equal(viewer.camera.lookAtCalls.length, 0);
});

test('a missing propagation hides the model instead of freezing a stale position', async () => {
  const viewer = fakeViewer();
  const layer = layerWith(viewer, fakeCesium([]));
  const model = await layer.show({ satelliteId: 1, url: 'a.glb' }, propagate, new Date(0));
  assert.equal(model.show, true);
  layer.update(new Date(-1000));
  assert.equal(model.show, false);
  layer.update(new Date(2000));
  assert.equal(model.show, true);
});

test('switching satellites removes the previous primitive and a stale load is discarded', async () => {
  const loads = [];
  const viewer = fakeViewer();
  const layer = layerWith(viewer, fakeCesium(loads));
  const first = await layer.show({ satelliteId: 1, url: 'a.glb' }, propagate, new Date(0));
  const pending = layer.show({ satelliteId: 2, url: 'b.glb' }, propagate, new Date(0));
  layer.clear();
  const second = await pending;
  assert.equal(second, null, 'a load that finishes after clear() is not added');
  assert.deepEqual(viewer.scene.primitives.items, []);
  assert.equal(first.destroyed, false, 'removal is delegated to the primitive collection');
  const third = await layer.show({ satelliteId: 3, url: 'c.glb' }, propagate, new Date(0));
  assert.deepEqual(viewer.scene.primitives.items, [third]);
  assert.equal(loads.length, 3);
});

test('without Cesium models or a viewer the layer stays inert', async () => {
  const layer = new SatelliteModelLayer({ viewer: () => null, cesium: () => ({}) });
  assert.equal(await layer.show({ satelliteId: 1, url: 'a.glb' }, propagate, new Date(0)), null);
  assert.equal(layer.model, null);
  assert.equal(layer.focus(new Date(0)), false);
  assert.equal(layer.zoomBy(100), false);
  layer.update(new Date(0));
  layer.clear();
});

test('a failed glTF load leaves the point marker and allows a later retry', async () => {
  const viewer = fakeViewer();
  let attempts = 0;
  const cesium = fakeCesium([]);
  cesium.Model.fromGltfAsync = async () => { attempts += 1; if (attempts === 1) throw new Error('404'); return { show: false, modelMatrix: null }; };
  const layer = layerWith(viewer, cesium);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await layer.show({ satelliteId: 1, url: 'missing.glb' }, propagate, new Date(0)), null);
    assert.deepEqual(viewer.scene.primitives.items, []);
    const model = await layer.show({ satelliteId: 1, url: 'missing.glb' }, propagate, new Date(0));
    assert.equal(model.show, true);
    assert.equal(attempts, 2);
  } finally {
    console.warn = warn;
  }
});
