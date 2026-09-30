// Orbit propagation and geometric pass prediction; no DOM or renderer dependency.
import { nodePositionAt } from './satellite_dynamics.js';

const DEGREES = 180 / Math.PI;
const RADIANS = Math.PI / 180;
const TWO_PI = 2 * Math.PI;
// WGS84 defining parameters, expressed in km and seconds (NGA WGS84).
const EARTH_A_KM = 6378.137;
const EARTH_FLATTENING = 1 / 298.257223563;
const EARTH_B_KM = EARTH_A_KM * (1 - EARTH_FLATTENING);
const EARTH_E2 = EARTH_FLATTENING * (2 - EARTH_FLATTENING);
const EARTH_MU = 398600.4418;
const EARTH_ROTATION = 7.292115e-5;

function validDate(date) {
  return date instanceof Date && Number.isFinite(date.getTime());
}

function finiteVector(vector) {
  return vector != null && [vector.x, vector.y, vector.z].every(Number.isFinite);
}

function validCoordinates(value, altitude) {
  return value != null && Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180
    && Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90
    && Number.isFinite(altitude) && altitude >= 0;
}

function geodeticFromEcf({ x, y, z }) {
  const horizontal = Math.hypot(x, y);
  let latitude = Math.atan2(z, horizontal);
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const sine = Math.sin(latitude);
    const normal = EARTH_A_KM / Math.sqrt(1 - EARTH_E2 * sine * sine);
    latitude = Math.atan2(z + EARTH_E2 * normal * sine, horizontal);
  }
  const sine = Math.sin(latitude);
  // Projection on the ellipsoid normal also remains well-conditioned at the poles.
  const altitude = horizontal * Math.cos(latitude) + z * sine
    - EARTH_A_KM * Math.sqrt(1 - EARTH_E2 * sine * sine);
  return { longitude: Math.atan2(y, x) * DEGREES, latitude: latitude * DEGREES, altitude };
}

function demoPosition(item, date) {
  const { altitude_km: altitude, inclination, phase } = item;
  if (![altitude, inclination, phase].every(Number.isFinite)
      || altitude < 0 || inclination < 0 || inclination > 180) return null;
  const radius = EARTH_A_KM + altitude;
  const velocity = Math.sqrt(EARTH_MU / radius);
  const meanMotion = velocity / radius;
  if (!Number.isFinite(meanMotion) || meanMotion <= 0) return null;
  const seconds = date.getTime() / 1000;
  // A circular, two-body DEMO only: phase is measured at Unix epoch, with the
  // fictitious inertial ascending-node axis aligned with Greenwich at that epoch.
  // The input altitude is radius minus the equatorial radius, not constant
  // WGS84 ellipsoidal height. No J2, drag, real GP epoch, or orbit fitting is used.
  const argument = (phase % TWO_PI + (seconds % (TWO_PI / meanMotion)) * meanMotion) % TWO_PI;
  const inclinationRad = inclination * RADIANS;
  const x = radius * Math.cos(argument);
  const y = radius * Math.sin(argument) * Math.cos(inclinationRad);
  const z = radius * Math.sin(argument) * Math.sin(inclinationRad);
  const rotation = (seconds * EARTH_ROTATION) % TWO_PI;
  const position = geodeticFromEcf({
    x: x * Math.cos(rotation) + y * Math.sin(rotation),
    y: -x * Math.sin(rotation) + y * Math.cos(rotation),
    z,
  });
  // This constructed circular radius cannot lie below the ellipsoid. Correct
  // only a floating-point ulp-scale undershoot, never a negative GP height.
  if (position.altitude < 0 && position.altitude >= -8 * Number.EPSILON * radius) position.altitude = 0;
  return validCoordinates(position, position.altitude) ? { ...position, velocity } : null;
}

// Position is WGS84 geodetic degrees / ellipsoidal km. GP speed is the TEME
// inertial vector norm in km/s, not ground speed. Missing/invalid propagation
// returns null; a real GP is never replaced with a synthetic orbit.
// User-placed nodes (dynamics === 'kepler_j2') use their explicit Kepler + J2 definition.
export function positionAt(entry, satelliteLib, date) {
  if (!entry?.item || !validDate(date)) return null;
  const { item, record } = entry;
  if (item.dynamics === 'kepler_j2') return nodePositionAt(item, date);
  if (item.demo === true) return demoPosition(item, date);
  if (!record || !satelliteLib) return null;
  try {
    const pv = satelliteLib.propagate(record, date);
    if ((record.error != null && record.error !== 0)
        || !finiteVector(pv?.position) || !finiteVector(pv?.velocity)
        || Math.hypot(pv.position.x, pv.position.y, pv.position.z) === 0) return null;
    const gmst = satelliteLib.gstime(date);
    if (!Number.isFinite(gmst)) return null;
    const geo = satelliteLib.eciToGeodetic(pv.position, gmst);
    if (!geo || ![geo.longitude, geo.latitude, geo.height].every(Number.isFinite)
        || Math.abs(geo.longitude) > Math.PI || Math.abs(geo.latitude) > Math.PI / 2) return null;
    const position = {
      longitude: satelliteLib.degreesLong(geo.longitude),
      latitude: satelliteLib.degreesLat(geo.latitude),
      altitude: geo.height,
      velocity: Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z),
    };
    return validCoordinates(position, position.altitude) && Number.isFinite(position.velocity) ? position : null;
  } catch { return null; }
}

