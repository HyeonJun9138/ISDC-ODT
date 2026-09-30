import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGlobe } from './load_globe.mjs';
import { SatelliteModelLayer } from '../../../digital_twin/visualization/satellite_model.js';

const { GlobeController } = await loadGlobe();
const controlsModule = await import('../../../user_application/web/scripts/orbit/zoom_controls.js').catch(() => ({}));

class Vector {
  constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
  static ZERO = new Vector();
  static magnitude(v) { return Math.hypot(v.x, v.y, v.z); }
  static magnitudeSquared(v) { return this.magnitude(v) ** 2; }
  static multiplyByScalar(v, n, out) { return Object.assign(out, { x: v.x * n, y: v.y * n, z: v.z * n }); }
  static subtract(a, b, out) { return Object.assign(out, { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }); }
  static add(a, b, out) { return Object.assign(out, { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }); }
  static normalize(v, out) { return this.multiplyByScalar(v, 1 / this.magnitude(v), out); }
  static cross(a, b, out) { return Object.assign(out, { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }); }
}
class Control extends EventTarget {
  value = '0'; disabled = false; attributes = {};
  setAttribute(key, value) { this.attributes[key] = value; }
  fire(type) { this.dispatchEvent(new Event(type)); }
}
function fixture() {
  assert.equal(typeof controlsModule.bindZoomControls, 'function', 'zoom controls must bind to the dashboard camera');
  globalThis.window = { Cesium: { Cartesian3: Vector, SceneMode: { MORPHING: 0, SCENE2D: 2, SCENE3D: 3 }, CameraEventType: { PINCH: 1 }, ScreenSpaceEventType: { WHEEL: 2 }, Math: { EPSILON10: 1e-10 } } };
  const camera = {
    positionWC: new Vector(0, 0, 30_000_000), position: new Vector(0, 0, 1000),
    upWC: new Vector(0, 1, 0), rightWC: new Vector(1, 0, 0), directionWC: new Vector(0, 0, -1),
    positionCartographic: { height: 1_000_000 }, frustum: { left: -500_000, right: 500_000, top: 250_000, bottom: -250_000 },
    cancelFlight() {}, setView({ destination }) { this.positionWC = destination; },
    zoomIn(amount) { this.frustum.left += amount / 2; this.frustum.right -= amount / 2; },
    zoomOut(amount) { this.frustum.left -= amount / 2; this.frustum.right += amount / 2; },
  };
  const actions = new Map();
  const scene = { camera, mode: 3, screenSpaceCameraController: {}, requestRender() {} };
  let now = 0;
  const globe = new GlobeController({}, {}, { sunElement: {}, motionNow: () => now });
  globe.viewer = { camera, scene, screenSpaceEventHandler: { setInputAction: (fn, type) => actions.set(type, fn), getInputAction: type => actions.get(type) } };
  globe.installCenteredZoom();
  const layer = new SatelliteModelLayer({ viewer: () => globe.viewer });
  let focusAvailable = false;
  const elements = { slider: new Control(), zoomIn: new Control(), zoomOut: new Control(), focus: new Control(), canFocus: () => focusAvailable };
  const controls = controlsModule.bindZoomControls(elements, globe, layer);
  const advance = () => { for (let i = 0; i < 160; i++) { now += 50; globe.advanceZoom(); } controls.sync(); };
  return { camera, globe, layer, elements, controls, advance, wheel: actions.get(2), setFocusAvailable: value => { focusAvailable = value; } };
}

test('each map enables focus only for a valid target and an available camera', () => {
  const { globe, elements, controls, setFocusAvailable } = fixture();
  assert.equal(elements.focus.disabled, true);
  setFocusAvailable(true); controls.sync();
  assert.equal(elements.focus.disabled, false);
  globe.viewer = null; controls.sync();
  assert.equal(elements.focus.disabled, true);
});

