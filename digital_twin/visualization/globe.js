import { LINK_FLOW_SOURCE } from "./link_flow.js?v=20260908-oisl-flow1";
import { positionAt, elevationAt, predictPasses } from "/static/simulation/orbit.js?v=20260907-2";
import { CameraRangeMotion, cameraNow, cameraEase, cameraDirection, cameraBasis } from './camera_motion.js?v=20260908-camera2';

// Point, path and label colours per UI theme. The light palette keeps every orbit class legible on
// the pale scene backdrop that replaces deep-space blue in light mode.
const PALETTES = {
  dark: {
    LEO: "#ff9f43", MEO: "#e6ed55", GEO: "#5ee277", HEO: "#53c8ff", fallback: "#ff9f43",
    selected: "#efff62", hover: "#ffffff", pathOutline: "#061528", globeBase: "#07111d", globeBasePlain: "#173955",
  },
  light: {
    LEO: "#c9651a", MEO: "#8f8a12", GEO: "#1f8a55", HEO: "#1f7fa8", fallback: "#c9651a",
    selected: "#d35400", hover: "#1c2833", pathOutline: "#ffffff", globeBase: "#c9d6e3", globeBasePlain: "#c9d6e3",
  },
};
// The dense window must outlast the owner's rebuild cadence (30 s) so the body never leaves it;
// a 0.1 s step keeps the chord sag around a centimetre, invisible even beside a real-size body.
const PATH_DENSE_HALF_WINDOW_MS = 45_000;
const PATH_DENSE_STEP_MS = 100;
// While a body is selected every other point drops to this share of its catalogue alpha so the
// selected body and its trajectory, which hugs the globe among ~16k same-coloured LEO points, stand out.
const SELECTION_DIM = .65;
// Observer line packets: comet-shaped packets this many screen pixels apart, advanced at this many
// packet cycles per second, so the flow reads the same from orbit height and beside the real-size
// body. Downlink packets run from the body to the station, uplink packets the other way.
const LINK_PACKET_SPACING_PX = 96;
const LINK_FLOW_RATE = 1.4;

function paletteFor(theme) {
  return PALETTES[theme] || PALETTES.dark;
}

function satelliteColor(item, theme = "dark") {
  const palette = paletteFor(theme);
  return palette[String(item?.ORBIT_REGIME || "").toUpperCase()] || palette.fallback;
}

function satelliteAlpha(item, largeCatalog) {
  const epochAge = Number(item?.EPOCH_AGE_HOURS);
  return Number.isFinite(epochAge) && epochAge > 72 ? .68 : largeCatalog ? .9 : .98;
}

// Representative observation coordinates, not connected antenna facilities.
// Missing terrain heights are deliberately modelled at WGS84 height 0 km.
export const GROUND_STATIONS = {
  SEOUL: { key: "SEOUL", name: "서울", latitude: 37.5665, longitude: 126.9780 },
  JEJU: { key: "JEJU", name: "제주", latitude: 33.4996, longitude: 126.5312 },
  SVALBARD: { key: "SVALBARD", name: "스발바르", latitude: 78.2298, longitude: 15.4078 },
  ALASKA: { key: "ALASKA", name: "알래스카", latitude: 64.8378, longitude: -147.7164 },
  ATACAMA: { key: "ATACAMA", name: "아타카마", latitude: -23.0229, longitude: -67.7530 },
};

const waitFor = (predicate, timeout = 9000) => new Promise((resolve, reject) => {
  const started = performance.now();
  const check = () => {
    if (predicate()) return resolve(predicate());
    if (performance.now() - started > timeout) return reject(new Error("라이브러리 로드 시간 초과"));
    setTimeout(check, 80);
  };
  check();
});

export class GlobeController {
  constructor(container, fallbackCanvas, options = {}) {
    this.container = container;
    this.fallbackCanvas = fallbackCanvas;
    this.onSelect = options.onSelect || (() => {});
    this.onPosition = options.onPosition || (() => {});
    this.onHover = options.onHover || (() => {});
    // (phase, fraction, detail) start-up progress for the loading screen; phases are named in loading.js.
    this.onProgress = options.onProgress || (() => {});
    // Ground sites keyed by upper-case key; the console passes the reference list, tests use the default set.
    this.stations = options.stations || GROUND_STATIONS;
    this.stationEntities = new Map();
    this.onStationSelect = options.onStationSelect || (() => {});
    this.viewer = null;
    this.satelliteLib = null;
    this.items = [];
    this.records = new Map();
    this.entities = new Map();
    this.labels = new Map();
    this.pointCollection = null;
    this.labelCollection = null;
    this.selectedLabel = null;
    this.paths = new Map();
    this.selectedPath = null;
    // Owner of the buffered trajectory points; a rebuild that bails leaves it null so a stale line is never re-shown.
    this.selectedPathId = null;
    this.selectedPathPositions = [];
    this.coverageEntity = null;
    this.stationLinks = [];
    this.stationLink = null;
    this.stationLinkCollection = null;
    this.stationLinkFrameRemover = null;
    this.sunElement = options.sunElement || document.querySelector("#space-sun");
    this.sunDirectionFixed = null;
    this.sunProjectionRemove = null;
    this.lastSunUpdateMs = 0;
    this.lastSunProjectionMs = 0;
    this.imageryLayer = null;
    this.imageryMode = "satellite";
    this.positions = new Map();
    this.labelsVisible = false;
    this.tracksVisible = true;
    this.satelliteEmphasis = true;
    this.theme = "dark";
    this.selectedId = null;
    this.hoveredId = null;
    this.hoverFrame = 0;
    this.pendingHoverPosition = null;
    this.currentDate = new Date();
    this.fallbackFrame = null;
    this.lastFallbackDrawMs = 0;
    this.lastMassUpdateMs = 0;
    this.catalogRadiusMeters = 42_500_000;
    this.catalogGeneration = 0;
    this.observerKey = "SEOUL";
    this.elevationMask = 5;
    // Optional wheel interceptor, e.g. a follow camera that scales its offset instead of zooming to Earth.
    this.wheelOverride = null;
    this.sceneTransitioning = false;
    this.sceneTransitionRevision = 0;
    this.visibleIds = null;
    this.sdcMode = false;
    this.motionNow = options.motionNow || cameraNow;
    this.rangeMotion = new CameraRangeMotion({ now: this.motionNow });
    this.zoomFrameRemover = null;
    this.onCameraInput = options.onCameraInput || (() => {});
    this.onCameraMove = options.onCameraMove || (() => {});
  }

