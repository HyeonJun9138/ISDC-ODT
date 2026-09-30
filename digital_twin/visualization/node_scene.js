// Sandbox scene for user-placed satellite nodes on top of a GlobeController: a glTF model on every
// node that has one, a faint trajectory per node and OISL link lines coloured by terminal state.
// The selected node's model and follow camera belong to the caller's SatelliteModelLayer, so this
// layer hides its own model for that node. Everything is injected: the globe (viewer, records,
// positions), a Cesium provider and a time source. No application state, transport or DOM access.
import { LINK_FLOW_SOURCE } from './link_flow.js?v=20260908-oisl-flow1';

const OISL_FLOW_RATE = 1.4;
const MAX_MODELS = 64;
const PATH_SAMPLES = 120;
const PATH_REBUILD_MS = 30_000;
const VELOCITY_SAMPLE_MS = 1000;
const AMBIENT_IRRADIANCE = 0.62;
export const LINK_COLORS = Object.freeze({
  locked: '#3ddc84', one_way: '#4ac4ee', acquiring: '#ffc357', slewing: '#ffa040', blocked: '#ff6b6b', idle: '#8ea4b8', none: '#8ea4b8',
});
const PATH_ALPHA = { dark: 0.28, light: 0.45 };

export class NodeScene {
  constructor({ globe, cesium, timeSource } = {}) {
    this.globe = globe;
    this.cesiumProvider = cesium || (() => globalThis.window?.Cesium);
    this.timeSource = typeof timeSource === 'function' ? timeSource : () => new Date();
    this.models = new Map(); // node id -> { model, description, token }
    this.descriptions = new Map(); // node id -> model description or null
    this.paths = new Map(); // node id -> { entity, positions, builtAt }
    this.links = new Map(); // link key -> { line, positions, state }
    this.selectedId = null;
    this.theme = 'dark';
    this.loadToken = 0;
    this.linksVisible = true;
    this.modelsVisible = true;
  }

  get cesium() {
    return typeof this.cesiumProvider === 'function' ? this.cesiumProvider() : this.cesiumProvider;
  }

  get viewer() {
    return this.globe?.viewer || null;
  }

  // Trajectories live in their own data source so the globe's catalogue rebuild, which clears
  // the default entity collection, cannot orphan them. Falls back to viewer.entities without Cesium.
  entityCollection() {
    const Cesium = this.cesium;
    const viewer = this.viewer;
    if (!viewer) return null;
    if (this.dataSource) return this.dataSource.entities;
    if (Cesium?.CustomDataSource && viewer.dataSources?.add) {
      this.dataSource = new Cesium.CustomDataSource('node-scene');
      viewer.dataSources.add(this.dataSource);
      return this.dataSource.entities;
    }
    return viewer.entities || null;
  }

  ambientLighting(Cesium) {
    try {
      if (!Cesium.ImageBasedLighting || !Cesium.Cartesian3) return undefined;
      const coefficients = Array.from({ length: 9 }, (_, index) => index === 0
        ? new Cesium.Cartesian3(AMBIENT_IRRADIANCE, AMBIENT_IRRADIANCE, AMBIENT_IRRADIANCE * 1.05)
        : new Cesium.Cartesian3(0, 0, 0));
      return new Cesium.ImageBasedLighting({ sphericalHarmonicCoefficients: coefficients });
    } catch { return undefined; }
  }

  cartesianAt(id, date) {
    const Cesium = this.cesium;
    const position = this.globe?.positionAt?.(id, date);
    if (!position || !Cesium?.Cartesian3) return null;
    return Cesium.Cartesian3.fromDegrees(position.longitude, position.latitude, position.altitude * 1000);
  }

  // Replace the node set. descriptions: [{ id, model }] where model is a manifest match or null.
  async setNodes(entries) {
    const ids = new Set();
    for (const entry of entries || []) {
      const id = String(entry.id);
      ids.add(id);
      this.descriptions.set(id, entry.model || null);
    }
    for (const id of [...this.descriptions.keys()]) if (!ids.has(id)) this.descriptions.delete(id);
    for (const id of [...this.models.keys()]) if (!ids.has(id)) this.removeModel(id);
    for (const id of [...this.paths.keys()]) if (!ids.has(id)) this.removePath(id);
    for (const key of [...this.links.keys()]) {
      const link = this.links.get(key);
      if (!ids.has(link.a) || !ids.has(link.b)) this.removeLink(key);
    }
    await this.loadModels();
    this.update(this.timeSource(), true);
  }

