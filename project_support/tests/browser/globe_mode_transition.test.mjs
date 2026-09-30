import test from 'node:test';
import assert from 'node:assert/strict';

import { loadGlobe } from './load_globe.mjs';
const { GlobeController } = await loadGlobe();

function fixture() {
  const SceneMode = { MORPHING: 0, SCENE2D: 2, SCENE3D: 3 };
  class Cartesian3 { constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); } }
  globalThis.window = { Cesium: {
    Cartesian3, SceneMode, Matrix4: { IDENTITY: 'world' },
    CameraEventType: { PINCH: 'pinch' }, ScreenSpaceEventType: { WHEEL: 'wheel' },
  } };
  const listeners = new Set();
  const inputs = new Map();
  let pendingTarget = null;
  let initialFlight = null;
  const camera = {
    cancelFlight() { initialFlight = null; },
    lookAtTransform(frame) { this.transform = frame; },
    flyTo({ complete }) { initialFlight = complete; },
    flyHome() { this.cancelFlight(); },
  };
  const scene = {
    mode: SceneMode.SCENE2D, camera,
    screenSpaceCameraController: { enableRotate: false, enableTranslate: true, enableTilt: false },
    requestRender() {},
    morphComplete: { addEventListener(callback) { listeners.add(callback); return () => listeners.delete(callback); } },
    completeMorph() {
      if (pendingTarget === null) return;
      camera.cancelFlight();
      this.mode = pendingTarget;
      pendingTarget = null;
      for (const callback of [...listeners]) callback();
    },
    morphTo3D() {
      this.completeMorph();
      if (this.mode === SceneMode.SCENE3D) return;
      pendingTarget = SceneMode.SCENE3D;
      // Cesium 1.143 SceneTransitioner.morphFrom2DTo3D first flies in SCENE2D.
      // Only that flight's complete callback enters MORPHING. Cancelling the
      // flight does not complete the morph or remove its user-input handler.
      // https://github.com/CesiumGS/cesium/blob/1.143/packages/engine/Source/Scene/SceneTransitioner.js
      this.mode = SceneMode.SCENE2D;
      camera.flyTo({ complete: () => { this.mode = SceneMode.MORPHING; } });
    },
    morphTo2D() {
      this.completeMorph();
      if (this.mode === SceneMode.SCENE2D) return;
      pendingTarget = SceneMode.SCENE2D;
      this.mode = SceneMode.MORPHING;
    },
  };
  const globe = new GlobeController({ dataset: {} }, {}, { sunElement: {} });
  globe.viewer = { scene, camera, screenSpaceEventHandler: { setInputAction(callback, type) { inputs.set(type, callback); } } };
  return {
    globe, scene, listeners,
    wheel(delta) { inputs.get('wheel')(delta); },
    finishAnimation() {
      if (initialFlight) { const complete = initialFlight; initialFlight = null; complete(); }
      if (scene.mode === SceneMode.MORPHING) scene.completeMorph();
    },
  };
}

test('a rapid 3D then 2D request settles both transitions and keeps the latest mode after user input', async () => {
  const { globe, scene, listeners, finishAnimation } = fixture();
  const settled = [false, false];
  const first = globe.setSceneMode('3d').then(() => { settled[0] = true; });
  const latest = globe.setSceneMode('2d').then(() => { settled[1] = true; });
  try {
    finishAnimation();
    // Flush continuations without waiting on a potentially orphaned promise.
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual({ settled: [...settled], listeners: listeners.size, mode: scene.mode }, {
      settled: [true, true], listeners: 0, mode: 2,
    }, 'the cancelled 3D request must not retain an unresolved promise or morph listener');
    scene.completeMorph(); // Cesium's next mouse or wheel input completes a pending morph.
    assert.equal(scene.mode, 2, 'an old 3D transition must not override the latest 2D request');
    await Promise.all([first, latest]);
  } finally {
    scene.completeMorph();
  }
});

test('wheel input is not forwarded to the selected-target camera during the initial 2D phase of a 3D transition', async () => {
  const { globe, scene, wheel, finishAnimation } = fixture();
  const forwarded = [];
  globe.wheelOverride = delta => { forwarded.push(delta); return true; };
  globe.installCenteredZoom();
  const pending = globe.setSceneMode('3d');
  try {
    wheel(120);
    assert.deepEqual(forwarded, [], 'SCENE2D during a transition is not an interactive map view');
    finishAnimation();
    await pending;
    wheel(120);
    assert.deepEqual(forwarded, [120], 'the selected-target wheel resumes after the transition completes');
  } finally {
    scene.completeMorph();
  }
});

test('home does not cancel the initial camera flight owned by an active mode transition', async () => {
  const { globe, scene, finishAnimation } = fixture();
  let settled = false;
  const pending = globe.setSceneMode('3d').then(() => { settled = true; });
  try {
    globe.home();
    finishAnimation();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, true, 'the mode transition must still be able to complete');
    assert.equal(scene.mode, 3);
    await pending;
  } finally { scene.completeMorph(); }
});