  async init() {
    try {
      this.satelliteLib = await import("https://cdn.jsdelivr.net/npm/satellite.js@7.0.1/+esm");
    } catch (error) {
      console.warn("satellite.js unavailable; GP propagation is unavailable", error);
    }
    this.onProgress("library", .4);
    try {
      await waitFor(() => window.Cesium, 12000);
      this.onProgress("library", .8);
      const Cesium = window.Cesium;
      this.viewer = new Cesium.Viewer(this.container, {
        baseLayer: false,
        terrainProvider: new Cesium.EllipsoidTerrainProvider(),
        animation: false,
        timeline: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        baseLayerPicker: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        infoBox: false,
        selectionIndicator: false,
        requestRenderMode: false,
        contextOptions: { webgl: { alpha: true, antialias: true } },
      });
      this.viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#07111d");
      // The default Cesium skybox is visually dense at this dashboard scale.
      // Let the restrained CSS deep-space layer show through the WebGL canvas.
      this.viewer.scene.backgroundColor = Cesium.Color.TRANSPARENT;
      this.viewer.scene.globe.enableLighting = true;
      this.viewer.scene.globe.showGroundAtmosphere = true;
      this.viewer.scene.globe.dynamicAtmosphereLighting = true;
      this.viewer.scene.skyBox.show = false;
      // The stock Cesium sun sprite produces a dark halo against a transparent
      // skybox, so a controlled warm billboard is rendered instead.
      this.viewer.scene.sun.show = false;
      this.viewer.scene.moon.show = false;
      this.viewer.scene.fog.enabled = true;
      await this.setImagery("satellite");
      this.viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(126.9, 20, 19_500_000),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-89), roll: 0 },
      });
      this.installCenteredZoom();
      this.onProgress("library", 1);
      await this.waitForInitialTiles();
      this.onProgress("imagery", 1);
      this.viewer.screenSpaceEventHandler.setInputAction((movement) => {
        const picked = this.viewer.scene.pick(movement.position, 9, 9);
        const stationKey = this.stationKeyFromPick(picked);
        if (stationKey) { this.onStationSelect(stationKey); return; }
        const id = this.satelliteIdFromPick(picked);
        // A single click only activates the body; zooming toward it is the wheel's job.
        if (id) this.select(id, false, { userInitiated: true });
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      this.viewer.screenSpaceEventHandler.setInputAction((movement) => {
        const id = this.satelliteIdFromPick(this.viewer.scene.pick(movement.position, 9, 9));
        if (id) this.select(id, false, { userInitiated: true, focus: true });
      }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
      this.viewer.screenSpaceEventHandler.setInputAction((movement) => {
        this.pendingHoverPosition = Cesium.Cartesian2.clone(movement.endPosition, this.pendingHoverPosition || new Cesium.Cartesian2());
        if (this.hoverFrame) return;
        this.hoverFrame = requestAnimationFrame(() => {
          this.hoverFrame = 0;
          const screenPosition = this.pendingHoverPosition;
          const picked = screenPosition ? this.viewer.scene.pick(screenPosition, 11, 11) : null;
          this.setHovered(this.satelliteIdFromPick(picked), screenPosition);
          if (!this.hoveredId && this.stationKeyFromPick(picked)) this.viewer.scene.canvas.style.cursor = "pointer";
        });
      }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
      this.container.addEventListener("mouseleave", () => this.setHovered(null, null));

      this.addGroundStations();
      this.addSunIndicator();
      return { mode: "cesium", imagery: this.imageryMode };
    } catch (error) {
      console.warn("Cesium unavailable; Canvas fallback enabled", error);
      this.enableFallback();
      this.onProgress("library", 1);
      this.onProgress("imagery", 1);
      return { mode: "fallback", error };
    }
  }

  // Ground sites are entities with id "ground-<KEY>"; anything else is not a site.
  stationKeyFromPick(picked) {
    const id = picked?.id?.id;
    if (typeof id !== "string" || !id.startsWith("ground-")) return null;
    const key = id.slice("ground-".length);
    return this.stations[key] ? key : null;
  }

  satelliteIdFromPick(picked) {
    const value = picked?.id?.properties?.satelliteId?.getValue?.()
      || picked?.id?.satelliteId
      || picked?.primitive?.id?.satelliteId;
    return value == null ? null : String(value);
  }

  basePointSize() {
    return this.items.length > 10_000 ? 2.4 : this.items.length > 2000 ? 3 : this.items.length > 200 ? 4.5 : 6.5;
  }

  // SDC changes opacity only. Keep the original marker size and zoom scaling in every mode.
  setSdcMode(enabled) {
    enabled = Boolean(enabled);
    if (this.sdcMode === enabled) return;
    this.sdcMode = enabled;
    this.entities.forEach((_, id) => {
      if (this.records.get(id)?.item.node === true && id !== this.selectedId && id !== this.hoveredId) this.restorePointStyle(id);
    });
    this.viewer?.scene.requestRender();
    this.lastFallbackDrawMs = 0;
  }

  highlightPoint(id, kind) {
    const point = this.entities.get(id);
    if (!point || !window.Cesium) return;
    point.pixelSize = kind === "selected" ? Math.max(8, this.basePointSize() * 2.6) : Math.max(7, this.basePointSize() * 2.2);
    point.color = window.Cesium.Color.fromCssColorString(this.palette()[kind]);
    point.outlineWidth = 0;
  }

  // Catalogue alpha of a point, dimmed while another body is selected.
  pointAlpha(id, item) {
    if (this.sdcMode && item?.node === true) return 1;
    const alpha = satelliteAlpha(item, this.items.length > 1000);
    return this.selectedId && this.selectedId !== String(id) ? alpha * SELECTION_DIM : alpha;
  }

  restorePointStyle(id) {
    const point = this.entities.get(String(id));
    const item = this.records.get(String(id))?.item;
    if (!point || !item || !window.Cesium) return;
    point.pixelSize = this.basePointSize();
    point.color = window.Cesium.Color.fromCssColorString(satelliteColor(item, this.theme)).withAlpha(this.pointAlpha(id, item));
    point.outlineWidth = 0;
  }

  // Every point except the selected and hovered ones takes the style for the current selection state.
  restoreBackgroundPoints() {
    this.entities.forEach((_, id) => {
      if (id !== this.selectedId && id !== this.hoveredId) this.restorePointStyle(id);
    });
  }

  setHovered(id, screenPosition) {
    id = id && this.records.has(String(id)) ? String(id) : null;
    if (id !== this.hoveredId) {
      const previous = this.hoveredId;
      this.hoveredId = id;
      if (previous && previous !== this.selectedId) this.restorePointStyle(previous);
      if (id && id !== this.selectedId) {
        this.highlightPoint(id, "hover");
      }
      this.viewer?.scene.requestRender();
    }
    this.container.style.cursor = id ? "pointer" : "";
    if (this.viewer?.scene?.canvas) this.viewer.scene.canvas.style.cursor = id ? "pointer" : "";
    if (!id) {
      this.onHover(null);
      return;
    }
    const entry = this.records.get(id);
    const position = this.positions.get(id) || this.positionAt(id, this.currentDate || new Date());
    this.onHover({
      id,
      item: entry.item,
      position,
      screen: screenPosition ? { x: screenPosition.x, y: screenPosition.y } : null,
    });
  }

  waitForInitialTiles(timeout = 12000) {
    if (!this.viewer) return Promise.resolve();
    return new Promise((resolve) => {
      let sawLoading = false;
      let settled = false;
      const finish = () => { if (settled) return; settled = true; remove?.(); resolve(); };
      const remove = this.viewer.scene.globe.tileLoadProgressEvent.addEventListener((remaining) => {
        if (remaining > 0) sawLoading = true;
        if (sawLoading && remaining === 0) finish();
      });
      this.viewer.scene.requestRender();
      setTimeout(finish, timeout);
    });
  }

  installCenteredZoom() {
    if (!this.viewer) return;
    const Cesium = window.Cesium;
    const scene = this.viewer.scene;
    const camera = scene.camera;
    const controller = scene.screenSpaceCameraController;

    // Cesium's default wheel zoom changes its pivot with the pointer position.
    // Keep touch pinch support, but make the mouse wheel scale the camera around
    // the Earth's center so the globe never slides sideways while zooming.
    controller.zoomEventTypes = [Cesium.CameraEventType.PINCH];
    // Native drag/pinch retains inertia; wheel motion below is separately eased.
    controller.inertiaZoom = .75;
    controller.inertiaSpin = .86;
    controller.inertiaTranslate = .82;
    controller.maximumMovementRatio = .08;
    controller.minimumZoomDistance = 100_000;
    controller.maximumZoomDistance = 1_200_000_000;
    scene.completeMorphOnUserInput = false;

    this.zoomFrameRemover?.();
    this.zoomFrameRemover = scene.preUpdate?.addEventListener(() => this.advanceZoom());
    scene.canvas?.addEventListener?.('pointerdown', () => {
      if (this.sceneTransitioning || scene.mode === Cesium.SceneMode.MORPHING) return;
      this.cancelCameraMotion();
      camera.cancelFlight?.();
      this.onCameraInput();
    }, { capture: true });
    this.viewer.screenSpaceEventHandler.setInputAction(delta => this.zoomBy(delta), Cesium.ScreenSpaceEventType.WHEEL);
  }

  zoomBy(delta) {
    if (!this.viewer) return false;
    const { scene, camera } = this.viewer, Cesium = window.Cesium;
    const wheelDelta = Number(delta);
    if (!Number.isFinite(wheelDelta) || !wheelDelta) return false;
    if (this.sceneTransitioning || scene.mode === Cesium.SceneMode.MORPHING) return false;
    if (this.wheelOverride?.(wheelDelta)) {
      this.cancelCameraMotion();
      scene.requestRender();
      return true;
    }
    camera.cancelFlight?.();
    const map = scene.mode === Cesium.SceneMode.SCENE2D;
    this.rangeMotion.wheel(this.zoomDistance(), wheelDelta, {
      minimum: map ? 1000 : 6_498_137, maximum: map ? 40_000_000 : 1_006_378_137,
    });
    this.zoomMode = scene.mode;
    this.zoomStamp = this.motionNow();
    scene.requestRender();
    return true;
  }

  zoomDistance() {
    if (!this.viewer) return NaN;
    const { camera, scene } = this.viewer, Cesium = window.Cesium;
    return scene.mode === Cesium.SceneMode.SCENE2D
      ? camera.frustum.right - camera.frustum.left : Cesium.Cartesian3.magnitude(camera.positionWC);
  }

  setZoomDistance(distance) {
    if (!this.viewer || !Number.isFinite(distance)) return false;
    const { scene, camera } = this.viewer, Cesium = window.Cesium;
    if (this.sceneTransitioning || scene.mode === Cesium.SceneMode.MORPHING) return false;
    const map = scene.mode === Cesium.SceneMode.SCENE2D;
    camera.cancelFlight?.();
    this.rangeMotion.moveTo(this.zoomDistance(), Math.max(map ? 1000 : 6_498_137, Math.min(map ? 40_000_000 : 1_006_378_137, distance)));
    this.zoomMode = scene.mode;
    this.zoomStamp = this.motionNow();
    scene.requestRender();
    return true;
  }

  cancelCameraMotion() { this.rangeMotion.cancel(); }

  advanceZoom() {
    if (!this.viewer || !this.rangeMotion.active) return;
    const { scene, camera } = this.viewer, Cesium = window.Cesium;
    if (this.sceneTransitioning || scene.mode !== this.zoomMode || (scene.canvas && (!scene.canvas.clientWidth || !scene.canvas.clientHeight))) {
      this.cancelCameraMotion(); return;
    }
    const current = this.zoomDistance(), distance = this.rangeMotion.advance(current);
    const now = this.motionNow(), dt = Math.max(0, Math.min(50, now - this.zoomStamp));
    this.zoomStamp = now;
    if (!(current > 0) || !Number.isFinite(distance)) return;
    if (scene.mode === Cesium.SceneMode.SCENE2D) {
      const amount = current - distance;
      if (amount > 0) camera.zoomIn(amount); else if (amount < 0) camera.zoomOut(-amount);
    } else {
      const destination = Cesium.Cartesian3.multiplyByScalar(camera.positionWC, distance / current, new Cesium.Cartesian3());
      const goal = { x: -destination.x, y: -destination.y, z: -destination.z };
      const direction = cameraDirection(camera.directionWC, goal, -Math.expm1(-dt / 150));
      const basis = cameraBasis(direction, camera.upWC);
      camera.setView({ destination, orientation: {
        direction: new Cesium.Cartesian3(basis.direction.x, basis.direction.y, basis.direction.z),
        up: new Cesium.Cartesian3(basis.up.x, basis.up.y, basis.up.z),
      } });
    }
    scene.requestRender();
  }

  flyTo(options) {
    if (!this.viewer) return false;
    const { scene, camera } = this.viewer, Cesium = window.Cesium;
    if (this.sceneTransitioning || (Cesium.SceneMode && scene.mode === Cesium.SceneMode.MORPHING)) return false;
    this.cancelCameraMotion();
    this.onCameraMove();
    camera.cancelFlight?.();
    camera.flyTo({ duration: 1.4, easingFunction: cameraEase, ...options });
    return true;
  }

  enableFallback() {
    this.container.hidden = true;
    this.fallbackCanvas.hidden = false;
    this.fallbackCanvas.addEventListener("click", event => {
      const rect = this.fallbackCanvas.getBoundingClientRect();
      const x = event.clientX - rect.left, y = event.clientY - rect.top;
      const closest = (this.fallbackPoints || []).reduce((best, point) => {
        const distance = Math.hypot(point.x - x, point.y - y);
        return distance < (best?.distance ?? 10) ? { ...point, distance } : best;
      }, null);
      if (closest) this.select(closest.id, false, { userInitiated: true });
    });
    const render = () => {
      this.drawFallback();
      this.fallbackFrame = requestAnimationFrame(render);
    };
    render();
  }

  async setSatellites(items) {
    const generation = ++this.catalogGeneration;
    this.items = items || [];
    this.hoveredId = null;
    this.onHover(null);
    this.records.clear();
    this.positions.clear();
    this.lastMassUpdateMs = 0;
    const highestApogee = this.items.reduce((highest, item) => Math.max(highest, Number(item.APOGEE_KM || item.altitude_km || 0) || 0), 0);
    this.catalogRadiusMeters = Math.max(7_000_000, (6_378.137 + highestApogee) * 1000);
    if (this.viewer) {
      this.viewer.entities.removeAll();
      const primitives = this.viewer.scene.primitives;
      if (this.pointCollection) primitives.remove(this.pointCollection);
      if (this.labelCollection) primitives.remove(this.labelCollection);
      if (this.stationLinkCollection) primitives.remove(this.stationLinkCollection);
      this.stationLinkCollection = null;
      this.stationLinkFrameRemover?.();
      this.stationLinkFrameRemover = null;
      this.pointCollection = primitives.add(new window.Cesium.PointPrimitiveCollection());
      this.labelCollection = primitives.add(new window.Cesium.LabelCollection());
      this.selectedLabel = null;
      this.entities.clear(); this.labels.clear(); this.paths.clear();
      this.selectedPath = null; this.coverageEntity = null; this.stationLinks = []; this.stationLink = null;
      this.addGroundStations();
      this.addSunIndicator();
    }
    let parseErrors = 0;
    for (let index = 0; index < this.items.length; index++) {
      const item = this.items[index];
      const id = String(item.NORAD_CAT_ID || index + 1);
      let record = null;
      if (this.satelliteLib && !item.demo) {
        try { record = this.satelliteLib.json2satrec(item); } catch (error) { parseErrors += 1; }
      }
      this.records.set(id, { item, record, index });
      if (this.viewer) this.addCesiumEntity(id, item, index);
      if (index > 0 && index % 1500 === 0) {
        this.onProgress("propagation", index / this.items.length, `${index.toLocaleString()} / ${this.items.length.toLocaleString()}`);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (generation !== this.catalogGeneration) return;
      }
    }
    this.onProgress("propagation", 1);
    if (parseErrors) console.warn(`OMM parse failed for ${parseErrors}/${this.items.length} objects`);
    if (this.selectedId && !this.records.has(this.selectedId)) this.selectedId = null;
    this.update(this.currentDate, false);
    const targetId = this.selectedId || (this.items[0] ? String(this.items[0].NORAD_CAT_ID || 1) : null);
    if (targetId) this.select(targetId, false);
    if (this.viewer && this.items.length && !this.hasFramedCatalog) { this.home(.9); this.hasFramedCatalog = true; }
  }

  addCesiumEntity(id, item, index) {
    const Cesium = window.Cesium;
    const color = Cesium.Color.fromCssColorString(satelliteColor(item, this.theme));
    const baseSize = this.basePointSize();
    const alpha = this.pointAlpha(id, item);
    const point = this.pointCollection.add({
      show: false,
      position: Cesium.Cartesian3.fromDegrees(0, 0, 700_000),
      pixelSize: baseSize,
      color: color.withAlpha(alpha),
      outlineColor: Cesium.Color.TRANSPARENT,
      outlineWidth: 0,
      scaleByDistance: new Cesium.NearFarScalar(1e6, 1.35, 5e8, .58),
      // Keep every catalog object loaded, but let the opaque globe occlude
      // satellites on the far side of Earth at every camera distance.
      disableDepthTestDistance: 0,
      id: { satelliteId: id },
    });
    this.entities.set(id, point);
    if (item.node === true || this.items.length <= 80) {
      const label = this.labelCollection.add({
        position: point.position,
        text: item.OBJECT_NAME,
        font: "600 12px Segoe UI",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.fromCssColorString("#061528"),
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -18),
        scaleByDistance: new Cesium.NearFarScalar(1e6, 1, 8e7, .38),
        disableDepthTestDistance: 0,
        show: false,
        id: { satelliteId: id },
      });
      this.labels.set(id, label);
    }
  }

  positionAt(id, date) {
    return positionAt(this.records.get(String(id)), this.satelliteLib, date);
  }

  // User-created ODT nodes keep their names in all three consoles, even in a large GP catalog.
  // Selection keeps the existing filter exception; missing positions never leave stale labels.
  shouldShowLabel(id, hasPosition = this.positions.has(id)) {
    const selected = id === this.selectedId;
    const visible = this.visibleIds === null || this.visibleIds.has(id) || selected;
    return hasPosition && visible && (selected || this.labelsVisible || this.records.get(id)?.item.node === true);
  }

  setVisibleSatellites(ids) {
    this.visibleIds = new Set(ids.map(String));
    this.entities.forEach((point, id) => { point.show = this.positions.has(id) && (this.visibleIds.has(id) || id === this.selectedId); });
    this.labels.forEach((label, id) => { label.show = this.shouldShowLabel(id); });
    this.viewer?.scene.requestRender();
    this.lastFallbackDrawMs = 0;
  }

  update(date = new Date(), rebuildPaths = false) {
    this.currentDate = date;
    this.updateSunIndicator(date);
    const Cesium = window.Cesium;
    if (this.viewer?.clock) {
      this.viewer.clock.shouldAnimate = false;
      this.viewer.clock.currentTime = Cesium.JulianDate.fromDate(date);
    }
    const timestamp = date.getTime();
    const updateAll = this.records.size <= 2500 || rebuildPaths || !this.lastMassUpdateMs || Math.abs(timestamp - this.lastMassUpdateMs) >= 5000;
    const updateOne = (_, id) => {
      const position = this.positionAt(id, date);
      const point = this.entities.get(id);
      const label = this.labels.get(id);
      const visible = this.visibleIds === null || this.visibleIds.has(id) || id === this.selectedId;
      if (point) point.show = !!position && visible;
      if (label) label.show = this.shouldShowLabel(id, !!position);
      if (id === this.selectedId && this.selectedLabel) this.selectedLabel.show = !!position && !label;
      if (!position) {
        this.positions.delete(id);
        if (id === this.selectedId && this.selectedPath) this.selectedPath.polyline.show = false;
        this.onPosition(id, null);
        return;
      }
      this.positions.set(id, position);
      if (id === this.selectedId && this.selectedPath) this.selectedPath.polyline.show = this.tracksVisible && this.selectedPathId === id;
      this.onPosition(id, position);
      const cartesian = Cesium?.Cartesian3.fromDegrees(position.longitude, position.latitude, position.altitude * 1000);
      if (point && cartesian) point.position = cartesian;
      if (label && cartesian) label.position = cartesian;
      if (id === this.selectedId && this.selectedLabel && cartesian) this.selectedLabel.position = cartesian;
    };
    if (updateAll) {
      this.records.forEach(updateOne);
      this.lastMassUpdateMs = timestamp;
    } else if (this.selectedId) {
      const selected = this.records.get(this.selectedId);
      if (selected) updateOne(selected, this.selectedId);
    }
    if (rebuildPaths && this.viewer && this.selectedId) this.rebuildPath(this.selectedId, date);
    if (this.selectedId && this.viewer) this.updateSelectedGeometry(this.selectedId, date);
    this.viewer?.scene.requestRender();
  }

  rebuildPath(id, date) {
    const Cesium = window.Cesium;
    if (this.selectedPath) this.selectedPath.polyline.show = false;
    this.selectedPathId = null;
    this.selectedPathPositions = [];
    const entry = this.records.get(String(id));
    if (!entry) return;
    const periodMinutes = entry.item.demo === true
      ? 2 * Math.PI * Math.sqrt((6378.137 + Number(entry.item.altitude_km)) ** 3 / 398600.4418) / 60
      : 1440 / Number(entry.item.MEAN_MOTION);
    if (!Number.isFinite(periodMinutes) || periodMinutes <= 0) return;
    // Straight segments sag below the true arc by up to a few kilometres at the coarse step, which
    // is visible next to a real-size body. Sample one second apart around the reference time so
    // the line passes through the body; the owner rebuilds well within that dense window.
    const offsets = [];
    const halfPeriodMs = periodMinutes * 30_000;
    const coarseStepMs = periodMinutes * 60_000 / 120;
    for (let t = -halfPeriodMs; t <= halfPeriodMs + 1; t += coarseStepMs) {
      if (Math.abs(t) > PATH_DENSE_HALF_WINDOW_MS) offsets.push(t);
    }
    const denseHalf = Math.min(PATH_DENSE_HALF_WINDOW_MS, halfPeriodMs);
    for (let t = -denseHalf; t <= denseHalf; t += PATH_DENSE_STEP_MS) offsets.push(t);
    offsets.sort((a, b) => a - b);
    const points = [];
    for (const offset of offsets) {
      const position = this.positionAt(id, new Date(date.getTime() + offset));
      if (!position) { points.length = 0; break; }
      points.push(Cesium.Cartesian3.fromDegrees(position.longitude, position.latitude, position.altitude * 1000));
    }
    this.selectedPathPositions = points;
    this.selectedPathId = points.length > 1 ? String(id) : null;
    if (!this.selectedPath) {
      this.selectedPath = this.viewer.entities.add({
        id: "selected-orbit-path",
        polyline: {
          positions: this.dynamicPositions(() => this.selectedPathPositions),
          width: 3,
          material: this.pathMaterial(),
          arcType: Cesium.ArcType.NONE,
          show: this.tracksVisible && points.length > 1,
        },
      });
    } else {
      if (!Cesium.CallbackProperty) this.selectedPath.polyline.positions = points;
      this.selectedPath.polyline.material = this.pathMaterial();
      this.selectedPath.polyline.show = this.tracksVisible && points.length > 1;
    }
  }

  // Polyline positions that change at runtime are exposed through a CallbackProperty so Cesium
  // updates the existing line each frame instead of rebuilding a batched primitive, which flickers.
  dynamicPositions(getter) {
    const Cesium = window.Cesium;
    return Cesium?.CallbackProperty ? new Cesium.CallbackProperty(getter, false) : getter();
  }

  select(id, fly = true, context = {}) {
    id = String(id);
    const entry = this.records.get(id);
    if (!entry) return;
    const Cesium = window.Cesium;
    const previousId = this.selectedId;
    this.selectedId = id;
    if (previousId) this.restorePointStyle(previousId);
    else this.restoreBackgroundPoints();
    const previousLabel = previousId ? this.labels.get(previousId) : null;
    if (previousLabel) { previousLabel.show = this.shouldShowLabel(previousId); previousLabel.fillColor = Cesium.Color.WHITE; }
    if (this.visibleIds) this.setVisibleSatellites([...this.visibleIds]);
    this.highlightPoint(id, "selected");
    if (this.hoveredId && this.hoveredId !== id) {
      this.highlightPoint(this.hoveredId, "hover");
    }
    const position = this.positionAt(id, this.currentDate);
    const selectedLabel = this.labels.get(id);
    if (selectedLabel) { selectedLabel.show = !!position; selectedLabel.fillColor = Cesium.Color.fromCssColorString(this.palette().selected); }
    if (this.selectedLabel) this.selectedLabel.show = false;
    if (this.viewer && this.items.length > 80 && this.labelCollection && !selectedLabel) {
      if (!this.selectedLabel) {
        this.selectedLabel = this.labelCollection.add({
          position: Cesium.Cartesian3.fromDegrees(0, 0, 700_000),
          text: "",
          font: "700 12px Segoe UI",
          fillColor: Cesium.Color.fromCssColorString(this.palette().selected),
          outlineColor: Cesium.Color.fromCssColorString("#061528"),
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -17),
          scaleByDistance: new Cesium.NearFarScalar(1e6, 1, 5e8, .42),
          disableDepthTestDistance: 0,
          show: true,
        });
      }
      this.selectedLabel.text = entry.item.OBJECT_NAME;
      this.selectedLabel.id = { satelliteId: id };
      this.selectedLabel.show = !!position;
      if (position) this.selectedLabel.position = Cesium.Cartesian3.fromDegrees(position.longitude, position.latitude, position.altitude * 1000);
    }
    if (fly && this.viewer && position) {
      this.flyTo({
        destination: window.Cesium.Cartesian3.fromDegrees(position.longitude, position.latitude, Math.max(1_500_000, position.altitude * 1000 * 4)),
        duration: 1.2,
      });
    }
    if (this.viewer) {
      this.rebuildPath(id, this.currentDate);
      this.updateSelectedGeometry(id, this.currentDate);
    }
    this.onSelect(entry.item, position, id, context);
  }

  home(duration = 1.4) {
    if (!this.viewer) return;
    const Cesium = window.Cesium;
    if (this.sceneTransitioning || (Cesium.SceneMode && this.viewer.scene.mode === Cesium.SceneMode.MORPHING)) return;
    if (Cesium.SceneMode && this.viewer.scene.mode === Cesium.SceneMode.SCENE2D) {
      this.cancelCameraMotion();
      this.onCameraMove();
      this.viewer.camera.cancelFlight?.();
      this.viewer.camera.flyHome(duration);
      return;
    }
    const canvas = this.viewer.scene.canvas;
    const aspect = Math.max(1, canvas.clientWidth / Math.max(1, canvas.clientHeight));
    const halfFov = Math.atan(Math.tan((this.viewer.camera.frustum.fov || Math.PI / 3) / 2) / aspect);
    // Fit a low-orbit shell to the shorter viewport dimension, not the
    // highest-apogee object in the complete catalogue.
    const altitude = 8_000_000 / Math.sin(halfFov) * 1.06 - 6_378_137;
    this.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(126.9, 20, altitude),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-89), roll: 0 },
      duration,
    });
  }

  async setSceneMode(mode) {
    if (!this.viewer) return;
    const Cesium = window.Cesium;
    const { scene, camera } = this.viewer;
    this.cancelCameraMotion();
    const revision = ++this.sceneTransitionRevision;
    // Cesium's 2D -> 3D transition briefly reports SCENE2D while its first
    // camera flight runs. scene.mode alone cannot identify an active morph.
    if (this.sceneTransitioning || scene.mode === Cesium.SceneMode.MORPHING) scene.completeMorph();
    camera.cancelFlight();
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    if (this.sunElement && mode === "2d") this.sunElement.hidden = true;
    const target = mode === "2d" ? Cesium.SceneMode.SCENE2D : Cesium.SceneMode.SCENE3D;
    this.sceneTransitioning = true;
    if (scene.mode !== target) {
      await new Promise(resolve => {
        const remove = scene.morphComplete.addEventListener(() => { remove(); resolve(); });
        if (mode === "2d") scene.morphTo2D(1.5); else scene.morphTo3D(1.5);
      });
    }
    if (revision !== this.sceneTransitionRevision) return;
    this.sceneTransitioning = false;
    if (scene.mode !== target) return; // A newer mode switch owns the camera now.
    const is2D = target === Cesium.SceneMode.SCENE2D;
    scene.screenSpaceCameraController.enableRotate = !is2D;
    scene.screenSpaceCameraController.enableTilt = !is2D;
    scene.screenSpaceCameraController.minimumZoomDistance = is2D ? 1_000 : 100_000;
    if (is2D) {
      // Clear any heading retained from the 3D follow frame. In infinite-scroll
      // mode Cesium ignores orientation passed to setView/flyTo.
      camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      camera.direction = new Cesium.Cartesian3(0, 0, -1);
      camera.up = new Cesium.Cartesian3(0, 1, 0);
      camera.right = new Cesium.Cartesian3(1, 0, 0);
    }
    scene.requestRender();
  }

  async setImagery(mode = "satellite") {
    if (!this.viewer) return mode;
    const Cesium = window.Cesium;
    this.viewer.imageryLayers.removeAll(true);
    let provider;
    try {
      if (mode === "satellite") {
        provider = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
          "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer",
          { enablePickFeatures: false }
        );
      } else if (mode === "osm") {
        provider = new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" });
      } else {
        provider = await Cesium.TileMapServiceImageryProvider.fromUrl(
          Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII")
        );
      }
      this.imageryLayer = this.viewer.imageryLayers.addImageryProvider(provider);
      this.imageryMode = mode;
      this.applyImageryStyle();
    } catch (error) {
      console.warn(`imagery ${mode} failed`, error);
      if (mode !== "natural") return this.setImagery("natural");
    }
    return this.imageryMode;
  }

  applyImageryStyle() {
    if (!this.viewer || !this.imageryLayer) return;
    const Cesium = window.Cesium;
    const satelliteMap = this.imageryMode === "satellite";
    if (this.theme === "light") {
      // Light mode: lift the imagery instead of dimming it so the globe reads as bright as the panels.
      this.imageryLayer.brightness = satelliteMap ? 1.18 : 1.08;
      this.imageryLayer.contrast = 1.04;
      this.imageryLayer.saturation = 1.05;
      this.imageryLayer.gamma = 1.0;
      this.viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString(this.palette().globeBase);
    } else if (this.satelliteEmphasis) {
      this.imageryLayer.brightness = satelliteMap ? .56 : .66;
      this.imageryLayer.contrast = satelliteMap ? 1.28 : 1.18;
      this.imageryLayer.saturation = satelliteMap ? .5 : .58;
      this.imageryLayer.gamma = .88;
      this.viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#07111d");
    } else {
      this.imageryLayer.brightness = satelliteMap ? 1.05 : 1.0;
      this.imageryLayer.contrast = satelliteMap ? 1.08 : 1.0;
      this.imageryLayer.saturation = satelliteMap ? 1.08 : 1.0;
      this.imageryLayer.gamma = 1.0;
      this.viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#173955");
    }
    this.viewer.scene.requestRender();
  }

  toggleEmphasis() {
    this.satelliteEmphasis = !this.satelliteEmphasis;
    this.applyImageryStyle();
    return this.satelliteEmphasis;
  }

  palette() {
    return paletteFor(this.theme);
  }

  // Follow the UI theme: light mode brightens the imagery, drops the day/night shading and
  // recolours points, labels and the trajectory so they stay legible on the pale backdrop.
  setTheme(theme) {
    this.theme = theme === "light" ? "light" : "dark";
    this.lastFallbackDrawMs = 0;
    if (!this.viewer) return;
    const Cesium = window.Cesium;
    const palette = this.palette();
    const light = this.theme === "light";
    this.viewer.scene.globe.enableLighting = !light;
    this.viewer.scene.globe.dynamicAtmosphereLighting = !light;
    this.applyImageryStyle();
    this.entities.forEach((_, id) => {
      if (id !== this.selectedId && id !== this.hoveredId) this.restorePointStyle(id);
    });
    const selectedPoint = this.selectedId ? this.entities.get(this.selectedId) : null;
    if (selectedPoint) selectedPoint.color = Cesium.Color.fromCssColorString(palette.selected);
    const selectedLabel = this.selectedId ? this.labels.get(this.selectedId) : null;
    if (selectedLabel) selectedLabel.fillColor = Cesium.Color.fromCssColorString(palette.selected);
    const hoveredPoint = this.hoveredId && this.hoveredId !== this.selectedId ? this.entities.get(this.hoveredId) : null;
    if (hoveredPoint) hoveredPoint.color = Cesium.Color.fromCssColorString(palette.hover);
    if (this.selectedLabel) this.selectedLabel.fillColor = Cesium.Color.fromCssColorString(palette.selected);
    if (this.selectedPath) this.selectedPath.polyline.material = this.pathMaterial();
    this.viewer.scene.requestRender();
  }

  // The trajectory carries a dark (light theme: white) outline so it separates from points of the
  // same hue; plain colour is the fallback when the outline material is unavailable.
  pathMaterial() {
    const Cesium = window.Cesium;
    const palette = this.palette();
    const color = Cesium.Color.fromCssColorString(palette.selected).withAlpha(.95);
    if (!Cesium.PolylineOutlineMaterialProperty) return color;
    return new Cesium.PolylineOutlineMaterialProperty({
      color,
      outlineColor: Cesium.Color.fromCssColorString(palette.pathOutline).withAlpha(.9),
      outlineWidth: 1.4,
    });
  }

  addSunIndicator() {
    if (!this.viewer || !this.sunElement) return;
    this.sunElement.dataset.state = "initializing";
    if (!this.sunProjectionRemove) {
      this.sunProjectionRemove = this.viewer.scene.postRender.addEventListener(() => this.positionSunOverlay());
    }
    this.lastSunUpdateMs = 0;
    this.updateSunIndicator(this.currentDate || new Date(), true);
  }

  updateSunIndicator(date = new Date(), force = false) {
    if (!this.viewer || !this.sunElement) return;
    const timestamp = date.getTime();
    if (!force && Math.abs(timestamp - this.lastSunUpdateMs) < 60_000) return;
    const Cesium = window.Cesium;
    try {
      const julian = Cesium.JulianDate.fromDate(date);
      const inertial = Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(julian, new Cesium.Cartesian3());
      const rotation = Cesium.Transforms.computeIcrfToFixedMatrix(julian)
        || Cesium.Transforms.computeTemeToPseudoFixedMatrix(julian, new Cesium.Matrix3());
      const fixed = Cesium.Matrix3.multiplyByVector(rotation, inertial, new Cesium.Cartesian3());
      Cesium.Cartesian3.normalize(fixed, fixed);
      this.sunDirectionFixed = fixed;
      this.lastSunUpdateMs = timestamp;
    } catch (error) {
      const dayAngle = (timestamp / 86_400_000) * Math.PI * 2;
      this.sunDirectionFixed = Cesium.Cartesian3.normalize(
        Cesium.Cartesian3.fromElements(Math.cos(dayAngle), Math.sin(dayAngle), .14, new Cesium.Cartesian3()),
        new Cesium.Cartesian3(),
      );
      this.lastSunUpdateMs = timestamp;
    }
    this.positionSunOverlay(true);
  }

  positionSunOverlay(force = false) {
    if (!this.viewer || !this.sunElement || !this.sunDirectionFixed) return;
    const now = performance.now();
    if (!force && now - this.lastSunProjectionMs < 50) return;
    this.lastSunProjectionMs = now;
    const Cesium = window.Cesium;
    const scene = this.viewer.scene;
    const camera = scene.camera;
    if (scene.mode !== Cesium.SceneMode.SCENE3D || Cesium.Cartesian3.dot(camera.directionWC, this.sunDirectionFixed) <= 0) {
      this.sunElement.dataset.state = scene.mode !== Cesium.SceneMode.SCENE3D ? "2d" : "behind-camera";
      this.sunElement.hidden = true;
      return;
    }
    const ray = new Cesium.Ray(camera.positionWC, this.sunDirectionFixed);
    const blocked = Cesium.IntersectionTests.rayEllipsoid(ray, scene.globe.ellipsoid);
    if (blocked && blocked.start > 0) {
      this.sunElement.dataset.state = "earth-occluded";
      this.sunElement.hidden = true;
      return;
    }
    const virtualPoint = Cesium.Cartesian3.add(
      camera.positionWC,
      Cesium.Cartesian3.multiplyByScalar(this.sunDirectionFixed, 80_000_000, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    );
    const project = Cesium.SceneTransforms.worldToWindowCoordinates || Cesium.SceneTransforms.wgs84ToWindowCoordinates;
    const screen = project?.(scene, virtualPoint, new Cesium.Cartesian2());
    const width = scene.canvas.clientWidth;
    const height = scene.canvas.clientHeight;
    if (screen) {
      this.sunElement.dataset.x = screen.x.toFixed(1);
      this.sunElement.dataset.y = screen.y.toFixed(1);
    }
    if (!screen || screen.x < -45 || screen.y < -45 || screen.x > width + 45 || screen.y > height + 45) {
      this.sunElement.dataset.state = "offscreen";
      this.sunElement.hidden = true;
      return;
    }
    this.sunElement.style.left = `${screen.x}px`;
    this.sunElement.style.top = `${screen.y}px`;
    this.sunElement.dataset.state = "visible";
    this.sunElement.hidden = false;
  }

  addGroundStations() {
    if (!this.viewer) return;
    const Cesium = window.Cesium;
    this.stationEntities.clear();
    Object.values(this.stations).forEach((station) => {
      const entity = this.viewer.entities.add({
        id: `ground-${station.key}`,
        position: Cesium.Cartesian3.fromDegrees(station.longitude, station.latitude, (station.altitudeKm || 0) * 1000),
        point: { pixelSize: 6, color: Cesium.Color.fromCssColorString("#ffbf47"), outlineColor: Cesium.Color.WHITE, outlineWidth: 1.5, disableDepthTestDistance: 0 },
        label: {
          text: station.name,
          font: "700 11px Segoe UI",
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.fromCssColorString("#5a3a00"),
          outlineWidth: 4,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, 15),
          scaleByDistance: new Cesium.NearFarScalar(1e6, 1, 2.5e7, .5),
          translucencyByDistance: new Cesium.NearFarScalar(1.5e7, 1, 4e7, 0),
        },
      });
      this.stationEntities.set(station.key, entity);
    });
    this.styleStations();
  }

  // The observer site is the large bright marker with its label always shown; other sites are
  // smaller, and their labels fade out at catalogue-wide distances so the globe stays readable.
  styleStations() {
    const Cesium = window.Cesium;
    if (!Cesium?.Color) return;
    this.stationEntities.forEach((entity, key) => {
      const observer = key === this.observerKey;
      if (entity.point) {
        entity.point.pixelSize = observer ? 10 : 6;
        entity.point.color = Cesium.Color.fromCssColorString(observer ? "#ffd97a" : "#ffbf47").withAlpha(observer ? 1 : .85);
        entity.point.outlineWidth = observer ? 2 : 1.5;
      }
      if (entity.label) entity.label.translucencyByDistance = observer ? undefined : new Cesium.NearFarScalar(1.5e7, 1, 4e7, 0);
    });
  }

  // Camera above a ground site, looking straight down from a regional distance.
  flyToStation(key, duration = 1.2) {
    const station = this.stations[key];
    if (!station || !this.viewer) return false;
    const Cesium = window.Cesium;
    return this.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(station.longitude, station.latitude, 2_500_000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-89), roll: 0 },
      duration,
    });
  }

  setObserver(stationKey, maskDegrees = 5) {
    this.observerKey = this.stations[stationKey] ? stationKey : "SEOUL";
    this.elevationMask = maskDegrees;
    this.styleStations();
    this.updateSelectedGeometry(this.selectedId, this.currentDate);
  }

  updateSelectedGeometry(id, date = this.currentDate) {
    if (!this.viewer) return;
    this.placeStationLink(id ? this.positionAt(id, date) : null);
  }

  // Drop selection highlighting, trajectory and observer line; user-node names stay visible.
  clearSelection() {
    const previousId = this.selectedId;
    if (previousId == null) return;
    const Cesium = window.Cesium;
    this.selectedId = null;
    this.restoreBackgroundPoints();
    const label = this.labels.get(previousId);
    if (label) { label.show = this.shouldShowLabel(previousId); if (Cesium?.Color) label.fillColor = Cesium.Color.WHITE; }
    if (this.selectedLabel) this.selectedLabel.show = false;
    if (this.selectedPath) this.selectedPath.polyline.show = false;
    this.placeStationLink(null);
    this.lastFallbackDrawMs = 0;
    this.viewer?.scene.requestRender();
  }

  // One persistent observer line whose endpoints move with the body; hidden below the elevation mask.
  // It is a primitive polyline rather than an entity: entity properties are evaluated before the
  // scene's preUpdate pass that moves the body each frame, so an entity line trailed the body by one
  // frame and shook beside the real-size model. A primitive takes the positions set in that same pass.
  placeStationLink(position) {
    if (!this.viewer) return;
    const Cesium = window.Cesium;
    const station = this.stations[this.observerKey];
    const elevation = position ? this.elevationAt(position, station) : null;
    const visible = this.tracksVisible && elevation != null && elevation >= this.elevationMask;
    if (!visible) {
      if (this.stationLink) this.stationLink.show = false;
      return;
    }
    const positions = [
      Cesium.Cartesian3.fromDegrees(position.longitude, position.latitude, position.altitude * 1000),
      Cesium.Cartesian3.fromDegrees(station.longitude, station.latitude, 0),
    ];
    if (!this.stationLink) {
      const scene = this.viewer.scene;
      this.stationLinkCollection = scene.primitives.add(new Cesium.PolylineCollection());
      this.stationLink = this.stationLinkCollection.add({
        id: "selected-station-link",
        positions,
        width: 2.4,
        material: this.linkMaterial(Cesium),
      });
      this.stationLinks = [this.stationLink];
      if (scene.preUpdate?.addEventListener && !this.stationLinkFrameRemover) {
        this.stationLinkFrameRemover = scene.preUpdate.addEventListener(() => this.animateStationLink());
      }
    } else {
      this.stationLink.positions = positions;
      this.stationLink.show = true;
    }
  }

  // Observer line material: flowing packets when Cesium's fabric materials are available, a plain
  // colour otherwise (Canvas fallback and test doubles).
  linkMaterial(Cesium) {
    const base = Cesium.Color.fromCssColorString("#ffbf47");
    if (typeof Cesium.Material !== "function") {
      return Cesium.Material.fromType(Cesium.Material.ColorType, { color: base.withAlpha(.75) });
    }
    return new Cesium.Material({
      translucent: true,
      fabric: {
        type: "SpaceTwinLinkFlow",
        uniforms: {
          color: base.withAlpha(.5),
          downColor: Cesium.Color.fromCssColorString("#ffd97a").withAlpha(1),
          upColor: Cesium.Color.fromCssColorString("#6fe3ff").withAlpha(1),
          spacing: LINK_PACKET_SPACING_PX,
          time: 0,
        },
        source: LINK_FLOW_SOURCE,
      },
    });
  }

  // Advance the packet phase once per frame; wall-clock driven so it keeps flowing while the analysis clock is paused.
  animateStationLink(nowMs = (typeof performance !== "undefined" ? performance.now() : Date.now())) {
    const uniforms = this.stationLink?.material?.uniforms;
    if (!uniforms || !this.stationLink.show || !("time" in uniforms)) return;
    uniforms.time = nowMs / 1000 * LINK_FLOW_RATE;
  }

  // Per-frame refresh of the selected body's marker, label and observer line so they stay on the
  // 3D model that follows the analysis clock between the once-per-second catalogue updates.
  syncSelected(date = this.currentDate) {
    const Cesium = window.Cesium;
    if (!this.viewer || !this.selectedId || !Cesium) return;
    const position = this.positionAt(this.selectedId, date);
    if (!position) return;
    this.positions.set(this.selectedId, position);
    const cartesian = Cesium.Cartesian3.fromDegrees(position.longitude, position.latitude, position.altitude * 1000);
    const point = this.entities.get(this.selectedId);
    if (point) point.position = cartesian;
    const label = this.labels.get(this.selectedId);
    if (label) label.position = cartesian;
    if (this.selectedLabel) this.selectedLabel.position = cartesian;
    this.placeStationLink(position);
  }

  elevationAt(position, station) {
    return elevationAt(position, station);
  }

  predictPasses(id, stationKey = "SEOUL", hours = 24, options = {}) {
    const station = this.stations[stationKey] || this.stations.SEOUL || Object.values(this.stations)[0];
    return predictPasses(date => {
      const position = this.positionAt(id, date);
      options.onSample?.(position, date);
      return position;
    }, station, this.currentDate, hours, options);
  }

  toggleLabels() {
    this.labelsVisible = !this.labelsVisible;
    this.labels.forEach((label, id) => { label.show = this.shouldShowLabel(id); });
    if (this.selectedLabel) this.selectedLabel.show = this.positions.has(this.selectedId) && !this.labels.has(this.selectedId);
    return this.labelsVisible;
  }

  toggleTracks() {
    this.tracksVisible = !this.tracksVisible;
    if (this.selectedPath) this.selectedPath.polyline.show = this.tracksVisible && this.selectedPathId === this.selectedId && this.positions.has(this.selectedId);
    if (this.coverageEntity) this.coverageEntity.show = this.tracksVisible;
    if (this.selectedId) this.updateSelectedGeometry(this.selectedId, this.currentDate);
    else this.stationLinks.forEach((entity) => { entity.show = false; });
    return this.tracksVisible;
  }

  drawFallback() {
    const now = performance.now();
    const interval = this.items.length > 1000 ? 1800 : 250;
    if (now - this.lastFallbackDrawMs < interval) return;
    this.lastFallbackDrawMs = now;
    const canvas = this.fallbackCanvas;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = devicePixelRatio || 1;
    if (canvas.width !== rect.width * ratio || canvas.height !== rect.height * ratio) {
      canvas.width = rect.width * ratio; canvas.height = rect.height * ratio;
    }
    const ctx = canvas.getContext("2d"); ctx.setTransform(ratio,0,0,ratio,0,0);
    const w = rect.width, h = rect.height;
    if (!w || !h) return;
    const left = 34, right = w - 12, top = 25, bottom = h - 24;
    const project = p => ({ x: left + (p.longitude + 180) / 360 * (right - left), y: bottom - (p.latitude + 90) / 180 * (bottom - top) });
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#08121d"; ctx.fillRect(0, 0, w, h);
    ctx.font = "10px Consolas"; ctx.lineWidth = 1;
    for (let longitude = -180; longitude <= 180; longitude += 60) {
      const { x } = project({ longitude, latitude: 0 });
      ctx.strokeStyle = "#253443"; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      ctx.fillStyle = "#97acbf"; ctx.fillText(String(longitude), x - 10, h - 7);
    }
    for (let latitude = -90; latitude <= 90; latitude += 30) {
      const { y } = project({ longitude: 0, latitude });
      ctx.strokeStyle = "#253443"; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
      ctx.fillStyle = "#97acbf"; ctx.fillText(String(latitude), 4, y + 3);
    }
    ctx.fillStyle = "#97acbf"; ctx.fillText("WGS84 longitude / latitude (deg) — 2D coordinate plot", left, 13);
    this.fallbackPoints = [];
    this.records.forEach((entry, id) => {
      if (this.visibleIds !== null && !this.visibleIds.has(id) && id !== this.selectedId) return;
      const position = this.positions.get(id);
      if (!position) return;
      const { x, y } = project(position);
      const selected = id === this.selectedId;
      ctx.fillStyle = selected ? this.palette().selected : satelliteColor(entry.item, this.theme);
      ctx.beginPath(); ctx.arc(x, y, selected ? 5 : this.items.length > 1000 ? 1 : 3, 0, Math.PI * 2); ctx.fill();
      this.fallbackPoints.push({ id, x, y });
      if (selected || entry.item.node === true || (this.labelsVisible && this.items.length <= 80)) {
        ctx.fillStyle = "#dbe9f8"; ctx.fillText(entry.item.OBJECT_NAME, Math.min(x + 7, right - 90), y - 7);
      }
    });
    const observer = this.stations[this.observerKey];
    const marker = project(observer);
    ctx.strokeStyle = "#ffbf47"; ctx.strokeRect(marker.x - 4, marker.y - 4, 8, 8);

  }
}