test('plus and minus reuse Earth-centred wheel zoom and slider follows external wheel changes', () => {
  const { camera, elements, controls, wheel, advance } = fixture();
  const initial = Number(elements.slider.value);
  elements.zoomIn.fire('click'); advance();
  assert.ok(Vector.magnitude(camera.positionWC) < 30_000_000);
  assert.ok(Number(elements.slider.value) > initial);
  elements.zoomOut.fire('click'); advance();
  assert.ok(Math.abs(Vector.magnitude(camera.positionWC) - 30_000_000) < 0.001);
  wheel(-120); advance(); controls.sync();
  assert.ok(Number(elements.slider.value) < initial);
});

test('dragging the slider changes scale, reaches both limits, and rejects invalid input', () => {
  const { camera, elements, advance } = fixture();
  elements.slider.value = '100'; elements.slider.fire('input'); advance();
  assert.ok(Math.abs(Vector.magnitude(camera.positionWC) - 6_498_137) < 1);
  elements.slider.value = '0'; elements.slider.fire('input'); advance();
  assert.ok(Math.abs(Vector.magnitude(camera.positionWC) - 1_006_378_137) < 1);
  elements.slider.value = 'bad'; elements.slider.fire('input');
  assert.ok(Number.isFinite(Vector.magnitude(camera.positionWC)));
});

test('selected satellite buttons keep tracking and schedule smooth local range changes', () => {
  const { camera, globe, layer, elements, controls } = fixture();
  layer.tracking = true;
  globe.wheelOverride = delta => layer.zoomBy(delta);
  controls.sync();
  elements.zoomIn.fire('click');
  assert.ok(layer.rangeMotion.target < 1000);
  assert.equal(layer.tracking, true);
  elements.zoomOut.fire('click');
  assert.ok(layer.rangeMotion.target > 1000, 'reverse input starts from the currently displayed distance');
});

test('tracked slider schedules its full target instead of stopping at one asynchronous wheel step', () => {
  const { globe, layer, elements, controls } = fixture();
  layer.tracking = true;
  globe.wheelOverride = delta => layer.zoomBy(delta);
  controls.sync();
  elements.slider.value = '95'; elements.slider.fire('input');
  assert.ok(layer.rangeMotion.target < 50, 'a large slider drag must reach its requested close-up');
  assert.equal(layer.tracking, true);
});

test('zooming out with the slider during distant tracking does not reverse into a close-up', () => {
  const { camera, layer, elements, controls } = fixture();
  camera.position = new Vector(0, 0, 10_000_000);
  layer.tracking = true; controls.sync();
  elements.slider.value = String(Number(elements.slider.value) - .1);
  elements.slider.fire('input');
  assert.ok(layer.rangeMotion.target > 10_000_000);
});

test('2D buttons adjust map width and transition or fallback disables zoom safely', () => {
  const { camera, globe, elements, controls, advance } = fixture();
  globe.viewer.scene.mode = 2; controls.sync();
  elements.zoomIn.fire('click'); advance();
  assert.ok(camera.frustum.right - camera.frustum.left < 1000000);
  elements.zoomOut.fire('click'); advance();
  assert.ok(Math.abs(camera.frustum.right - camera.frustum.left - 1000000) < .001);
  globe.sceneTransitioning = true; controls.sync();
  assert.equal(elements.slider.disabled, true);
  elements.zoomIn.fire('click');
  assert.ok(Math.abs(camera.frustum.right - camera.frustum.left - 1000000) < .001);
  globe.viewer = null; controls.sync();
  assert.equal(elements.zoomIn.disabled, true);
  assert.equal(elements.zoomOut.disabled, true);
});

test('2D slider honours small adjustments and both endpoints instead of rounding to wheel steps', () => {
  const { camera, globe, elements, controls, advance } = fixture();
  globe.viewer.scene.mode = 2; controls.sync();
  const requested = Number(elements.slider.value) + .1;
  elements.slider.value = String(requested); elements.slider.fire('input'); advance();
  assert.ok(Math.abs(Number(elements.slider.value) - requested) < .001);
  assert.ok(camera.frustum.right - camera.frustum.left > 980000);
  elements.slider.value = '100'; elements.slider.fire('input'); advance();
  assert.ok(Math.abs(camera.frustum.right - camera.frustum.left - 1000) < .001);
  elements.slider.value = '0'; elements.slider.fire('input'); advance();
  assert.ok(Math.abs(camera.frustum.right - camera.frustum.left - 40000000) < .001);
});
