// Working set of ground stations for the communication console. Stations are a per-browser display
// configuration kept in localStorage (like the node working set), not server runtime state. A fresh
// console starts with the default sites; the operator adds presets or custom sites and can disable
// a station without deleting it.
import { DEFAULT_STATION_KEYS, STATION_PRESETS, createStation, normalizeStation, stationIdFor, validateStation } from "/static/model_library/ground_stations.js";

export const STATIONS_KEY = "spacetwin-ground-stations-v1";
export const MAX_STATIONS = 24;

function readJson(storage, key) {
  try { const raw = storage?.getItem?.(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function writeJson(storage, key, value) {
  try { storage?.setItem?.(key, JSON.stringify(value)); return true; } catch { return false; }
}

export function createGroundSegmentStore({ storage = null } = {}) {
  const listeners = new Set();
  let stations = [];
  let selectedId = null;
  let sequence = 0;
  const notify = event => listeners.forEach(listener => listener(event, api));

  function persist() {
    writeJson(storage, STATIONS_KEY, { schema: 1, sequence, selectedId, stations });
  }

  function load() {
    const saved = readJson(storage, STATIONS_KEY);
    if (saved && Array.isArray(saved.stations)) {
      stations = saved.stations.map(normalizeStation).filter(Boolean).slice(0, MAX_STATIONS);
      sequence = Number(saved.sequence) || 0;
    } else {
      stations = DEFAULT_STATION_KEYS.map(key => createStation({ preset: key }, { id: stationIdFor(key) }));
      sequence = 0;
    }
    selectedId = stations.some(station => station.id === saved?.selectedId) ? saved.selectedId : null;
    notify("load");
  }

  function find(id) {
    return stations.find(station => station.id === id) || null;
  }

  function uniqueId(base) {
    let candidate = base;
    let suffix = 1;
    while (find(candidate)) { suffix += 1; candidate = `${base}_${suffix}`; }
    return candidate;
  }

  // Add a preset site or a custom site; custom sites get a sequential id.
  function add(partial = {}) {
    if (stations.length >= MAX_STATIONS) throw new RangeError(`지상국은 최대 ${MAX_STATIONS}개까지 둘 수 있습니다.`);
    const preset = STATION_PRESETS[partial.preset] || null;
    sequence += 1;
    const id = uniqueId(preset ? stationIdFor(preset.key) : stationIdFor(`site_${sequence}`));
    const station = createStation(preset ? { ...preset, ...partial, preset: preset.key } : { ...partial, preset: null, name: partial.name || `지상국 ${sequence}` }, { id });
    stations = [...stations, station];
    selectedId = station.id;
    persist(); notify("add");
    return station;
  }

  function update(id, next) {
    const index = stations.findIndex(station => station.id === id);
    if (index < 0) return ["지상국을 찾을 수 없습니다."];
    const candidate = createStation({ ...stations[index], ...next, preset: stations[index].preset }, { id });
    const errors = validateStation(candidate);
    if (errors.length) return errors;
    stations = stations.map(station => (station.id === id ? candidate : station));
    persist(); notify("update");
    return [];
  }

  function setEnabled(id, enabled) {
    const station = find(id);
    if (!station) return false;
    stations = stations.map(item => (item.id === id ? { ...item, enabled: enabled !== false } : item));
    persist(); notify("update");
    return true;
  }

  function remove(id) {
    const before = stations.length;
    stations = stations.filter(station => station.id !== id);
    if (stations.length === before) return false;
    if (selectedId === id) selectedId = null;
    persist(); notify("remove");
    return true;
  }

  function select(id) {
    selectedId = find(id) ? id : null;
    persist(); notify("select");
    return selectedId;
  }

  function reset() {
    stations = DEFAULT_STATION_KEYS.map(key => createStation({ preset: key }, { id: stationIdFor(key) }));
    selectedId = null;
    persist(); notify("reset");
  }

  const api = {
    load, add, update, setEnabled, remove, select, reset, find,
    get stations() { return stations; },
    get enabled() { return stations.filter(station => station.enabled !== false); },
    get selectedId() { return selectedId; },
    get selected() { return find(selectedId); },
    availablePresets: () => Object.values(STATION_PRESETS).filter(preset => !stations.some(station => station.preset === preset.key)),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return api;
}

export const groundSegment = createGroundSegmentStore({ storage: globalThis.localStorage || null });
