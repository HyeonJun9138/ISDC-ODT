// Dynamics for user-defined satellite nodes: a Kepler orbit with J2 secular drift of the node,
// perigee and mean anomaly, a low-precision Sun direction with a cylindrical-shadow eclipse flag and
// the LVLH body frame that payload pointing is expressed in. No DOM, renderer, transport or storage.
//
// Frames. "inertial" is an Earth-centred pseudo-inertial frame (mean equator and equinox, no
// precession or nutation, TEME-like). "fixed" is Earth-fixed and obtained from the inertial frame by
// the Greenwich mean sidereal angle only (UT1 taken equal to UTC, no polar motion). Geodetic output
// is WGS84 latitude and longitude in degrees with ellipsoidal height in km.
//
// Units. Distances km, speeds km/s, times in milliseconds since the Unix epoch at the interface and
// seconds internally, angles in degrees at the interface and radians internally.
//
// This is an explicit engineering model for nodes that a user places from the node tab. It is not a
// fit to observations, not GP/SGP4 and not measured telemetry. Atmospheric drag, third-body
// gravity, solar radiation pressure, manoeuvres and higher zonal terms are not modelled.

const DEGREES = 180 / Math.PI;
const RADIANS = Math.PI / 180;
const TWO_PI = 2 * Math.PI;
export const EARTH_A_KM = 6378.137;
const EARTH_FLATTENING = 1 / 298.257223563;
const EARTH_E2 = EARTH_FLATTENING * (2 - EARTH_FLATTENING);
export const EARTH_MU = 398600.4418;
export const EARTH_J2 = 1.08262668e-3;
export const MINIMUM_PERIGEE_ALTITUDE_KM = 120;
export const MAXIMUM_APOGEE_ALTITUDE_KM = 200_000;
const JULIAN_UNIX_EPOCH = 2440587.5;
const JULIAN_J2000 = 2451545.0;

// Elements are cached per definition object but keyed on the field values, so an orbit edited in
// place (the node editor does this) is recomputed instead of served from a stale entry.
const elementCache = new WeakMap();