  modelKey(id) {
    const description = this.descriptions.get(id);
    return description?.url ? `${description.url}|${Number(description.scale) > 0 ? description.scale : 1}` : null;
  }

  async loadModels() {
    const Cesium = this.cesium;
    const viewer = this.viewer;
    if (!Cesium?.Model?.fromGltfAsync || !viewer?.scene?.primitives) return;
    const token = ++this.loadToken;
    let count = this.models.size;
    for (const [id, description] of this.descriptions) {
      const key = this.modelKey(id);
      const existing = this.models.get(id);
      if (existing && existing.key === key) continue;
      if (existing) { this.removeModel(id); count -= 1; }
      if (!key || count >= MAX_MODELS) continue;
      count += 1;
      const scale = Number(description.scale) > 0 ? Number(description.scale) : 1;
      let model;
      try {
        model = await Cesium.Model.fromGltfAsync({
          url: description.url, id: { satelliteId: id }, scale,
          minimumPixelSize: Number(description.minimumPixelSize) || 12, allowPicking: true, show: false,
          imageBasedLighting: this.ambientLighting(Cesium),
        });
      } catch (error) {
        console.warn('node model unavailable; point marker stays', description.url, error);
        continue;
      }
      if (token !== this.loadToken || !this.descriptions.has(id) || this.modelKey(id) !== key) { model.destroy?.(); continue; }
      this.models.set(id, { model: viewer.scene.primitives.add(model), key, orientation: description.orientation || {} });
    }
  }

  removeModel(id) {
    const entry = this.models.get(id);
    if (!entry) return;
    try { this.viewer?.scene?.primitives?.remove(entry.model); } catch { /* primitive already gone */ }
    this.models.delete(id);
  }

