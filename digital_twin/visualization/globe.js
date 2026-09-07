import { positionAt, elevationAt, predictPasses } from "/static/simulation/orbit.js";

const ORBIT_COLORS = {
  LEO: "#ff9f43",
  MEO: "#e6ed55",
  GEO: "#5ee277",
  HEO: "#53c8ff",
};
const DEFAULT_SATELLITE_COLOR = "#ff9f43";
const SELECTED_SATELLITE_COLOR = "#efff62";
const HOVER_SATELLITE_COLOR = "#ffffff";

function satelliteColor(item) {
  return ORBIT_COLORS[String(item?.ORBIT_REGIME || "").toUpperCase()] || DEFAULT_SATELLITE_COLOR;
}

function satelliteAlpha(item, largeCatalog) {
  const epochAge = Number(item?.EPOCH_AGE_HOURS);
  return Number.isFinite(epochAge) && epochAge > 72 ? .56 : largeCatalog ? .9 : .98;
}

const GROUND_STATIONS = {
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
    this.coverageEntity = null;
    this.stationLinks = [];
    this.sunElement = options.sunElement || document.querySelector("#space-sun");
    this.sunDirectionFixed = null;
    this.sunProjectionRemove = null;
    this.lastSunUpdateMs = 0;
    this.lastSunProjectionMs = 0;
    this.imageryLayer = null;
    this.imageryMode = "satellite";
    this.positions = new Map();
    this.labelsVisible = true;
    this.tracksVisible = true;
    this.satelliteEmphasis = true;
    this.selectedId = null;
    this.hoveredId = null;
    this.hoverFrame = 0;
    this.pendingHoverPosition = null;
    this.currentDate = new Date();
    this.fallbackFrame = null;
    this.lastFallbackDrawMs = 0;
    this.lastMassUpdateMs = 0;
    this.catalogRadiusMeters = 42_500_000;
  }

  async init() {
    try {
      await waitFor(() => window.Cesium, 12000);
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
      await this.waitForInitialTiles();
      this.viewer.screenSpaceEventHandler.setInputAction((movement) => {
        const picked = this.viewer.scene.pick(movement.position, 9, 9);
        const id = this.satelliteIdFromPick(picked);
        if (id) this.select(id, false, { userInitiated: true });
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      this.viewer.screenSpaceEventHandler.setInputAction((movement) => {
        this.pendingHoverPosition = Cesium.Cartesian2.clone(movement.endPosition, this.pendingHoverPosition || new Cesium.Cartesian2());
        if (this.hoverFrame) return;
        this.hoverFrame = requestAnimationFrame(() => {
          this.hoverFrame = 0;
          const screenPosition = this.pendingHoverPosition;
          const picked = screenPosition ? this.viewer.scene.pick(screenPosition, 11, 11) : null;
          this.setHovered(this.satelliteIdFromPick(picked), screenPosition);
        });
      }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
      this.container.addEventListener("mouseleave", () => this.setHovered(null, null));

      try {
        this.satelliteLib = await import("https://cdn.jsdelivr.net/npm/satellite.js@7.0.1/+esm");
      } catch (error) {
        console.warn("satellite.js unavailable; synthetic propagation enabled", error);
      }
      this.addGroundStations();
      this.addSunIndicator();
      return { mode: "cesium", imagery: this.imageryMode };
    } catch (error) {
      console.warn("Cesium unavailable; Canvas fallback enabled", error);
      this.enableFallback();
      return { mode: "fallback", error };
    }
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

  restorePointStyle(id) {
    const point = this.entities.get(String(id));
    const item = this.records.get(String(id))?.item;
    if (!point || !item || !window.Cesium) return;
    point.pixelSize = this.basePointSize();
    point.color = window.Cesium.Color.fromCssColorString(satelliteColor(item)).withAlpha(satelliteAlpha(item, this.items.length > 1000));
    point.outlineWidth = 0;
  }

  setHovered(id, screenPosition) {
    id = id && this.records.has(String(id)) ? String(id) : null;
    if (id !== this.hoveredId) {
      const previous = this.hoveredId;
      this.hoveredId = id;
      if (previous && previous !== this.selectedId) this.restorePointStyle(previous);
      if (id && id !== this.selectedId) {
        const point = this.entities.get(id);
        if (point) {
          point.pixelSize = Math.max(7, this.basePointSize() * 2.2);
          point.color = window.Cesium.Color.fromCssColorString(HOVER_SATELLITE_COLOR);
          point.outlineWidth = 0;
        }
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
    controller.inertiaZoom = 0;
    controller.minimumZoomDistance = 100_000;
    controller.maximumZoomDistance = 1_200_000_000;

    this.viewer.screenSpaceEventHandler.setInputAction((delta) => {
      const wheelDelta = Number(delta) || 0;
      if (!wheelDelta) return;

      if (scene.mode !== Cesium.SceneMode.SCENE3D) {
        const height = Math.max(1_000, Number(camera.positionCartographic?.height || 1_000_000));
        const amount = Math.min(8_000_000, Math.max(1_000, height * .16));
        if (wheelDelta > 0) camera.zoomIn(amount); else camera.zoomOut(amount);
        scene.requestRender();
        return;
      }

      const anchor = Cesium.Cartesian3.ZERO;
      const offset = Cesium.Cartesian3.subtract(camera.positionWC, anchor, new Cesium.Cartesian3());
      const distance = Cesium.Cartesian3.magnitude(offset);
      if (!Number.isFinite(distance) || distance < 1) return;

      const normalizedDelta = Math.max(-240, Math.min(240, wheelDelta));
      const minimumCenterDistance = 6_378_137 + 120_000;
      const maximumCenterDistance = 1_006_378_137;
      const nextDistance = Math.max(minimumCenterDistance, Math.min(maximumCenterDistance, distance * Math.exp(-normalizedDelta * .0015)));
      const destination = Cesium.Cartesian3.add(
        anchor,
        Cesium.Cartesian3.multiplyByScalar(offset, nextDistance / distance, new Cesium.Cartesian3()),
        new Cesium.Cartesian3(),
      );
      const direction = Cesium.Cartesian3.normalize(
        Cesium.Cartesian3.subtract(anchor, destination, new Cesium.Cartesian3()),
        new Cesium.Cartesian3(),
      );
      let right = Cesium.Cartesian3.cross(direction, camera.upWC, new Cesium.Cartesian3());
      if (Cesium.Cartesian3.magnitudeSquared(right) < Cesium.Math.EPSILON10) right = Cesium.Cartesian3.clone(camera.rightWC);
      Cesium.Cartesian3.normalize(right, right);
      const up = Cesium.Cartesian3.normalize(Cesium.Cartesian3.cross(right, direction, new Cesium.Cartesian3()), new Cesium.Cartesian3());

      camera.setView({ destination, orientation: { direction, up } });
      scene.requestRender();
    }, Cesium.ScreenSpaceEventType.WHEEL);
  }

  enableFallback() {
    this.container.hidden = true;
    this.fallbackCanvas.hidden = false;
    const render = () => {
      this.drawFallback();
      this.fallbackFrame = requestAnimationFrame(render);
    };
    render();
  }

  async setSatellites(items) {
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
      this.pointCollection = primitives.add(new window.Cesium.PointPrimitiveCollection());
      this.labelCollection = primitives.add(new window.Cesium.LabelCollection());
      this.selectedLabel = null;
      this.entities.clear(); this.labels.clear(); this.paths.clear();
      this.selectedPath = null; this.coverageEntity = null; this.stationLinks = [];
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
      if (index > 0 && index % 1500 === 0) await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    if (parseErrors) console.warn(`OMM parse failed for ${parseErrors}/${this.items.length} objects`);
    if (this.selectedId && !this.records.has(this.selectedId)) this.selectedId = null;
    this.update(new Date(), false);
    const targetId = this.selectedId || (this.items[0] ? String(this.items[0].NORAD_CAT_ID || 1) : null);
    if (targetId) this.select(targetId, false);
    if (this.viewer && this.items.length) this.home(.9);
  }

  addCesiumEntity(id, item, index) {
    const Cesium = window.Cesium;
    const color = Cesium.Color.fromCssColorString(satelliteColor(item));
    const largeCatalog = this.items.length > 1000;
    const baseSize = this.basePointSize();
    const alpha = satelliteAlpha(item, largeCatalog);
    const point = this.pointCollection.add({
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
    if (this.items.length <= 80) {
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
        show: this.labelsVisible,
        id: { satelliteId: id },
      });
      this.labels.set(id, label);
    }
  }

  positionAt(id, date) {
    return positionAt(this.records.get(String(id)), this.satelliteLib, date);
  }

  update(date = new Date(), rebuildPaths = false) {
    this.currentDate = date;
    this.updateSunIndicator(date);
    const Cesium = window.Cesium;
    const timestamp = date.getTime();
    const updateAll = this.records.size <= 2500 || rebuildPaths || !this.lastMassUpdateMs || Math.abs(timestamp - this.lastMassUpdateMs) >= 5000;
    const updateOne = (_, id) => {
      const position = this.positionAt(id, date);
      if (!position) return;
      this.positions.set(id, position);
      this.onPosition(id, position);
      const cartesian = Cesium?.Cartesian3.fromDegrees(position.longitude, position.latitude, position.altitude * 1000);
      const point = this.entities.get(id);
      if (point && cartesian) point.position = cartesian;
      const label = this.labels.get(id);
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
    const entry = this.records.get(String(id));
    if (!entry) return;
    const meanMotion = Number(entry.item.MEAN_MOTION || 15.2);
    const periodMinutes = Math.min(1440, Math.max(80, 1440 / meanMotion));
    const points = [];
    for (let i = 0; i <= 120; i++) {
      const sample = new Date(date.getTime() + ((i / 120) * periodMinutes - periodMinutes / 2) * 60_000);
      const position = this.positionAt(id, sample);
      if (position) points.push(Cesium.Cartesian3.fromDegrees(position.longitude, position.latitude, position.altitude * 1000));
    }
    const entryColor = SELECTED_SATELLITE_COLOR;
    if (!this.selectedPath) {
      this.selectedPath = this.viewer.entities.add({
        id: "selected-orbit-path",
        polyline: {
          positions: points,
          width: 2.2,
          material: Cesium.Color.fromCssColorString(entryColor).withAlpha(.78),
          arcType: Cesium.ArcType.NONE,
          show: this.tracksVisible,
        },
      });
    } else {
      this.selectedPath.polyline.positions = points;
      this.selectedPath.polyline.material = Cesium.Color.fromCssColorString(entryColor).withAlpha(.78);
      this.selectedPath.polyline.show = this.tracksVisible;
    }
  }

  select(id, fly = true, context = {}) {
    id = String(id);
    const entry = this.records.get(id);
    if (!entry) return;
    const Cesium = window.Cesium;
    const baseSize = this.basePointSize();
    const previousId = this.selectedId;
    if (previousId) this.restorePointStyle(previousId);
    const previousLabel = previousId ? this.labels.get(previousId) : null;
    if (previousLabel) { previousLabel.show = this.labelsVisible; previousLabel.fillColor = Cesium.Color.WHITE; }
    this.selectedId = id;
    const selectedPoint = this.entities.get(id);
    if (selectedPoint) {
      selectedPoint.pixelSize = Math.max(8, baseSize * 2.6);
      selectedPoint.color = Cesium.Color.fromCssColorString(SELECTED_SATELLITE_COLOR);
      selectedPoint.outlineWidth = 0;
    }
    if (this.hoveredId && this.hoveredId !== id) {
      const hoveredPoint = this.entities.get(this.hoveredId);
      if (hoveredPoint) {
        hoveredPoint.pixelSize = Math.max(7, baseSize * 2.2);
        hoveredPoint.color = Cesium.Color.fromCssColorString(HOVER_SATELLITE_COLOR);
      }
    }
    const position = this.positions.get(id) || this.positionAt(id, new Date());
    const selectedLabel = this.labels.get(id);
    if (selectedLabel) { selectedLabel.show = true; selectedLabel.fillColor = Cesium.Color.fromCssColorString(SELECTED_SATELLITE_COLOR); }
    if (this.viewer && this.items.length > 80 && this.labelCollection) {
      if (!this.selectedLabel) {
        this.selectedLabel = this.labelCollection.add({
          position: Cesium.Cartesian3.fromDegrees(0, 0, 700_000),
          text: "",
          font: "700 12px Segoe UI",
          fillColor: Cesium.Color.fromCssColorString(SELECTED_SATELLITE_COLOR),
          outlineColor: Cesium.Color.fromCssColorString("#061528"),
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -17),
          scaleByDistance: new Cesium.NearFarScalar(1e6, 1, 5e8, .42),
          show: true,
        });
      }
      this.selectedLabel.text = entry.item.OBJECT_NAME;
      this.selectedLabel.id = { satelliteId: id };
      this.selectedLabel.show = true;
      if (position) this.selectedLabel.position = Cesium.Cartesian3.fromDegrees(position.longitude, position.latitude, position.altitude * 1000);
    }
    if (fly && this.viewer && position) {
      this.viewer.camera.flyTo({
        destination: window.Cesium.Cartesian3.fromDegrees(position.longitude, position.latitude, Math.max(1_500_000, position.altitude * 1000 * 4)),
        duration: 1.2,
      });
    }
    if (this.viewer) {
      this.rebuildPath(id, new Date());
      this.updateSelectedGeometry(id, new Date());
    }
    this.onSelect(entry.item, position, id, context);
  }

  home(duration = 1.1) {
    if (!this.viewer) return;
    const Cesium = window.Cesium;
    const radius = Math.max(7_000_000, this.catalogRadiusMeters || 42_500_000);
    const altitude = Math.min(480_000_000, Math.max(24_000_000, radius * 2.25));
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(126.9, 20, altitude),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-89), roll: 0 },
      duration,
    });
  }

  setSceneMode(mode) {
    if (!this.viewer) return;
    if (this.sunElement && mode === "2d") this.sunElement.hidden = true;
    if (mode === "2d") this.viewer.scene.morphTo2D(1.0); else this.viewer.scene.morphTo3D(1.0);
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
    if (this.satelliteEmphasis) {
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
    Object.values(GROUND_STATIONS).forEach((station) => {
      this.viewer.entities.add({
        id: `ground-${station.key}`,
        position: Cesium.Cartesian3.fromDegrees(station.longitude, station.latitude, 0),
        point: { pixelSize: 8, color: Cesium.Color.fromCssColorString("#ffbf47"), outlineColor: Cesium.Color.WHITE, outlineWidth: 2 },
        label: {
          text: station.name,
          font: "700 11px Segoe UI",
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.fromCssColorString("#5a3a00"),
          outlineWidth: 4,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, 15),
          scaleByDistance: new Cesium.NearFarScalar(1e6, 1, 2.5e7, .5),
        },
      });
    });
  }

  updateSelectedGeometry(id, date = new Date()) {
    if (!this.viewer || !this.tracksVisible) return;
    const Cesium = window.Cesium;
    const position = this.positionAt(id, date);
    if (!position) return;
    const ground = Cesium.Cartesian3.fromDegrees(position.longitude, position.latitude, 0);
    const radiusKm = Math.min(3500, Math.sqrt(Math.max(0, 2 * 6378.137 * position.altitude + position.altitude ** 2)) * .52);
    if (!this.coverageEntity) {
      this.coverageEntity = this.viewer.entities.add({
        id: "selected-coverage",
        position: ground,
        ellipse: {
          semiMajorAxis: radiusKm * 1000,
          semiMinorAxis: radiusKm * 1000,
          material: Cesium.Color.fromCssColorString("#2d7ff9").withAlpha(.09),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString("#62a7ff").withAlpha(.65),
          height: 0,
        },
      });
    } else {
      this.coverageEntity.position = ground;
      this.coverageEntity.ellipse.semiMajorAxis = radiusKm * 1000;
      this.coverageEntity.ellipse.semiMinorAxis = radiusKm * 1000;
      this.coverageEntity.show = true;
    }
    this.stationLinks.forEach((entity) => this.viewer.entities.remove(entity));
    this.stationLinks = [];
    const satelliteCartesian = Cesium.Cartesian3.fromDegrees(position.longitude, position.latitude, position.altitude * 1000);
    Object.values(GROUND_STATIONS).forEach((station) => {
      const elevation = this.elevationAt(position, station);
      if (elevation < 5) return;
      const link = this.viewer.entities.add({
        polyline: {
          positions: [satelliteCartesian, Cesium.Cartesian3.fromDegrees(station.longitude, station.latitude, 0)],
          width: 1.6,
          material: Cesium.Color.fromCssColorString("#ffbf47").withAlpha(.75),
          arcType: Cesium.ArcType.NONE,
        },
      });
      this.stationLinks.push(link);
    });
  }

  elevationAt(position, station) {
    return elevationAt(position, station);
  }

  predictPasses(id, stationKey = "SEOUL", hours = 24) {
    const station = GROUND_STATIONS[stationKey] || GROUND_STATIONS.SEOUL;
    return predictPasses(date => this.positionAt(id, date), station, this.currentDate, hours);
  }

  toggleLabels() {
    this.labelsVisible = !this.labelsVisible;
    this.labels.forEach((label, id) => { label.show = id === this.selectedId || this.labelsVisible; });
    if (this.selectedLabel) this.selectedLabel.show = true;
    return this.labelsVisible;
  }

  toggleTracks() {
    this.tracksVisible = !this.tracksVisible;
    if (this.selectedPath) this.selectedPath.polyline.show = this.tracksVisible;
    if (this.coverageEntity) this.coverageEntity.show = this.tracksVisible;
    this.stationLinks.forEach((entity) => { entity.show = this.tracksVisible; });
    return this.tracksVisible;
  }

  drawFallback() {
    const now = performance.now();
    const interval = this.items.length > 1000 ? 1800 : 250;
    if (now - this.lastFallbackDrawMs < interval) return;
    this.lastFallbackDrawMs = now;
    const canvas = this.fallbackCanvas;
    const rect = canvas.getBoundingClientRect();
    const ratio = devicePixelRatio || 1;
    if (canvas.width !== rect.width * ratio || canvas.height !== rect.height * ratio) {
      canvas.width = rect.width * ratio; canvas.height = rect.height * ratio;
    }
    const ctx = canvas.getContext("2d"); ctx.setTransform(ratio,0,0,ratio,0,0);
    const w=rect.width,h=rect.height,cx=w/2,cy=h/2,r=Math.min(w,h)*.29;
    ctx.clearRect(0,0,w,h);
    const bg=ctx.createRadialGradient(cx,cy,0,cx,cy,Math.max(w,h)*.72); bg.addColorStop(0,"#0a1624"); bg.addColorStop(1,"#02060d"); ctx.fillStyle=bg; ctx.fillRect(0,0,w,h);
    ctx.fillStyle="rgba(195,220,255,.55)";
    for(let i=0;i<54;i++){const x=(i*137+53)%Math.max(1,w),y=(i*83+29)%Math.max(1,h),size=i%11===0?1.15:.55;ctx.globalAlpha=i%7===0?.75:.35;ctx.beginPath();ctx.arc(x,y,size,0,Math.PI*2);ctx.fill();}
    ctx.globalAlpha=1;
    const earth=ctx.createRadialGradient(cx-r*.35,cy-r*.4,r*.05,cx,cy,r); earth.addColorStop(0,"#eefaff"); earth.addColorStop(.55,"#5b9cd3"); earth.addColorStop(1,"#174c7e"); ctx.fillStyle=earth; ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle="rgba(255,255,255,.38)"; ctx.lineWidth=1;
    for(let i=-2;i<=2;i++){ctx.beginPath();ctx.ellipse(cx,cy+i*r*.28,r*Math.cos(i*.28),r*.16,0,0,Math.PI*2);ctx.stroke();}
    for(let i=0;i<5;i++){ctx.beginPath();ctx.ellipse(cx,cy,r*(.72+i*.15),r*(.22+i*.055),i*.45,0,Math.PI*2);ctx.strokeStyle="rgba(63,111,161,.3)";ctx.stroke();}
    const date=new Date();
    this.records.forEach((entry,id)=>{
      const p=this.positionAt(id,date); if(!p)return; this.positions.set(id,p); this.onPosition(id,p);
      const selected=id===this.selectedId,large=this.items.length>1000;
      const x=cx+(p.longitude/180)*r*1.65; const y=cy-(p.latitude/90)*r*.95; const color=selected?SELECTED_SATELLITE_COLOR:satelliteColor(entry.item);
      ctx.fillStyle=color;ctx.beginPath();ctx.arc(x,y,selected?6:large?1.35:4.5,0,Math.PI*2);ctx.fill();
      if(this.labelsVisible&&(selected||this.items.length<=80)){ctx.fillStyle=selected?SELECTED_SATELLITE_COLOR:"#dbe9f8";ctx.font="600 10px Segoe UI";ctx.fillText(entry.item.OBJECT_NAME,x+9,y-8);}
    });
  }
}
