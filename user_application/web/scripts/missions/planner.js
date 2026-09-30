// Mission planning shared by the mission tab and the scenario player: the windows the twin
// computes (ground contacts, target access, eclipses, external crosslinks), the ICD-03 request
// (OR-01) built from them, the exchange with the constellation operations module (OR-02) and the
// execution decisions it is told about (OR-03). The twin computes geometry here; the module assigns
// the tasks. The OISL mesh sent to the module excludes links the runtime reports as faulted, so a
// link fault reaches the planner as common state and re-planning routes around it.
import { contactWindows, targetAccessWindows, eclipseIntervals, crosslinkWindows, busyIntervals, planHorizon } from "/static/simulation/mission_windows.js";
import { nodeStateAt } from "/static/simulation/satellite_dynamics.js";
import { positionAt as catalogPositionAt } from "/static/simulation/orbit.js";
import { satelliteCapabilities, requestParams, taskStatusAt } from "/static/model_library/mission_types.js";
import { createOrchestrationClient } from "/static/communication/orchestration.js?v=20260908-scenario1";
import { pairKey, resolveLinks } from "../nodes/links.js?v=20260908-planes1";

export const SATELLITE_LIB_URL = "https://cdn.jsdelivr.net/npm/satellite.js@7.0.1/+esm";
export const WINDOW_CACHE_MS = 10 * 60_000;
export const PRIME_STEPS_S = [120, 60];

// Yield between satellites so the page stays responsive while windows are computed. A message
// channel is used instead of a timer because hidden tabs throttle timers to once a minute.
export const yieldToBrowser = () => new Promise(resolve => {
  if (typeof MessageChannel === "undefined") { setTimeout(resolve, 0); return; }
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
  channel.port2.postMessage(0);
});

function faultTargets(faults, kind) {
  return new Set((faults || []).filter(fault => fault?.kind === kind && fault.active !== false).map(fault => String(fault.target)));
}

// OISL pairs the runtime's active link-loss faults touch: by pair id or by either node's id or name.
export function faultedPairKeys(pairs, nodes, faults) {
  const targets = faultTargets(faults, "link_loss");
  if (!targets.size) return new Set();
  const byId = new Map((nodes || []).map(node => [node.id, node]));
  const keys = new Set();
  for (const pair of pairs || []) {
    const a = byId.get(pair.a); const b = byId.get(pair.b);
    const names = [pair.key, pair.a, pair.b, a?.name, b?.name].filter(value => value != null).map(String);
    if (names.some(name => targets.has(name))) keys.add(pair.key);
  }
  return keys;
}

// Stations the runtime's active link-loss faults name, by id or name.
export function faultedStationIds(stations, faults) {
  const targets = faultTargets(faults, "link_loss");
  return new Set((stations || []).filter(station => targets.has(station.id) || targets.has(station.name)).map(station => station.id));
}

