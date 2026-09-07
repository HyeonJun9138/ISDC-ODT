const listeners = new Map();

export const store = {
  activeTab: "orbit",
  selectedSatellite: null,
  selectedLink: null,
  selectedMission: "ODIN-01",
  selectedDevice: null,
  satellites: [],
  satelliteSource: "loading",
  satelliteCatalog: { total: 0, filtered_total: 0, count: 0, fetched_at: null, truncated: false },
  satelliteGroups: [],
  scenarios: [],
  communication: { nodes: [], links: [], queue: [] },
  missions: [],
  analytics: { kpis: [], requirements: [] },
  devices: [],
  runtime: { running: true, speed: 1, elapsed_seconds: 0, active_faults: [] },
  telemetry: {},
  events: [],
  livePositions: new Map(),
};

export function setState(patch, event = "state") {
  Object.assign(store, patch);
  emit(event, store);
}

export function on(event, callback) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(callback);
  return () => listeners.get(event)?.delete(callback);
}

export function emit(event, payload) {
  listeners.get(event)?.forEach((callback) => callback(payload));
}

export function currentMission() {
  return store.missions.find((item) => item.id === store.selectedMission) || store.missions[0];
}
