// Windows the mission console computes for the constellation operations module: ground contacts
// with their rates, target access passes for imaging, eclipse intervals, crosslink windows with an
// external satellite, and the busy intervals of committed missions. Pure functions of their inputs;
// no DOM, transport or storage. Geometry only: no terrain, refraction, pointing agility or weather.
import { predictPasses } from '/static/simulation/orbit.js';
import { nodeStateAt, nodePositionAt } from '/static/simulation/satellite_dynamics.js';
import { lineOfSightClear } from '/static/simulation/oisl.js';
import { chooseBand, radioLinksOf } from '/static/simulation/ground_links.js';
import { UPLINK_RATE_MBPS, timeOf } from '/static/model_library/mission_types.js';

export const EARTH_A_KM = 6378.137;
const EARTH_FLATTENING = 1 / 298.257223563;
const EARTH_E2 = EARTH_FLATTENING * (2 - EARTH_FLATTENING);
const RADIANS = Math.PI / 180;
const DEGREES = 180 / Math.PI;
export const DEFAULT_STEP_MS = 30_000;
export const MAX_HORIZON_HOURS = 24;

export function ecefFromGeodetic({ latitude, longitude, altitude }) {
  const lat = Number(latitude) * RADIANS; const lon = Number(longitude) * RADIANS; const h = Number(altitude) || 0;
  const normal = EARTH_A_KM / Math.sqrt(1 - EARTH_E2 * Math.sin(lat) ** 2);
  return [(normal + h) * Math.cos(lat) * Math.cos(lon), (normal + h) * Math.cos(lat) * Math.sin(lon), (normal * (1 - EARTH_E2) + h) * Math.sin(lat)];
}

// Minimum elevation (deg) at which a satellite at the altitude is inside the camera's off-nadir
// cone: sin(η) = Re / (Re + h) · cos(ε). A cone that reaches past the horizon needs no mask.
export function elevationForOffNadir(altitudeKm, offNadirDeg) {
  const ratio = (EARTH_A_KM + Math.max(0, Number(altitudeKm) || 0)) / EARTH_A_KM * Math.sin(Math.max(0, Number(offNadirDeg) || 0) * RADIANS);
  if (ratio >= 1) return 0;
  return Math.acos(ratio) * DEGREES;
}

// Planning horizon: from the analysis time to the deadline plus a margin, clamped to the maximum.
export function planHorizon(nowMs, deadlineMs, { marginHours = 1, minHours = 2, maxHours = MAX_HORIZON_HOURS } = {}) {
  const wanted = (Math.max(0, (deadlineMs ?? nowMs) - nowMs) / 3600_000) + marginHours;
  const hours = Math.max(minHours, Math.min(maxHours, wanted));
  return { start: nowMs, end: nowMs + hours * 3600_000, hours };
}

// Intervals where the predicate holds, sampled on a step and refined at the edges by bisection.
export function scanIntervals(predicate, startMs, endMs, stepMs = DEFAULT_STEP_MS, { refineMs = 5_000 } = {}) {
  const intervals = [];
  if (!(endMs > startMs) || !(stepMs > 0)) return intervals;
  const refine = (insideMs, outsideMs) => {
    let a = insideMs; let b = outsideMs;
    while (Math.abs(b - a) > refineMs) {
      const middle = (a + b) / 2;
      if (predicate(middle)) a = middle; else b = middle;
    }
    return a;
  };
  let previous = null; let previousState = false; let open = null;
  for (let t = startMs; t <= endMs; t += stepMs) {
    const state = !!predicate(t);
    if (state && !previousState) open = previous === null ? t : refine(t, previous);
    if (!state && previousState && open !== null) { intervals.push({ start: open, end: refine(previous, t) }); open = null; }
    previous = t; previousState = state;
  }
  if (open !== null) intervals.push({ start: open, end: endMs, truncated: true });
  return intervals;
}

function passWindows(node, site, startMs, hours, maskDegrees, maxPasses) {
  const item = { orbit: node.orbit };
  try {
    return predictPasses(date => nodePositionAt(item, date), site, new Date(startMs), hours, { maskDegrees, maxPasses });
  } catch { return []; }
}