function stationAltitude(station) {
  return station?.altitudeKm === undefined ? 0 : station.altitudeKm;
}

function validStation(station) {
  const altitude = stationAltitude(station);
  return validCoordinates(station, 0) && Number.isFinite(altitude) && altitude > -EARTH_B_KM;
}

function ecfFromGeodetic(position, altitude) {
  const latitude = position.latitude * RADIANS;
  const longitude = position.longitude * RADIANS;
  const normal = EARTH_A_KM / Math.sqrt(1 - EARTH_E2 * Math.sin(latitude) ** 2);
  return {
    x: (normal + altitude) * Math.cos(latitude) * Math.cos(longitude),
    y: (normal + altitude) * Math.cos(latitude) * Math.sin(longitude),
    z: (normal * (1 - EARTH_E2) + altitude) * Math.sin(latitude),
  };
}

// WGS84 ECEF -> local east/north/up (ESA Navipedia). Altitudes are ellipsoidal,
// in km; an omitted station altitude alone means 0 km. This is geometry only,
// without terrain, refraction or link availability. Zenith/nadir azimuth is
// undefined and represented as 0 by convention; zero separation returns null.
export function lookAnglesAt(position, station) {
  if (!validCoordinates(position, position?.altitude) || !validStation(station)) return null;
  const target = ecfFromGeodetic(position, position.altitude);
  const observer = ecfFromGeodetic(station, stationAltitude(station));
  const x = target.x - observer.x;
  const y = target.y - observer.y;
  const z = target.z - observer.z;
  const latitude = station.latitude * RADIANS;
  const longitude = station.longitude * RADIANS;
  const east = -Math.sin(longitude) * x + Math.cos(longitude) * y;
  const north = -Math.sin(latitude) * Math.cos(longitude) * x
    - Math.sin(latitude) * Math.sin(longitude) * y + Math.cos(latitude) * z;
  const up = Math.cos(latitude) * Math.cos(longitude) * x
    + Math.cos(latitude) * Math.sin(longitude) * y + Math.sin(latitude) * z;
  const rangeKm = Math.hypot(east, north, up);
  if (!Number.isFinite(rangeKm) || rangeKm === 0) return null;
  const horizontal = Math.hypot(east, north);
  return {
    azimuth: horizontal <= rangeKm * 1e-12 ? 0 : (Math.atan2(east, north) * DEGREES + 360) % 360,
    elevation: Math.atan2(up, horizontal) * DEGREES,
    rangeKm,
  };
}

export function elevationAt(position, station) {
  return lookAnglesAt(position, station)?.elevation ?? null;
}

function refinePeak(sample, leftTime, rightTime) {
  const ratio = (Math.sqrt(5) - 1) / 2;
  let left = leftTime;
  let right = rightTime;
  let first = sample(right - ratio * (right - left));
  let second = sample(left + ratio * (right - left));
  while (right - left > 100) {
    // A newly discovered gap is retained in the sample set, not interpolated.
    if (first.elevation === null || second.elevation === null) return;
    if (first.elevation < second.elevation) {
      left = first.time;
      first = second;
      second = sample(left + ratio * (right - left));
    } else {
      right = second.time;
      second = first;
      first = sample(right - ratio * (right - left));
    }
  }
  sample((left + right) / 2);
}

function refineCrossing(sample, first, second, maskDegrees) {
  let left = first;
  let right = second;
  const leftAbove = left.elevation >= maskDegrees;
  while (right.time - left.time > 1000) {
    const middle = sample((left.time + right.time) / 2);
    if (middle.elevation === null) return;
    if ((middle.elevation >= maskDegrees) === leftAbove) left = middle;
    else right = middle;
  }
}

