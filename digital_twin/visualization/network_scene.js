// Communication scene on top of the node sandbox scene: ground stations with their coverage at
// the constellation altitude, ground-to-satellite link lines, and emphasis for the computed route
// and the selected link. OISL links, models and trajectories come from NodeScene. Everything is
// injected (globe, Cesium, time source); no application state, transport or DOM access.
import { NodeScene, LINK_COLORS } from './node_scene.js?v=20260908-oisl-flow1';

export const GROUND_LINK_COLORS = Object.freeze({ usable: '#4ac4ee', visible: '#7a95ab', fault: '#ff6b6b', unusable: '#5b6f82' });
export const ROUTE_COLOR = '#a78bfa';
export const STATION_COLOR = '#ffbf47';
const ROUTE_WIDTH = 4.5;
const SELECTED_WIDTH = 4;
const BASE_WIDTH = 2;

export class NetworkScene extends NodeScene {
  constructor(options = {}) {
    super(options);
    this.stations = new Map(); // station id -> { entity, coverage, station }
    this.groundLinks = new Map(); // link id -> { line, positions, station, satellite, state }
    this.routeIds = new Set();
    this.selectedLinkId = null;
    this.groundLinksVisible = true;
    this.coverageVisible = true;
    this.coverageRadiusKm = typeof options.coverageRadiusKm === 'function' ? options.coverageRadiusKm : () => 0;
  }

  stationPosition(station) {
    const Cesium = this.cesium;
    if (!Cesium?.Cartesian3 || !station) return null;
    return Cesium.Cartesian3.fromDegrees(Number(station.longitude), Number(station.latitude), Math.max(0, Number(station.altitude_km) || 0) * 1000);
  }