// satellites(): deployed nodes; stations(): enabled stations; missions(): the mission store's
// missions; faults(): the runtime's active faults; now(): the analysis Date.
export function createMissionPlanner({ satellites, stations, missions, faults = () => [], now: timeSource = () => new Date(), orchestration = null, loadSatelliteLib = null } = {}) {
  const client = orchestration || createOrchestrationClient();
  // The mission tab plans at its analysis time; it registers its clock here so one planner (and one
  // window cache) serves both the tab and the scenario player.
  let now = timeSource;
  let windowsCache = null;
  let satelliteLib = null;
  const extraWindows = new Map();

  function windowsKey(start, hours) {
    return `${satellites().map(node => `${node.id}|${node.updated_at}`).join(",")}#${stations().map(station => `${station.id}|${station.min_elevation_deg}|${station.bands.join("")}`).join(",")}#${Math.floor(start / WINDOW_CACHE_MS)}#${hours}`;
  }

  async function ensureWindows(start, hours) {
    const key = windowsKey(start, hours);
    if (windowsCache?.key === key) return windowsCache;
    const contacts = []; const eclipses = [];
    const sites = stations();
    const nodes = satellites();
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      for (const station of sites) contacts.push(...contactWindows(node, station, start, hours));
      eclipses.push(...eclipseIntervals(node, start, hours));
      if (index % 4 === 3) await yieldToBrowser();
    }
    windowsCache = { key, start, hours, contacts, eclipses, computedAt: Date.now() };
    return windowsCache;
  }

  async function ensureSatelliteLib() {
    if (satelliteLib) return satelliteLib;
    try { satelliteLib = loadSatelliteLib ? await loadSatelliteLib() : await import(SATELLITE_LIB_URL); }
    catch (error) { throw new Error(`위성 전파 라이브러리를 불러올 수 없어 외부 위성 창을 계산할 수 없습니다 (${error.message})`); }
    return satelliteLib;
  }

  // The locked OISL mesh at `date` and the pairs a fault removes from it. The acquisition history is
  // primed from PRIME_STEPS_S back so the mesh reflects the steady state of the geometry.
  function meshState(nodes, date) {
    let histories = new Map();
    for (const seconds of PRIME_STEPS_S) {
      const at = new Date(date.getTime() - seconds * 1000);
      histories = resolveLinks(nodes, new Map(nodes.map(node => [node.id, nodeStateAt(node.orbit, at)])), histories, at).histories;
    }
    const result = resolveLinks(nodes, new Map(nodes.map(node => [node.id, nodeStateAt(node.orbit, date)])), histories, date);
    const faulted = faultedPairKeys(result.pairs, nodes, faults());
    const mesh = {};
    for (const pair of result.pairs) {
      if (pair.state !== "locked" || faulted.has(pair.key)) continue;
      (mesh[pair.a] ||= []).push(pair.b); (mesh[pair.b] ||= []).push(pair.a);
    }
    return { mesh, faulted: [...faulted], locked: result.pairs.filter(pair => pair.state === "locked").length };
  }

  async function buildRequest(mission, { exclude = [], onStage = () => {} } = {}) {
    const at = now();
    const deadline = Date.parse(mission.deadline);
    const horizon = planHorizon(at.getTime(), deadline);
    onStage("windows");
    const base = await ensureWindows(horizon.start, horizon.hours);
    const nodes = satellites();
    const params = requestParams(mission);
    const extra = { access: [], crosslinks: [] };
    if (mission.kind === "observe") {
      const target = { latitude: Number(params.latitude), longitude: Number(params.longitude) };
      for (const node of nodes) {
        if (!satelliteCapabilities(node).camera) continue;
        extra.access.push(...targetAccessWindows(node, target, horizon.start, horizon.hours, Number(params.max_off_nadir_deg) || 30));
      }
      await yieldToBrowser();
    }
    if (mission.kind === "pickup") {
      const item = params.external_item;
      if (!item) throw new Error("외부 위성의 궤도 정보가 없습니다. 임무를 편집해 외부 위성을 다시 고르세요.");
      const lib = await ensureSatelliteLib();
      let record = null;
      try { record = lib.json2satrec(item); } catch { record = null; }
      if (!record) throw new Error("외부 위성의 궤도요소를 해석할 수 없습니다.");
      const entry = { item, record };
      const externalAt = date => catalogPositionAt(entry, lib, date);
      for (let index = 0; index < nodes.length; index += 1) {
        extra.crosslinks.push(...crosslinkWindows(nodes[index], externalAt, horizon.start, horizon.hours, Number(params.max_range_km) || 2000, { externalId: String(params.external_id) }));
        if (index % 4 === 3) await yieldToBrowser();
      }
    }
    extraWindows.set(mission.id, extra);
    const faultedStations = faultedStationIds(stations(), faults());
    const contacts = base.contacts.filter(window => !faultedStations.has(window.station));
    const busy = busyIntervals(missions(), { except: mission.id });
    const mesh = meshState(nodes, at);
    return {
      time: at.toISOString(),
      mission: { id: mission.id, kind: mission.kind, priority: mission.priority, window_start: mission.window_start, deadline: mission.deadline, params },
      satellites: nodes.map(node => ({ id: node.id, name: node.name, mode: node.mode, formation: node.formation?.id || null, capabilities: satelliteCapabilities(node), power: { generation_w: node.power?.generation_w, bus_w: node.power?.bus_w, battery_wh: node.power?.battery_wh }, busy: busy[node.id] || [] })),
      stations: stations().filter(station => !faultedStations.has(station.id)).map(station => ({ id: station.id, name: station.name, bands: station.bands })),
      windows: { contacts, target_access: extra.access, crosslinks: extra.crosslinks, eclipses: base.eclipses },
      mesh: mesh.mesh,
      exclude: [...new Set([...(mission.exclude || []), ...exclude])],
      horizon: { start: new Date(horizon.start).toISOString(), end: new Date(horizon.end).toISOString(), faulted_stations: [...faultedStations], faulted_links: mesh.faulted, locked_links: mesh.locked },
    };
  }

  // OR-01 → OR-02. Returns { request, answer }; errors flagged `unavailable` mean the module did not answer.
  async function plan(mission, { exclude = [], onStage = () => {} } = {}) {
    const request = await buildRequest(mission, { exclude, onStage });
    onStage("request");
    const answer = await client.plan(request);
    return { request, answer };
  }

  // OR-03: tell the module the operator confirmed or aborted a plan.
  async function commit(mission, decision = "commit") {
    const tasks = decision === "commit" ? (mission.plan?.tasks || []).map(task => ({ id: task.id, kind: task.kind, satellite: task.satellite, counterpart: task.counterpart ?? null, start: task.start, end: task.end })) : [];
    return client.commit({ time: now().toISOString(), mission_id: mission.id, decision, version: mission.plan?.version || 0, tasks });
  }

  // Satellites and links a committed plan can no longer rely on: satellites that left the deployed
  // set or are not in nominal mode, and crosslink tasks whose OISL pair the runtime reports faulted.
  function affectedTasks(mission, nowMs) {
    if (mission?.status !== "committed" || !mission.plan?.tasks) return { satellites: [], links: [], tasks: [] };
    const nodes = satellites();
    const deployed = new Map(nodes.map(node => [node.id, node]));
    const targets = faultTargets(faults(), "link_loss");
    const satellitesOut = new Set(); const linksOut = new Set(); const tasks = [];
    for (const task of mission.plan.tasks) {
      if (taskStatusAt(task, nowMs) === "done") continue;
      const node = deployed.get(task.satellite);
      let hit = false;
      if (!node || node.mode !== "nominal") { satellitesOut.add(task.satellite); hit = true; }
      if (task.kind === "crosslink" && task.counterpart && targets.size) {
        const other = deployed.get(task.counterpart);
        const key = pairKey(task.satellite, task.counterpart);
        const names = [key, task.satellite, task.counterpart, node?.name, other?.name].filter(value => value != null).map(String);
        if (names.some(name => targets.has(name))) { linksOut.add(key); hit = true; }
      }
      if (hit) tasks.push(task.id);
    }
    return { satellites: [...satellitesOut], links: [...linksOut], tasks };
  }

  return {
    ensureWindows, buildRequest, plan, commit, meshState, affectedTasks, extraWindows, orchestration: client,
    get windows() { return windowsCache; },
    invalidateWindows() { windowsCache = null; },
    setTimeSource(fn) { if (typeof fn === "function") now = fn; },
    now: () => now(),
  };
}