// Ground contacts of one satellite with one station on the best shared band, with the rates the
// operations module needs. No usable band means no windows, not a silent default.
export function contactWindows(node, station, startMs, hours, { maxPasses = 8 } = {}) {
  const band = chooseBand(radioLinksOf(node), station);
  if (!band) return [];
  const spec = radioLinksOf(node).get(band);
  return passWindows(node, station, startMs, hours, Number(station.min_elevation_deg) || 0, maxPasses).map(pass => ({
    id: `${station.id}|${node.id}|${pass.aos.toISOString()}`, satellite: node.id, station: station.id, band,
    rate_mbps: Number(spec?.data_rate_mbps) || 0, uplink_mbps: UPLINK_RATE_MBPS[band] || 0,
    start: pass.aos.toISOString(), end: pass.los.toISOString(), peak: pass.maxAt.toISOString(), max_elevation: Math.round(pass.maxElevation * 10) / 10, in_progress: pass.inProgress === true,
  }));
}

// Passes of one satellite over a target inside the camera's off-nadir cone.
export function targetAccessWindows(node, target, startMs, hours, maxOffNadirDeg, { maxPasses = 6 } = {}) {
  const mask = elevationForOffNadir(node.orbit?.altitude_km, maxOffNadirDeg);
  return passWindows(node, target, startMs, hours, mask, maxPasses).map(pass => ({
    id: `access|${node.id}|${pass.aos.toISOString()}`, satellite: node.id, start: pass.aos.toISOString(), end: pass.los.toISOString(), peak: pass.maxAt.toISOString(),
    max_elevation: Math.round(pass.maxElevation * 10) / 10, min_elevation: Math.round(mask * 10) / 10,
  }));
}

export function eclipseIntervals(node, startMs, hours, { stepMs = 60_000 } = {}) {
  const orbit = node.orbit;
  return scanIntervals(ms => { const state = nodeStateAt(orbit, ms); return !!state && !state.sunlit; }, startMs, startMs + hours * 3600_000, stepMs)
    .map(interval => ({ id: `eclipse|${node.id}|${new Date(interval.start).toISOString()}`, satellite: node.id, start: new Date(interval.start).toISOString(), end: new Date(interval.end).toISOString() }));
}

// Windows in which one of our satellites is within range of an external satellite with a clear
// line of sight. externalPositionAt(date) returns { latitude, longitude, altitude } or null.
export function crosslinkWindows(node, externalPositionAt, startMs, hours, maxRangeKm, { stepMs = DEFAULT_STEP_MS, externalId = 'external' } = {}) {
  const orbit = node.orbit;
  const geometry = ms => {
    const ours = nodeStateAt(orbit, ms);
    const theirs = externalPositionAt(new Date(ms));
    if (!ours || !theirs) return null;
    const a = ours.fixed.r; const b = ecefFromGeodetic(theirs);
    const range = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    return { range, clear: lineOfSightClear(a, b) };
  };
  const intervals = scanIntervals(ms => { const g = geometry(ms); return !!g && g.clear && g.range <= maxRangeKm; }, startMs, startMs + hours * 3600_000, stepMs);
  return intervals.map(interval => {
    let minRange = Infinity;
    for (let t = interval.start; t <= interval.end; t += Math.max(5_000, stepMs / 3)) { const g = geometry(t); if (g && g.range < minRange) minRange = g.range; }
    return { id: `crosslink|${node.id}|${externalId}|${new Date(interval.start).toISOString()}`, satellite: node.id, external: String(externalId), start: new Date(interval.start).toISOString(), end: new Date(interval.end).toISOString(), min_range_km: Number.isFinite(minRange) ? Math.round(minRange) : null };
  });
}

// Committed tasks of other missions, keyed by satellite, so a new plan does not double-book.
export function busyIntervals(missions, { except = null } = {}) {
  const busy = {};
  for (const mission of missions || []) {
    if (mission.id === except || mission.status !== 'committed' || !mission.plan?.tasks) continue;
    for (const task of mission.plan.tasks) {
      if (!task.satellite || timeOf(task.start) === null || timeOf(task.end) === null) continue;
      (busy[task.satellite] ||= []).push({ start: task.start, end: task.end, task_id: task.id, mission_id: mission.id });
    }
  }
  for (const list of Object.values(busy)) list.sort((p, q) => timeOf(p.start) - timeOf(q.start));
  return busy;
}