  // stations: [{ id, name, latitude, longitude, altitude_km, min_elevation_deg, bands }]. Coverage is
  // the ground range inside which a satellite at the constellation altitude clears the mask.
  setStations(stations) {
    const Cesium = this.cesium;
    const entities = this.entityCollection();
    if (!Cesium?.Color || !entities) return;
    const keep = new Set();
    for (const station of stations || []) {
      const id = String(station.id);
      keep.add(id);
      const position = this.stationPosition(station);
      const radius = Math.max(0, this.coverageRadiusKm(station)) * 1000;
      let entry = this.stations.get(id);
      if (!entry) {
        const color = Cesium.Color.fromCssColorString(STATION_COLOR);
        entry = { station, entity: null, coverage: null };
        entry.entity = entities.add({
          id: `station-${id}`,
          position,
          properties: { stationId: id },
          point: { pixelSize: 10, color, outlineColor: Cesium.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: 0 },
          label: {
            text: station.name || id, font: '700 12px Segoe UI', fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.fromCssColorString('#5a3a00'), outlineWidth: 4, style: Cesium.LabelStyle?.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, 16), scaleByDistance: Cesium.NearFarScalar ? new Cesium.NearFarScalar(1e6, 1, 2.5e7, .55) : undefined,
          },
        });
        entry.coverage = entities.add({
          id: `station-coverage-${id}`,
          position,
          properties: { stationId: id },
          ellipse: { semiMajorAxis: Math.max(1, radius), semiMinorAxis: Math.max(1, radius), height: 0, material: color.withAlpha(0.07), outline: true, outlineColor: color.withAlpha(0.55), outlineWidth: 1 },
        });
        this.stations.set(id, entry);
      } else {
        entry.station = station;
        entry.entity.position = position;
        entry.coverage.position = position;
        if (entry.entity.label) entry.entity.label.text = station.name || id;
        if (entry.coverage.ellipse) { entry.coverage.ellipse.semiMajorAxis = Math.max(1, radius); entry.coverage.ellipse.semiMinorAxis = Math.max(1, radius); }
      }
      entry.coverage.show = this.coverageVisible && radius > 0;
    }
    for (const id of [...this.stations.keys()]) if (!keep.has(id)) this.removeStation(id);
    for (const key of [...this.groundLinks.keys()]) if (!keep.has(this.groundLinks.get(key).station)) this.removeGroundLink(key);
  }

  removeStation(id) {
    const entry = this.stations.get(id);
    if (!entry) return;
    const entities = this.entityCollection();
    try { entities?.remove(entry.entity); entities?.remove(entry.coverage); } catch { /* already gone */ }
    this.stations.delete(id);
  }

  // Station id under a screen position, or null. The caller owns the input handler.
  stationAt(screenPosition) {
    const viewer = this.viewer;
    if (!viewer?.scene?.pick || !screenPosition) return null;
    const picked = viewer.scene.pick(screenPosition, 7, 7);
    const value = picked?.id?.properties?.stationId;
    const id = typeof value?.getValue === 'function' ? value.getValue() : value;
    return id == null ? null : String(id);
  }

  groundMaterial(Cesium, state) {
    const css = GROUND_LINK_COLORS[state] || GROUND_LINK_COLORS.unusable;
    const color = Cesium.Color.fromCssColorString(css);
    if (state === 'usable') {
      // Reuse the OISL packet material, retaining the ground-link base colour.
      const material = this.linkMaterial(Cesium, 'locked');
      material.uniforms.color = color.withAlpha(.55);
      return material;
    }
    if (state === 'visible') return Cesium.Material.fromType('PolylineDash', { color: color.withAlpha(0.7), dashLength: 10 });
    if (state === 'fault') return Cesium.Material.fromType('PolylineDash', { color: color.withAlpha(0.9), dashLength: 8 });
    return Cesium.Material.fromType('Color', { color: color.withAlpha(state === 'usable' ? 0.9 : 0.5) });
  }

  // links: [{ id, station, satellite, state }] where satellite is the globe record id and state is
  // usable (fabric accepted), visible (above the mask but not usable), fault or unusable (not drawn).
  setGroundLinks(links) {
    const Cesium = this.cesium;
    const lines = this.linkCollection();
    if (!Cesium?.Color || !lines) return;
    const keep = new Set();
    for (const link of links || []) {
      const key = String(link.id);
      keep.add(key);
      let entry = this.groundLinks.get(key);
      if (!entry) {
        entry = { station: String(link.station), satellite: String(link.satellite), positions: [], state: null, line: null };
        entry.line = lines.add({
          id: `ground-link-${key}`,
          positions: [], show: false, width: BASE_WIDTH, material: this.groundMaterial(Cesium, link.state),
        });
        entry.state = link.state;
        entry.material = entry.line.material;
        this.groundLinks.set(key, entry);
      } else if (entry.state !== link.state) {
        entry.line.material = this.groundMaterial(Cesium, link.state);
        entry.material = entry.line.material;
        entry.state = link.state;
      }
      entry.station = String(link.station); entry.satellite = String(link.satellite);
    }
    for (const key of [...this.groundLinks.keys()]) if (!keep.has(key)) this.removeGroundLink(key);
    this.applyEmphasis();
    this.placeGroundLinks(this.timeSource());
  }

  placeGroundLinks(date) {
    const Cesium = this.cesium;
    if (!Cesium) return;
    for (const entry of this.groundLinks.values()) {
      const station = this.stations.get(entry.station);
      const a = station ? this.stationPosition(station.station) : null;
      const b = this.cartesianAt(entry.satellite, date);
      const drawable = !!a && !!b && this.groundLinksVisible && entry.state !== 'unusable';
      if (drawable) {
        entry.positions = [a, b];
        entry.line.positions = entry.positions;
      }
      entry.line.show = drawable;
    }
  }

  removeGroundLink(key) {
    const entry = this.groundLinks.get(key);
    if (!entry) return;
    try { this.linkPolylines?.remove(entry.line); } catch { /* already gone */ }
    this.groundLinks.delete(key);
  }

  // Route and selection emphasis over both OISL and ground link lines; base styling is restored
  // for everything else so a route that moves on does not leave thick lines behind.
  applyEmphasis() {
    const Cesium = this.cesium;
    if (!Cesium?.Color) return;
    const routeColor = Cesium.Material.fromType('Color', { color: Cesium.Color.fromCssColorString(ROUTE_COLOR).withAlpha(0.95) });
    for (const [key, entry] of this.links) {
      const polyline = entry.line;
      const routed = this.routeIds.has(key);
      if (entry.material?.uniforms && 'time' in entry.material.uniforms) {
        // Keep the packet phase and material alive across periodic snapshots and route changes.
        entry.material.uniforms.color = Cesium.Color.fromCssColorString(routed ? ROUTE_COLOR : LINK_COLORS.locked).withAlpha(.55);
        polyline.material = entry.material;
      } else polyline.material = routed ? routeColor : entry.material;
      polyline.width = routed ? ROUTE_WIDTH : key === this.selectedLinkId ? SELECTED_WIDTH : BASE_WIDTH;
    }
    for (const [key, entry] of this.groundLinks) {
      const polyline = entry.line;
      const routed = this.routeIds.has(key);
      if (entry.material?.uniforms && 'time' in entry.material.uniforms) {
        entry.material.uniforms.color = Cesium.Color.fromCssColorString(routed ? ROUTE_COLOR : GROUND_LINK_COLORS.usable).withAlpha(.55);
        polyline.material = entry.material;
      } else polyline.material = routed ? routeColor : entry.material;
      polyline.width = routed ? ROUTE_WIDTH : key === this.selectedLinkId ? SELECTED_WIDTH : BASE_WIDTH;
    }
  }

  setLinks(links) {
    super.setLinks(links);
    this.applyEmphasis();
  }

  setRoute(linkIds) {
    this.routeIds = new Set([...(linkIds || [])].map(String));
    this.applyEmphasis();
  }

  setSelectedLink(id) {
    this.selectedLinkId = id == null ? null : String(id);
    this.applyEmphasis();
  }

  setGroundLinksVisible(visible) {
    this.groundLinksVisible = visible !== false;
    this.placeGroundLinks(this.timeSource());
    return this.groundLinksVisible;
  }

  setCoverageVisible(visible) {
    this.coverageVisible = visible !== false;
    for (const entry of this.stations.values()) entry.coverage.show = this.coverageVisible && (entry.coverage.ellipse?.semiMajorAxis ?? 0) > 1;
    return this.coverageVisible;
  }

  placeLinks(date) {
    super.placeLinks(date);
    this.placeGroundLinks(date);
  }

  animateLinkFlow(nowMs = performance.now()) {
    super.animateLinkFlow(nowMs);
    for (const entry of this.groundLinks.values()) {
      const uniforms = entry.line.material?.uniforms;
      if (entry.line.show && entry.state === 'usable' && uniforms && 'time' in uniforms) {
        uniforms.time = nowMs / 1000 * 1.4;
      }
    }
  }

  clear() {
    super.clear();
    for (const id of [...this.stations.keys()]) this.removeStation(id);
    for (const key of [...this.groundLinks.keys()]) this.removeGroundLink(key);
    this.routeIds = new Set();
    this.selectedLinkId = null;
  }
}

export { LINK_COLORS };
