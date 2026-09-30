// All globe views reuse the installed wheel action, including satellite tracking.
export function bindZoomControls({ slider, zoomIn, zoomOut, focus, canFocus = () => true }, globe, modelLayer) {
  function scale() {
    const viewer = globe.viewer, Cesium = window.Cesium;
    if (!viewer || !Cesium || globe.sceneTransitioning || viewer.scene.mode === Cesium.SceneMode.MORPHING) return null;
    const camera = viewer.camera;
    const map = viewer.scene.mode === Cesium.SceneMode.SCENE2D;
    const tracking = modelLayer?.tracking === true;
    const distance = map ? camera.frustum.right - camera.frustum.left
      : Cesium.Cartesian3.magnitude(tracking ? camera.position : camera.positionWC);
    if (!Number.isFinite(distance) || distance <= 0) return null;
    return {
      distance, tracking,
      min: map ? 1000 : tracking ? Math.max(1, Math.min(20, (Number(modelLayer.current?.sizeMeters) || 20) * .6)) : 6_498_137,
      max: map ? 40_000_000 : 1_006_378_137,
    };
  }

  function sync() {
    const state = scale();
    for (const control of [slider, zoomIn, zoomOut]) control.disabled = !state;
    if (focus) focus.disabled = !state || !canFocus();
    if (!state) return;
    const value = 100 * Math.log(state.max / state.distance) / Math.log(state.max / state.min);
    slider.value = String(Math.max(0, Math.min(100, value)));
    slider.setAttribute('aria-valuetext', `확대 수준 ${Math.round(Number(slider.value))}%`);
  }

  function wheel(delta) {
    if (!scale()) return;
    globe.viewer.screenSpaceEventHandler.getInputAction(window.Cesium.ScreenSpaceEventType.WHEEL)?.(delta);
  }

  zoomIn.addEventListener('click', () => { wheel(120); sync(); });
  zoomOut.addEventListener('click', () => { wheel(-120); sync(); });
  slider.addEventListener('input', () => {
    const initial = scale(), value = Number(slider.value);
    if (!initial || !Number.isFinite(value)) { sync(); return; }
    const target = initial.max * (initial.min / initial.max) ** (Math.max(0, Math.min(100, value)) / 100);
    // Set one animation target rather than replaying many wheel events.
    const cameraOwner = initial.tracking ? modelLayer : globe;
    cameraOwner.setZoomDistance(target);
    globe.viewer.scene.requestRender();
  });
  sync();
  return { sync };
}
