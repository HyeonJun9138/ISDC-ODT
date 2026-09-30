// Optical inter-satellite link (OISL) terminal model for user-defined nodes: pointing geometry in
// the owner's LVLH frame, Earth line-of-sight and range limits, the gimbal field of regard, an
// acquisition sequence (slew, acquire, track) and target selection by mounting role.
// No DOM, renderer, transport or storage. Times are milliseconds since the Unix epoch, angles in
// degrees, ranges in km. All quantities are geometric model values, not measured link telemetry.
//
// Pointing convention (owner LVLH, see satellite_dynamics.lvlhBasis): azimuth 0 = along the
// velocity ("fore"), +90 = left of the direction of motion, 180 = aft, -90 = right. Elevation is the
// angle above the local horizontal plane, positive toward zenith. A terminal is mounted with a
// boresight azimuth from its role and points within a half-angle cone in azimuth and an elevation
// range around that boresight.

const DEGREES = 180 / Math.PI;
const RADIANS = Math.PI / 180;
export const EARTH_A_KM = 6378.137;
export const DEFAULT_LOS_MARGIN_KM = 100;
export const POINTING_TOLERANCE_DEG = 0.05;
export const OISL_PHASES = Object.freeze(['idle', 'slewing', 'acquiring', 'tracking', 'blocked']);
export const ROLE_BORESIGHT = Object.freeze({ fore: 0, aft: 180, left: 90, right: -90, auto: 0, nadir: 0 });
const ROLE_SECTOR_HALF_ANGLE = 45;