function signatureOf(orbit) {
  return `${orbit.altitude_km}|${orbit.eccentricity}|${orbit.inclination}|${orbit.raan}|${orbit.argp}|${orbit.mean_anomaly}|${orbit.epoch instanceof Date ? orbit.epoch.getTime() : orbit.epoch}`;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function wrapRadians(angle) {
  const wrapped = angle % TWO_PI;
  return wrapped < 0 ? wrapped + TWO_PI : wrapped;
}

export function wrapDegrees(angle) {
  const wrapped = angle % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

export function epochMillis(value) {
  if (finite(value)) return value;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const time = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`);
  return Number.isFinite(time) ? time : null;
}

// Definition -> elements with J2 secular rates. Returns null for a definition outside the modelled
// domain instead of clamping it: a missing or impossible orbit is never replaced by a default one.
export function orbitElements(orbit) {
  if (!orbit || typeof orbit !== 'object') return null;
  const signature = signatureOf(orbit);
  const cached = elementCache.get(orbit);
  if (cached && cached.signature === signature) return cached.elements;
  const altitude = Number(orbit.altitude_km);
  const e = orbit.eccentricity === undefined || orbit.eccentricity === null || orbit.eccentricity === '' ? 0 : Number(orbit.eccentricity);
  const inclination = Number(orbit.inclination);
  const raan = orbit.raan === undefined ? 0 : Number(orbit.raan);
  const argp = orbit.argp === undefined ? 0 : Number(orbit.argp);
  const meanAnomaly = orbit.mean_anomaly === undefined ? 0 : Number(orbit.mean_anomaly);
  const epoch = epochMillis(orbit.epoch);
  let elements = null;
  if ([altitude, e, inclination, raan, argp, meanAnomaly].every(Number.isFinite) && epoch !== null
      && e >= 0 && e < 0.95 && inclination >= 0 && inclination <= 180) {
    const a = EARTH_A_KM + altitude;
    const perigeeAltitude = a * (1 - e) - EARTH_A_KM;
    const apogeeAltitude = a * (1 + e) - EARTH_A_KM;
    if (perigeeAltitude >= MINIMUM_PERIGEE_ALTITUDE_KM && apogeeAltitude <= MAXIMUM_APOGEE_ALTITUDE_KM) {
      const i = inclination * RADIANS;
      const n0 = Math.sqrt(EARTH_MU / (a * a * a));
      const p = a * (1 - e * e);
      const k = 1.5 * EARTH_J2 * (EARTH_A_KM / p) ** 2 * n0;
      const sin2 = Math.sin(i) ** 2;
      const raanDot = -k * Math.cos(i);
      const argpDot = k * (2 - 2.5 * sin2);
      const meanMotion = n0 + k * Math.sqrt(1 - e * e) * (1 - 1.5 * sin2);
      elements = Object.freeze({
        a, e, i, raan0: raan * RADIANS, argp0: argp * RADIANS, m0: meanAnomaly * RADIANS, epoch,
        n0, meanMotion, raanDot, argpDot, period: TWO_PI / n0, perigeeAltitude, apogeeAltitude,
        // The definition in degrees, kept so summaries do not carry radian round-trip noise.
        definition: Object.freeze({ altitude_km: altitude, eccentricity: e, inclination, raan: wrapDegrees(raan), argp: wrapDegrees(argp), mean_anomaly: wrapDegrees(meanAnomaly) }),
      });
    }
  }
  elementCache.set(orbit, { signature, elements });
  return elements;
}

// Kepler equation by Newton iteration; the eccentric anomaly in radians.
export function eccentricAnomaly(meanAnomaly, e) {
  const m = wrapRadians(meanAnomaly);
  let big = e < 0.8 ? m : Math.PI;
  for (let iteration = 0; iteration < 30; iteration += 1) {
    const step = (big - e * Math.sin(big) - m) / (1 - e * Math.cos(big));
    big -= step;
    if (Math.abs(step) < 1e-12) break;
  }
  return big;
}

// Greenwich mean sidereal angle in radians (Vallado, IAU-82 polynomial with UT1 = UTC).
export function gmst(date) {
  const millis = date instanceof Date ? date.getTime() : Number(date);
  const t = (millis / 86400000 + JULIAN_UNIX_EPOCH - JULIAN_J2000) / 36525;
  const seconds = 67310.54841 + (876600 * 3600 + 8640184.812866) * t + 0.093104 * t * t - 6.2e-6 * t * t * t;
  return wrapRadians((seconds % 86400) / 240 * RADIANS);
}

export function fixedFromInertial([x, y, z], theta) {
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return [x * cos + y * sin, -x * sin + y * cos, z];
}

export function geodeticFromFixed([x, y, z]) {
  const horizontal = Math.hypot(x, y);
  let latitude = Math.atan2(z, horizontal);
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const sine = Math.sin(latitude);
    const normal = EARTH_A_KM / Math.sqrt(1 - EARTH_E2 * sine * sine);
    latitude = Math.atan2(z + EARTH_E2 * normal * sine, horizontal);
  }
  const sine = Math.sin(latitude);
  const altitude = horizontal * Math.cos(latitude) + z * sine - EARTH_A_KM * Math.sqrt(1 - EARTH_E2 * sine * sine);
  return { longitude: Math.atan2(y, x) * DEGREES, latitude: latitude * DEGREES, altitude };
}

function rotate(frame, [x, y]) {
  const { raan, argp, i } = frame;
  const cosO = Math.cos(raan); const sinO = Math.sin(raan);
  const cosW = Math.cos(argp); const sinW = Math.sin(argp);
  const cosI = Math.cos(i); const sinI = Math.sin(i);
  return [
    (cosO * cosW - sinO * sinW * cosI) * x + (-cosO * sinW - sinO * cosW * cosI) * y,
    (sinO * cosW + cosO * sinW * cosI) * x + (-sinO * sinW + cosO * cosW * cosI) * y,
    sinI * sinW * x + sinI * cosW * y,
  ];
}

// Inertial position and velocity at a date. Secular J2 drift is applied to the node, the perigee
// and the mean anomaly; short-period terms are not modelled.
export function inertialStateAt(elements, date) {
  const millis = date instanceof Date ? date.getTime() : Number(date);
  if (!elements || !Number.isFinite(millis)) return null;
  const t = (millis - elements.epoch) / 1000;
  const meanAnomaly = wrapRadians(elements.m0 + elements.meanMotion * t);
  const raan = wrapRadians(elements.raan0 + elements.raanDot * t);
  const argp = wrapRadians(elements.argp0 + elements.argpDot * t);
  const { a, e, i } = elements;
  const big = eccentricAnomaly(meanAnomaly, e);
  const cosE = Math.cos(big); const sinE = Math.sin(big);
  const radius = a * (1 - e * cosE);
  const trueAnomaly = Math.atan2(Math.sqrt(1 - e * e) * sinE, cosE - e);
  const perifocal = [radius * Math.cos(trueAnomaly), radius * Math.sin(trueAnomaly)];
  const speedFactor = Math.sqrt(EARTH_MU * a) / radius;
  const perifocalVelocity = [-speedFactor * sinE, speedFactor * Math.sqrt(1 - e * e) * cosE];
  const frame = { raan, argp, i };
  const r = rotate(frame, perifocal);
  const v = rotate(frame, perifocalVelocity);
  return { r, v, radius, meanAnomaly, trueAnomaly: wrapRadians(trueAnomaly), raan, argp, seconds: t };
}

// Unit vector from Earth to the Sun in the inertial frame (Vallado algorithm 29, low precision).
export function sunDirectionAt(date) {
  const millis = date instanceof Date ? date.getTime() : Number(date);
  const t = (millis / 86400000 + JULIAN_UNIX_EPOCH - JULIAN_J2000) / 36525;
  const meanLongitude = wrapDegrees(280.460 + 36000.771 * t);
  const meanAnomaly = wrapDegrees(357.5291092 + 35999.05034 * t) * RADIANS;
  const longitude = (meanLongitude + 1.914666471 * Math.sin(meanAnomaly) + 0.019994643 * Math.sin(2 * meanAnomaly)) * RADIANS;
  const obliquity = (23.439291 - 0.0130042 * t) * RADIANS;
  return [Math.cos(longitude), Math.cos(obliquity) * Math.sin(longitude), Math.sin(obliquity) * Math.sin(longitude)];
}

export function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
export function norm(a) { return Math.hypot(a[0], a[1], a[2]); }
export function scale(a, factor) { return [a[0] * factor, a[1] * factor, a[2] * factor]; }
export function subtract(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
export function unit(a) { const length = norm(a); return length > 0 ? scale(a, 1 / length) : [0, 0, 0]; }

// Cylindrical Earth shadow: sunlit unless the body is behind Earth (r . s < 0) and inside the
// projected disc. Penumbra and atmospheric refraction are not modelled.
export function isSunlit(r, sunDirection) {
  const along = dot(r, sunDirection);
  if (along >= 0) return true;
  const perpendicular = norm(subtract(r, scale(sunDirection, along)));
  return perpendicular > EARTH_A_KM;
}

// LVLH body basis: x along the velocity, z along the radius vector (zenith), y = z x x (cross-track,
// to the left of the direction of motion when looking down at Earth).
export function lvlhBasis(r, v) {
  const z = unit(r);
  const along = unit(v);
  const y = unit(cross(z, along));
  const x = cross(y, z);
  return { x, y, z };
}

export function bodyComponents(basis, vector) {
  return [dot(basis.x, vector), dot(basis.y, vector), dot(basis.z, vector)];
}

// Complete state for one node at a date, or null when the definition is outside the domain.
export function nodeStateAt(orbit, date) {
  const elements = orbitElements(orbit);
  const inertial = inertialStateAt(elements, date);
  if (!inertial) return null;
  const theta = gmst(date);
  const fixed = fixedFromInertial(inertial.r, theta);
  const geodetic = geodeticFromFixed(fixed);
  const velocity = norm(inertial.v);
  if (![geodetic.longitude, geodetic.latitude, geodetic.altitude, velocity].every(Number.isFinite) || geodetic.altitude < 0) return null;
  const sun = sunDirectionAt(date);
  return {
    elements,
    inertial: { r: inertial.r, v: inertial.v },
    fixed: { r: fixed },
    geodetic: { ...geodetic, velocity },
    basis: lvlhBasis(inertial.r, inertial.v),
    radius: inertial.radius,
    meanAnomaly: inertial.meanAnomaly * DEGREES,
    trueAnomaly: inertial.trueAnomaly * DEGREES,
    raan: inertial.raan * DEGREES,
    argp: inertial.argp * DEGREES,
    gmst: theta * DEGREES,
    sunDirection: sun,
    sunlit: isSunlit(inertial.r, sun),
  };
}

// Catalog-style position for a node item: WGS84 degrees and km with the inertial speed in km/s.
export function nodePositionAt(item, date) {
  const state = nodeStateAt(item?.orbit, date);
  return state ? state.geodetic : null;
}

// Regime classification identical to digital_twin/simulation/orbital_elements.py.
export function orbitRegime({ periodMinutes, perigeeKm, apogeeKm, eccentricity }) {
  if (periodMinutes >= 1300 && periodMinutes <= 1550 && perigeeKm >= 30000 && perigeeKm <= 45000) return 'GEO';
  if (eccentricity >= 0.25 || apogeeKm >= 50000) return 'HEO';
  if (apogeeKm < 2000) return 'LEO';
  if (perigeeKm < 35786) return 'MEO';
  return 'GEO';
}

// GP-like summary fields for catalog listing and the inspector. Values derive from the definition
// (two-body mean motion), not from a fitted element set.
export function catalogElements(orbit) {
  const elements = orbitElements(orbit);
  if (!elements) return null;
  const periodMinutes = elements.period / 60;
  const meanMotion = 1440 / periodMinutes;
  const perigeeKm = elements.perigeeAltitude;
  const apogeeKm = elements.apogeeAltitude;
  return {
    EPOCH: new Date(elements.epoch).toISOString().replace('Z', ''),
    MEAN_MOTION: meanMotion,
    ECCENTRICITY: elements.e,
    INCLINATION: elements.definition.inclination,
    RA_OF_ASC_NODE: elements.definition.raan,
    ARG_OF_PERICENTER: elements.definition.argp,
    MEAN_ANOMALY: elements.definition.mean_anomaly,
    MEAN_MOTION_DOT: 0,
    MEAN_MOTION_DDOT: 0,
    BSTAR: 0,
    PERIOD_MINUTES: Math.round(periodMinutes * 1000) / 1000,
    SEMI_MAJOR_AXIS_KM: Math.round(elements.a * 1000) / 1000,
    PERIGEE_KM: Math.round(perigeeKm * 100) / 100,
    APOGEE_KM: Math.round(apogeeKm * 100) / 100,
    ORBIT_REGIME: orbitRegime({ periodMinutes, perigeeKm, apogeeKm, eccentricity: elements.e }),
    RAAN_DRIFT_DEG_PER_DAY: elements.raanDot * 86400 * DEGREES,
    ARGP_DRIFT_DEG_PER_DAY: elements.argpDot * 86400 * DEGREES,
  };
}
