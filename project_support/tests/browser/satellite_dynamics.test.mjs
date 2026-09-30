import test from 'node:test';
import assert from 'node:assert/strict';
import * as dynamics from '../../../digital_twin/simulation/browser/satellite_dynamics.js';

const { orbitElements, nodeStateAt, nodePositionAt, catalogElements, gmst, sunDirectionAt, isSunlit, eccentricAnomaly, lvlhBasis, bodyComponents, orbitRegime } = dynamics;
const J2000_NOON = Date.UTC(2000, 0, 1, 12, 0, 0);

function close(actual, expected, tolerance, message = '') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} differs from ${expected} by more than ${tolerance}`);
}

test('Greenwich sidereal angle matches the IAU-82 reference value at J2000 noon', () => {
  close(gmst(J2000_NOON) * 180 / Math.PI, 280.46061837, 1e-4);
});

test('a circular orbit keeps its altitude, two-body speed and period', () => {
  const orbit = { altitude_km: 550, eccentricity: 0, inclination: 53, raan: 10, argp: 0, mean_anomaly: 0, epoch: J2000_NOON };
  const state = nodeStateAt(orbit, J2000_NOON);
  close(state.radius, 6928.137, 1e-9);
  close(state.geodetic.velocity, Math.sqrt(398600.4418 / 6928.137), 1e-9);
  close(state.elements.period / 60, 95.65, 0.01);
  assert.ok(state.geodetic.altitude > 528 && state.geodetic.altitude < 552, 'WGS84 height of a circular radius varies with latitude only');
  const later = nodeStateAt(orbit, J2000_NOON + state.elements.period * 1000);
  close(later.meanAnomaly, 0, 0.03, 'J2 alters the mean motion only slightly over one revolution');
});

test('J2 drives a westward node drift for prograde orbits and the sun-synchronous rate near 98.6 degrees', () => {
  const starlink = catalogElements({ altitude_km: 550, inclination: 53, epoch: 0 });
  close(starlink.RAAN_DRIFT_DEG_PER_DAY, -4.49, 0.02);
  const sso = catalogElements({ altitude_km: 800, inclination: 98.6, epoch: 0 });
  close(sso.RAAN_DRIFT_DEG_PER_DAY, 0.9856, 0.002);
  close(catalogElements({ altitude_km: 550, inclination: 90, epoch: 0 }).RAAN_DRIFT_DEG_PER_DAY, 0, 1e-10, 'a polar orbit has no node drift');
});

test('catalog fields mirror the Python regime rules and GP naming', () => {
  const leo = catalogElements({ altitude_km: 550, inclination: 53, raan: 30, argp: 40, mean_anomaly: 50, epoch: J2000_NOON });
  assert.equal(leo.ORBIT_REGIME, 'LEO');
  assert.equal(leo.EPOCH, '2000-01-01T12:00:00.000');
  close(leo.MEAN_MOTION, 1440 / leo.PERIOD_MINUTES, 1e-4, 'period is rounded to milli-minutes');
  assert.deepEqual([leo.INCLINATION, leo.RA_OF_ASC_NODE, leo.ARG_OF_PERICENTER], [53, 30, 40]);
  close(leo.MEAN_ANOMALY, 50, 1e-9);
  assert.equal(catalogElements({ altitude_km: 35786, inclination: 0.05, epoch: 0 }).ORBIT_REGIME, 'GEO');
  assert.equal(catalogElements({ altitude_km: 20200, inclination: 55, epoch: 0 }).ORBIT_REGIME, 'MEO');
  assert.equal(catalogElements({ altitude_km: 20000, eccentricity: 0.7, inclination: 63.4, epoch: 0 }).ORBIT_REGIME, 'HEO');
  assert.equal(orbitRegime({ periodMinutes: 100, perigeeKm: 500, apogeeKm: 2500, eccentricity: 0.1 }), 'MEO');
});

test('definitions outside the modelled domain yield no elements instead of a clamped orbit', () => {
  assert.equal(orbitElements({ altitude_km: 100, inclination: 0, epoch: 0 }), null, 'perigee below 120 km');
  assert.equal(orbitElements({ altitude_km: 1000, eccentricity: 0.9, inclination: 0, epoch: 0 }), null, 'perigee inside Earth');
  assert.equal(orbitElements({ altitude_km: 550, inclination: 181, epoch: 0 }), null);
  assert.equal(orbitElements({ altitude_km: 550, inclination: 53 }), null, 'epoch is required');
  assert.equal(orbitElements({ altitude_km: 'x', inclination: 53, epoch: 0 }), null);
  assert.equal(orbitElements({ altitude_km: 250000, inclination: 53, epoch: 0 }), null, 'apogee beyond 200,000 km');
  assert.equal(nodePositionAt({ orbit: { altitude_km: 550, inclination: 53, epoch: 0 } }, new Date('bad')), null);
  assert.equal(nodePositionAt({}, new Date(0)), null);
  assert.ok(orbitElements({ altitude_km: 550, inclination: 53, epoch: '2026-09-07T00:00:00' }), 'ISO epoch without zone is UTC');
});

test('eccentric orbits solve Kepler and place perigee at the argument of perigee', () => {
  close(eccentricAnomaly(Math.PI / 2, 0.5) - 0.5 * Math.sin(eccentricAnomaly(Math.PI / 2, 0.5)), Math.PI / 2, 1e-10);
  const orbit = { altitude_km: 20000, eccentricity: 0.7, inclination: 63.4, raan: 0, argp: 270, mean_anomaly: 0, epoch: J2000_NOON };
  const perigee = nodeStateAt(orbit, J2000_NOON);
  close(perigee.radius, (6378.137 + 20000) * 0.3, 1e-6);
  assert.ok(perigee.inertial.r[2] < 0, 'argument of perigee 270 puts perigee in the southern hemisphere');
  const elements = orbitElements(orbit);
  const apogee = nodeStateAt(orbit, J2000_NOON + elements.period / 2 * 1000);
  close(apogee.radius, (6378.137 + 20000) * 1.7, 1);
  assert.ok(apogee.geodetic.velocity < perigee.geodetic.velocity);
});

test('the Sun direction and eclipse test agree with the solstice geometry', () => {
  const sun = sunDirectionAt(J2000_NOON);
  close(Math.hypot(...sun), 1, 1e-12);
  assert.ok(sun[2] < -0.38 && sun[2] > -0.41, 'early January: Sun about 23 degrees south');
  const behind = [-7000 * sun[0], -7000 * sun[1], -7000 * sun[2]];
  assert.equal(isSunlit(behind, sun), false);
  assert.equal(isSunlit([7000 * sun[0], 7000 * sun[1], 7000 * sun[2]], sun), true);
  const perpendicular = [0, 0, 7000];
  assert.equal(isSunlit(perpendicular, sun), true, 'beside the shadow cylinder');
});

test('the LVLH basis is orthonormal with x along the velocity and z along the radius', () => {
  const state = nodeStateAt({ altitude_km: 550, inclination: 53, epoch: J2000_NOON }, J2000_NOON + 600000);
  const { x, y, z } = state.basis;
  for (const [a, b] of [[x, y], [y, z], [z, x]]) close(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], 0, 1e-12);
  close(Math.hypot(...y), 1, 1e-12);
  const ahead = nodeStateAt({ altitude_km: 550, inclination: 53, mean_anomaly: 1, epoch: J2000_NOON }, J2000_NOON + 600000);
  const d = ahead.inertial.r.map((value, index) => value - state.inertial.r[index]);
  const [bx, by, bz] = bodyComponents(lvlhBasis(state.inertial.r, state.inertial.v), d);
  assert.ok(bx > 0 && Math.abs(by) < 1e-6 && bz < 0, 'a leading body in the same plane sits ahead and slightly below the horizontal');
});