function wrap180(angle) {
  let wrapped = angle % 360;
  if (wrapped > 180) wrapped -= 360;
  if (wrapped <= -180) wrapped += 360;
  return wrapped;
}

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function subtract(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function norm(a) { return Math.hypot(a[0], a[1], a[2]); }

// Shortest distance from Earth's centre to the segment between two positions; the link is clear
// when that distance exceeds the Earth radius plus an atmospheric margin (optical links avoid the
// lower atmosphere, so the default margin is 100 km).
export function lineOfSightClear(rA, rB, marginKm = DEFAULT_LOS_MARGIN_KM) {
  const d = subtract(rB, rA);
  const length2 = dot(d, d);
  if (!(length2 > 0)) return false;
  const t = Math.max(0, Math.min(1, -dot(rA, d) / length2));
  const closest = [rA[0] + t * d[0], rA[1] + t * d[1], rA[2] + t * d[2]];
  return norm(closest) > EARTH_A_KM + marginKm;
}

// Direction to a target expressed in the owner's body frame.
export function pointingTo(ownerState, targetState) {
  const d = subtract(targetState.inertial.r, ownerState.inertial.r);
  const range = norm(d);
  if (!(range > 0)) return null;
  const { basis } = ownerState;
  const x = dot(basis.x, d); const y = dot(basis.y, d); const z = dot(basis.z, d);
  const relativeVelocity = subtract(targetState.inertial.v, ownerState.inertial.v);
  return {
    azimuth: Math.atan2(y, x) * DEGREES,
    elevation: Math.asin(Math.max(-1, Math.min(1, z / range))) * DEGREES,
    range_km: range,
    range_rate_km_s: dot(relativeVelocity, d) / range,
  };
}

export function boresightAzimuth(role) {
  return Object.hasOwn(ROLE_BORESIGHT, role) ? ROLE_BORESIGHT[role] : 0;
}

// Gimbal command relative to the mount: azimuth measured from the boresight, elevation as is.
export function gimbalCommand(terminal, role, pointing) {
  const azimuth = wrap180(pointing.azimuth - boresightAzimuth(role));
  const regard = terminal?.field_of_regard || {};
  const halfAngle = Number.isFinite(Number(regard.azimuth_half_angle)) ? Number(regard.azimuth_half_angle) : 180;
  const [low, high] = Array.isArray(regard.elevation) && regard.elevation.length === 2 ? regard.elevation.map(Number) : [-90, 90];
  const reachable = Math.abs(azimuth) <= halfAngle + 1e-9 && pointing.elevation >= low - 1e-9 && pointing.elevation <= high + 1e-9;
  return { azimuth, elevation: pointing.elevation, reachable };
}

// Geometry and feasibility of a link from an owner terminal toward a target at one instant.
export function linkGeometry(ownerState, targetState, terminal, role = 'auto') {
  const pointing = pointingTo(ownerState, targetState);
  if (!pointing) return null;
  const command = gimbalCommand(terminal, role, pointing);
  const maxRange = Number(terminal?.max_range_km) > 0 ? Number(terminal.max_range_km) : Infinity;
  const minRange = Number(terminal?.min_range_km) >= 0 ? Number(terminal.min_range_km) : 0;
  const clear = lineOfSightClear(ownerState.inertial.r, targetState.inertial.r, terminal?.los_margin_km);
  const inRange = pointing.range_km <= maxRange && pointing.range_km >= minRange;
  const blockedBy = !clear ? 'earth' : !inRange ? 'range' : !command.reachable ? 'field_of_regard' : null;
  return { ...pointing, gimbal: command, clear, inRange, reachable: command.reachable, feasible: blockedBy === null, blockedBy };
}

// Free-space geometric margin relative to the terminal's rated range, in dB, and a display quality
// (50 % at zero margin, 100 % at 10 dB). This is a geometric heuristic, not a link budget.
export function linkMargin(rangeKm, terminal) {
  const maxRange = Number(terminal?.max_range_km);
  if (!(rangeKm > 0) || !(maxRange > 0)) return { margin_db: null, quality: null };
  const margin = 20 * Math.log10(maxRange / rangeKm);
  return { margin_db: margin, quality: Math.max(0, Math.min(100, Math.round(50 + 5 * margin))) };
}

function angularDistance(a, b) {
  const azimuth = wrap180(a.azimuth - b.azimuth);
  return Math.hypot(azimuth, a.elevation - b.elevation);
}

// Gimbal rest position and an empty acquisition history.
export function createTerminalState() {
  return { target: null, since: null, at: null, phase: 'idle', azimuth: 0, elevation: 0, arrivedAt: null, lockedAt: null, blockedBy: null, pointingError: 0 };
}

// Advance one terminal to a date. command = { targetId } or null; geometry is the current link
// geometry toward that target (null when the target is unknown). The sequence is deterministic in
// the analysis time: retargeting or a recovered line of sight restarts slew and acquisition, and a
// jump backwards in time resets the gimbal onto the command instead of inventing a history.
export function advanceTerminal(previous, terminal, command, geometry, date) {
  const now = date instanceof Date ? date.getTime() : Number(date);
  const state = { ...(previous || createTerminalState()) };
  const targetId = command?.targetId ?? null;
  const slewRate = Number(terminal?.slew_rate_deg_s) > 0 ? Number(terminal.slew_rate_deg_s) : 1;
  const acquisitionMs = Math.max(0, Number(terminal?.acquisition_time_s) || 0) * 1000;
  const jitter = Number(terminal?.jitter_deg) >= 0 ? Number(terminal.jitter_deg) : 0;
  const elapsed = state.at === null ? 0 : (now - state.at) / 1000;
  if (state.at !== null && elapsed < 0) {
    // Backward seek: no reverse history exists, so start the sequence fresh at the new time.
    state.target = null;
  }
  if (targetId !== state.target) {
    state.target = targetId;
    state.since = now;
    state.arrivedAt = null;
    state.lockedAt = null;
  }
  state.at = now;
  if (!targetId || !geometry) {
    state.phase = 'idle';
    state.blockedBy = null;
    state.pointingError = 0;
    state.arrivedAt = null; state.lockedAt = null;
    return state;
  }
  if (!geometry.feasible) {
    state.phase = 'blocked';
    state.blockedBy = geometry.blockedBy;
    state.pointingError = null;
    state.since = now; state.arrivedAt = null; state.lockedAt = null;
    return state;
  }
  state.blockedBy = null;
  const target = geometry.gimbal;
  const remaining = angularDistance(target, state);
  const step = slewRate * Math.max(0, elapsed);
  if (remaining <= step + POINTING_TOLERANCE_DEG) {
    state.azimuth = target.azimuth;
    state.elevation = target.elevation;
    if (state.arrivedAt === null) {
      // Arrival is placed where the slew would have finished, so a coarse tick does not delay lock.
      const overshoot = step > remaining ? (step - remaining) / slewRate : 0;
      state.arrivedAt = now - overshoot * 1000;
    }
  } else {
    const fraction = step / remaining;
    state.azimuth = wrap180(state.azimuth + wrap180(target.azimuth - state.azimuth) * fraction);
    state.elevation += (target.elevation - state.elevation) * fraction;
    state.arrivedAt = null;
    state.lockedAt = null;
  }
  if (state.arrivedAt === null) {
    state.phase = 'slewing';
    state.pointingError = angularDistance(target, state);
  } else if (now - state.arrivedAt < acquisitionMs) {
    state.phase = 'acquiring';
    state.pointingError = jitter * 3;
    state.lockedAt = null;
  } else {
    state.phase = 'tracking';
    state.pointingError = jitter;
    if (state.lockedAt === null) state.lockedAt = state.arrivedAt + acquisitionMs;
  }
  return state;
}

// Fraction of the acquisition dwell completed while acquiring (0..1), otherwise null.
export function acquisitionProgress(state, terminal, date) {
  if (state?.phase !== 'acquiring' || state.arrivedAt === null) return null;
  const now = date instanceof Date ? date.getTime() : Number(date);
  const total = Math.max(1, (Number(terminal?.acquisition_time_s) || 0) * 1000);
  return Math.max(0, Math.min(1, (now - state.arrivedAt) / total));
}

function inSector(role, azimuth) {
  if (role === 'auto' || !Object.hasOwn(ROLE_BORESIGHT, role)) return true;
  return Math.abs(wrap180(azimuth - ROLE_BORESIGHT[role])) <= ROLE_SECTOR_HALF_ANGLE;
}

// Pick the closest feasible candidate inside the role's sector. candidates: [{ id, state }].
// exclude: ids already served by another terminal of the same node.
export function chooseTarget(ownerState, candidates, terminal, role = 'auto', exclude = new Set()) {
  let best = null;
  for (const candidate of candidates || []) {
    if (!candidate?.state || exclude.has(candidate.id)) continue;
    const geometry = linkGeometry(ownerState, candidate.state, terminal, role);
    if (!geometry?.feasible || !inSector(role, geometry.azimuth)) continue;
    if (!best || geometry.range_km < best.geometry.range_km) best = { id: candidate.id, geometry };
  }
  return best;
}

// Combine the two directional terminal phases of a pair into one link state for display.
export function pairState(phaseA, phaseB) {
  const phases = [phaseA, phaseB].filter(Boolean);
  if (!phases.length) return 'none';
  if (phases.every(phase => phase === 'tracking')) return phases.length === 2 ? 'locked' : 'one_way';
  if (phases.some(phase => phase === 'tracking')) return 'one_way';
  if (phases.some(phase => phase === 'acquiring')) return 'acquiring';
  if (phases.some(phase => phase === 'slewing')) return 'slewing';
  if (phases.some(phase => phase === 'blocked')) return 'blocked';
  return 'idle';
}

export function phaseLabel(phase) {
  return {
    idle: '대기', slewing: '짐벌 구동', acquiring: '포착 중', tracking: '추적 (링크 유지)', blocked: '가시선 차단',
    locked: '양방향 유지', one_way: '단방향', none: '없음',
  }[phase] || phase || '—';
}

export function blockedLabel(reason) {
  return { earth: '지구 가림', range: '거리 초과', field_of_regard: '짐벌 가동 범위 밖' }[reason] || '—';
}

export { wrap180 };