  bodyMatrix(Cesium, id, here, date, orientation) {
    const ahead = this.cartesianAt(id, new Date(date.getTime() + VELOCITY_SAMPLE_MS));
    let rotation = null;
    if (ahead) {
      const velocity = Cesium.Cartesian3.subtract(ahead, here, new Cesium.Cartesian3());
      if (Cesium.Cartesian3.magnitude(velocity) > 1) {
        Cesium.Cartesian3.normalize(velocity, velocity);
        rotation = Cesium.Transforms.rotationMatrixFromPositionVelocity(here, velocity, Cesium.Ellipsoid.WGS84, new Cesium.Matrix3());
      }
    }
    if (!rotation) return Cesium.Transforms.eastNorthUpToFixedFrame(here);
    const { heading = 0, pitch = 0, roll = 0 } = orientation || {};
    if ((heading || pitch || roll) && Cesium.Matrix3.fromHeadingPitchRoll && Cesium.HeadingPitchRoll) {
      const trim = Cesium.Matrix3.fromHeadingPitchRoll(new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(heading), Cesium.Math.toRadians(pitch), Cesium.Math.toRadians(roll)), new Cesium.Matrix3());
      Cesium.Matrix3.multiply(rotation, trim, rotation);
    }
    return Cesium.Matrix4.fromRotationTranslation(rotation, here, new Cesium.Matrix4());
  }

  // Place every model except the selected one (owned by the caller's follow layer).
  placeModels(date) {
    const Cesium = this.cesium;
    if (!Cesium) return;
    for (const [id, entry] of this.models) {
      if (id === this.selectedId || !this.modelsVisible) { entry.model.show = false; continue; }
      const here = this.cartesianAt(id, date);
      if (!here) { entry.model.show = false; continue; }
      entry.model.modelMatrix = this.bodyMatrix(Cesium, id, here, date, entry.orientation);
      entry.model.show = true;
    }
  }

  dynamicPositions(getter) {
    const Cesium = this.cesium;
    return Cesium?.CallbackProperty ? new Cesium.CallbackProperty(getter, false) : getter();
  }

  pathColor(Cesium, id) {
    const item = this.globe?.records?.get?.(id)?.item;
    const palette = this.globe?.palette?.() || {};
    const css = palette[String(item?.ORBIT_REGIME || '').toUpperCase()] || palette.fallback || '#ff9f43';
    return Cesium.Color.fromCssColorString(css).withAlpha(PATH_ALPHA[this.theme] ?? PATH_ALPHA.dark);
  }

  periodMinutes(id) {
    const item = this.globe?.records?.get?.(id)?.item;
    const minutes = item?.PERIOD_MINUTES ?? (Number(item?.MEAN_MOTION) > 0 ? 1440 / Number(item.MEAN_MOTION) : null);
    return Number.isFinite(Number(minutes)) && Number(minutes) > 0 ? Number(minutes) : null;
  }

  // One coarse trajectory per node, rebuilt at most every 30 s; the selected node keeps the
  // globe's own dense highlighted path, so its faint line is hidden.
  rebuildPaths(date, force = false) {
    const Cesium = this.cesium;
    const entities = this.entityCollection();
    if (!Cesium?.Cartesian3 || !entities) return;
    for (const id of this.descriptions.keys()) {
      let entry = this.paths.get(id);
      if (entry && !force && Math.abs(date.getTime() - entry.builtAt) < PATH_REBUILD_MS) continue;
      const period = this.periodMinutes(id);
      const points = [];
      if (period) {
        const step = period * 60_000 / PATH_SAMPLES;
        for (let index = 0; index <= PATH_SAMPLES; index += 1) {
          const here = this.cartesianAt(id, new Date(date.getTime() + (index - PATH_SAMPLES / 2) * step));
          if (!here) { points.length = 0; break; }
          points.push(here);
        }
      }
      if (!entry) {
        entry = { entity: null, positions: points, builtAt: date.getTime() };
        entry.entity = entities.add({
          id: `node-path-${id}`,
          polyline: { positions: this.dynamicPositions(() => entry.positions), width: 1.3, material: this.pathColor(Cesium, id), arcType: Cesium.ArcType?.NONE },
        });
        this.paths.set(id, entry);
      } else {
        entry.positions = points;
        entry.builtAt = date.getTime();
        if (!Cesium.CallbackProperty) entry.entity.polyline.positions = points;
      }
      entry.entity.show = points.length > 1 && id !== this.selectedId && (this.globe?.tracksVisible !== false);
    }
  }

  removePath(id) {
    const entry = this.paths.get(id);
    if (!entry) return;
    try { this.entityCollection()?.remove(entry.entity); } catch { /* entity already gone */ }
    this.paths.delete(id);
  }

  linkMaterial(Cesium, state) {
    const color = Cesium.Color.fromCssColorString(LINK_COLORS[state] || LINK_COLORS.none);
    // A qualitative flow cue, not measured packets or an estimate of traffic volume.
    if (state === 'locked' && typeof Cesium.Material === 'function') {
      return new Cesium.Material({ translucent: true, fabric: {
        type: 'SpaceTwinLinkFlow', source: LINK_FLOW_SOURCE,
        uniforms: { color: color.withAlpha(.55),
          downColor: Cesium.Color.fromCssColorString('#e5fff2'),
          upColor: Cesium.Color.fromCssColorString('#8beaff'),
          spacing: 96, time: performance.now() / 1000 * OISL_FLOW_RATE },
      } });
    }
    if (state === 'acquiring' || state === 'slewing') {
      return Cesium.Material.fromType('PolylineDash', { color: color.withAlpha(0.9), dashLength: 12 });
    }
    return Cesium.Material.fromType('Color', { color: color.withAlpha(state === 'locked' ? 0.95 : 0.75) });
  }

  // Entity positions are evaluated before the model's Scene.preUpdate callback. Moving links
  // use primitives instead so their endpoints and the following model render in the same frame.
  linkCollection() {
    if (!this.linkPolylines && this.cesium?.PolylineCollection && this.viewer?.scene?.primitives) {
      this.linkPolylines = this.viewer.scene.primitives.add(new this.cesium.PolylineCollection());
    }
    return this.linkPolylines;
  }

  // links: [{ key, a, b, state }] with node ids as strings. Blocked and idle pairs are not drawn.
  setLinks(links) {
    const Cesium = this.cesium;
    const lines = this.linkCollection();
    if (!Cesium?.Color || !lines) return;
    const keep = new Set();
    for (const link of links || []) {
      const key = String(link.key);
      keep.add(key);
      let entry = this.links.get(key);
      if (!entry) {
        entry = { a: String(link.a), b: String(link.b), positions: [], state: null, line: null };
        entry.line = lines.add({
          id: `node-link-${key}`,
          positions: [], show: false, width: 2, material: this.linkMaterial(Cesium, link.state),
        });
        entry.material = entry.line.material;
        entry.state = link.state;
        this.links.set(key, entry);
      } else if (entry.state !== link.state) {
        entry.line.material = this.linkMaterial(Cesium, link.state);
        entry.material = entry.line.material;
        entry.state = link.state;
      }
      entry.a = String(link.a); entry.b = String(link.b);
    }
    for (const key of [...this.links.keys()]) if (!keep.has(key)) this.removeLink(key);
    this.placeLinks(this.timeSource());
  }

  placeLinks(date) {
    const Cesium = this.cesium;
    if (!Cesium) return;
    for (const entry of this.links.values()) {
      const a = this.cartesianAt(entry.a, date);
      const b = this.cartesianAt(entry.b, date);
      const drawable = !!a && !!b && this.linksVisible && entry.state !== 'blocked' && entry.state !== 'idle' && entry.state !== 'none';
      if (drawable) {
        entry.positions = [a, b];
        entry.line.positions = entry.positions;
      }
      entry.line.show = drawable;
    }
  }

  removeLink(key) {
    const entry = this.links.get(key);
    if (!entry) return;
    try { this.linkPolylines?.remove(entry.line); } catch { /* primitive already gone */ }
    this.links.delete(key);
  }

  select(id) {
    this.selectedId = id == null ? null : String(id);
    const date = this.timeSource();
    this.placeModels(date);
    for (const [pathId, entry] of this.paths) {
      entry.entity.show = entry.positions.length > 1 && pathId !== this.selectedId && (this.globe?.tracksVisible !== false);
    }
  }

  setLinksVisible(visible) {
    this.linksVisible = visible !== false;
    this.placeLinks(this.timeSource());
    return this.linksVisible;
  }

  setModelsVisible(visible) {
    this.modelsVisible = visible !== false;
    this.placeModels(this.timeSource());
    return this.modelsVisible;
  }

  setTheme(theme) {
    this.theme = theme === 'light' ? 'light' : 'dark';
    const Cesium = this.cesium;
    if (!Cesium?.Color) return;
    for (const [id, entry] of this.paths) entry.entity.polyline.material = this.pathColor(Cesium, id);
  }

  // Once-per-tick refresh: models, link endpoints and (when due) trajectories.
  update(date = this.timeSource(), rebuildPaths = false) {
    this.placeModels(date);
    this.placeLinks(date);
    this.rebuildPaths(date, rebuildPaths);
  }

  // Per-frame refresh while the follow camera runs, so neighbours do not step once a second.
  syncFrame(date) {
    this.placeModels(date);
    this.placeLinks(date);
    this.animateLinkFlow();
  }

  animateLinkFlow(nowMs = performance.now()) {
    for (const entry of this.links.values()) {
      const uniforms = entry.line.material?.uniforms;
      if (entry.line.show && entry.state === 'locked' && uniforms && 'time' in uniforms) {
        uniforms.time = nowMs / 1000 * OISL_FLOW_RATE;
      }
    }
  }

  clear() {
    this.loadToken += 1;
    for (const id of [...this.models.keys()]) this.removeModel(id);
    for (const id of [...this.paths.keys()]) this.removePath(id);
    for (const key of [...this.links.keys()]) this.removeLink(key);
    if (this.linkPolylines) {
      this.viewer?.scene?.primitives?.remove(this.linkPolylines);
      this.linkPolylines = null;
    }
    this.descriptions.clear();
    this.selectedId = null;
  }
}