// Search on a 30 s grid, refine sampled local maxima (including near-mask
// grazing candidates), then bisect observed mask crossings to <= 1 s brackets.
// Arbitrarily short unseen passes/data gaps cannot be guaranteed by sampling.
// inProgress: already above the mask at the search start (aos is clipped).
// truncated: a data gap prevented a boundary, or visibility reached search end.
// Duration and peak describe only the known visible portion, not an inferred
// full pass. Bad query arguments throw; unavailable propagation returns no pass.
export function predictPasses(positionForDate, station, currentDate, hours = 24, options = {}) {
  if (typeof positionForDate !== 'function') throw new TypeError('positionForDate must be a function');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object');
  const maskDegrees = options.maskDegrees === undefined ? 5 : options.maskDegrees;
  const maxPasses = options.maxPasses === undefined ? 12 : options.maxPasses;
  if (!validDate(currentDate) || !validStation(station)) throw new RangeError('valid search date and station coordinates are required');
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) throw new RangeError('hours must be greater than 0 and at most 168');
  if (!Number.isFinite(maskDegrees) || maskDegrees < 0 || maskDegrees >= 90) throw new RangeError('maskDegrees must be in [0, 90)');
  if (!Number.isInteger(maxPasses) || maxPasses < 1 || maxPasses > 100) throw new RangeError('maxPasses must be an integer in [1, 100]');
  const start = currentDate.getTime();
  const end = Math.round(start + hours * 3600000);
  if (end <= start || !validDate(new Date(end))) throw new RangeError('search window is outside the supported date range');

  const samples = new Map();
  const sample = (time) => {
    const at = Math.round(time);
    if (!samples.has(at)) {
      let elevation = null;
      try { elevation = elevationAt(positionForDate(new Date(at)), station); } catch { /* unavailable propagation */ }
      samples.set(at, { time: at, elevation });
    }
    return samples.get(at);
  };
  const orderedSamples = () => Array.from(samples.values()).sort((a, b) => a.time - b.time);
  for (let time = start; time < end; time += 30000) sample(time);
  sample(end);

  const coarse = orderedSamples();
  for (let index = 0; index < coarse.length; index += 1) {
    const before = coarse[index - 1];
    const peak = coarse[index];
    const after = coarse[index + 1];
    if (peak.elevation === null) continue;
    // A peak may be inside the first/last valid interval even when its closest
    // coarse sample is a search-window or data-availability endpoint.
    if (before?.elevation == null) {
      if (after?.elevation != null) refinePeak(sample, peak.time, after.time);
    } else if (after?.elevation == null) {
      refinePeak(sample, before.time, peak.time);
    } else if (peak.elevation >= before.elevation && peak.elevation >= after.elevation
        && (peak.elevation > before.elevation || peak.elevation > after.elevation)) {
      refinePeak(sample, before.time, after.time);
    }
  }
  // Refinement samples are part of the final search history. In particular,
  // null results found by peak/crossing refinement split the returned passes.
  const withPeaks = orderedSamples();
  for (let index = 1; index < withPeaks.length; index += 1) {
    const before = withPeaks[index - 1];
    const after = withPeaks[index];
    if (before.elevation !== null && after.elevation !== null
        && (before.elevation >= maskDegrees) !== (after.elevation >= maskDegrees)) {
      refineCrossing(sample, before, after, maskDegrees);
    }
  }

  const passes = [];
  let active = null;
  let previous = null;
  const finish = () => {
    passes.push({
      station: station.name,
      aos: new Date(active.aos),
      los: new Date(active.los),
      maxAt: new Date(active.maxAt),
      maxElevation: active.maxElevation,
      durationSeconds: Math.round((active.los - active.aos) / 1000),
      inProgress: active.inProgress,
      truncated: active.truncated,
    });
    active = null;
  };
  for (const point of orderedSamples()) {
    if (point.elevation === null) {
      if (active) { active.truncated = true; finish(); }
    } else if (point.elevation >= maskDegrees) {
      if (!active) {
        const hasCrossing = previous?.elevation != null;
        active = {
          aos: hasCrossing ? Math.round((previous.time + point.time) / 2) : point.time,
          los: point.time,
          maxAt: point.time,
          maxElevation: point.elevation,
          inProgress: point.time === start,
          truncated: point.time !== start && !hasCrossing,
        };
      }
      active.los = point.time;
      if (point.elevation > active.maxElevation) {
        active.maxAt = point.time;
        active.maxElevation = point.elevation;
      }
    } else if (active) {
      active.los = Math.round((previous.time + point.time) / 2);
      finish();
    }
    if (passes.length >= maxPasses) return passes;
    previous = point;
  }
  if (active) { active.truncated = true; finish(); }
  return passes;
}
