import test from 'node:test';
import assert from 'node:assert/strict';
import * as orbit from '../../../digital_twin/simulation/browser/orbit.js';
const { positionAt, elevationAt, predictPasses } = orbit;

function close(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

test('explicit demo uses a circular two-body speed instead of a catalog-index speed', () => {
  const entry = { item: { demo: true, altitude_km: 420, inclination: 51.64, phase: 0 }, record: null, index: 0 };
  const position = positionAt(entry, null, new Date(0));
  close(position.longitude, 0);
  close(position.latitude, 0);
  close(position.altitude, 420);
  close(position.velocity, 7.657269484581422);
  assert.deepEqual(position, positionAt({ ...entry, index: 71 }, null, new Date(0)));
  assert.equal(positionAt(null, null, new Date(0)), null);
});

test('demo inclination is an orbital-plane rotation and longitude includes Earth rotation', () => {
  const entry = { item: { demo: true, altitude_km: 420, inclination: 0, phase: 0 }, index: 0 };
  // A 6798.137 km circular orbit has a period of 5578.222707272112 s.
  const quarter = new Date(1394555.677);
  const position = positionAt(entry, null, quarter);
  close(position.longitude, 84.1734430007, 1e-4); // JavaScript Date truncates fractional milliseconds.
  close(position.latitude, 0);
  close(position.altitude, 420);
  const polar = positionAt({ item: { ...entry.item, inclination: 90, phase: Math.PI / 2 } }, null, new Date(0));
  close(polar.latitude, 90);
  close(polar.altitude, 441.3846857548, 1e-6);
  const retrograde = positionAt({ item: { ...entry.item, inclination: 180 } }, null, quarter);
  close(retrograde.longitude, -95.8265569993, 1e-4);
});

test('demo honors zero inclination and phase rather than normalized empty GP fields', () => {
  const item = Object.freeze({ demo: true, altitude_km: 420, inclination: 0, phase: 0, INCLINATION: 53, PERIOD_MINUTES: 0, APOGEE_KM: 0, PERIGEE_KM: 0 });
  const entry = Object.freeze({ item, record: { error: 1 }, index: 99 });
  assert.deepEqual(positionAt(entry, { propagate() { throw new Error('GP must not be used for a demo'); } }, new Date(0)), {
    longitude: 0, latitude: 0, altitude: 420, velocity: 7.657269484581422,
  });
});

test('a valid zero-altitude circular demo is not lost to coordinate roundoff', () => {
  const entry = { item: { demo: true, altitude_km: 0, inclination: 0, phase: 0 } };
  const position = positionAt(entry, null, new Date(1000));
  assert.ok(position, 'a mathematical surface-radius demo must not become an unavailable position');
  close(position.altitude, 0, 1e-9);
  assert.ok(position.velocity > 0);
});

test('real GP never silently becomes a demo when record or satellite library is unavailable', () => {
  const item = { altitude_km: 420, inclination: 51.64, phase: 0 };
  for (const flag of [undefined, false, 'true', 1]) {
    assert.equal(positionAt({ item: { ...item, demo: flag }, record: null, index: 0 }, null, new Date(0)), null);
  }
  assert.equal(positionAt({ item, record: {} }, null, new Date(0)), null);
});

test('demo rejects missing, nonfinite or out-of-domain parameters without inventing defaults', () => {
  const item = { demo: true, altitude_km: 420, inclination: 51.64, phase: 0 };
  for (const [key, invalid] of [
    ['altitude_km', undefined], ['altitude_km', null], ['altitude_km', -1], ['altitude_km', Infinity],
    ['inclination', undefined], ['inclination', ''], ['inclination', -1], ['inclination', 181],
    ['phase', undefined], ['phase', null], ['phase', false], ['phase', NaN],
  ]) {
    assert.equal(positionAt({ item: { ...item, [key]: invalid } }, null, new Date(0)), null, `${key}=${invalid}`);
  }
  for (const invalidDate of [null, undefined, new Date(NaN)]) {
    assert.equal(positionAt({ item }, null, invalidDate), null);
  }
});

test('SGP4 output is converted with the injected satellite adapter', () => {
  const date = new Date(0);
  const record = { meanMotion: 15 };
  const lib = {
    propagate(input, at) { assert.equal(input, record); assert.equal(at, date); return {position: {x: 1, y: 2, z: 3}, velocity: {x: 3, y: 4, z: 0}}; },
    gstime(at) { assert.equal(at, date); return 0.5; },
    eciToGeodetic(position, time) { assert.equal(position.x, 1); assert.equal(time, 0.5); return {longitude: 1, latitude: 0.5, height: 500}; },
    degreesLong: x => x * 180 / Math.PI,
    degreesLat: x => x * 180 / Math.PI,
  };
  const result = positionAt({item: {}, record, index: 0}, lib, date);
  assert.equal(result.altitude, 500);
  assert.equal(result.velocity, 5);
  assert.ok(Math.abs(result.longitude - 57.2957795) < 1e-6);
});

test('SGP4 rejects propagation errors, incomplete vectors and invalid geodetic values', () => {
  const entry = { item: {}, record: {} };
  const lib = {
    propagate() { return { position: { x: 6878, y: 0, z: 0 }, velocity: { x: 0, y: 7.6, z: 0 } }; },
    gstime: () => 0,
    eciToGeodetic: () => ({ longitude: 0, latitude: 0, height: 500 }),
    degreesLong: x => x * 180 / Math.PI,
    degreesLat: x => x * 180 / Math.PI,
  };
  for (const pv of [null, { position: false }, { position: { x: 1, y: 2 } },
    { position: { x: 1, y: 2, z: 3 }, velocity: null },
    { position: { x: 1, y: 2, z: 3 }, velocity: { x: null, y: 7, z: 0 } },
    { position: { x: Infinity, y: 2, z: 3 }, velocity: { x: 0, y: 7, z: 0 } },
  ]) {
    assert.equal(positionAt(entry, { ...lib, propagate: () => pv }, new Date(0)), null);
  }
  for (const geo of [null, { longitude: null, latitude: 0, height: 500 },
    { longitude: 0, latitude: 0, height: -10 }, { longitude: 0, latitude: 0, height: NaN },
    { longitude: 4, latitude: 0, height: 500 }, { longitude: 0, latitude: 2, height: 500 },
  ]) {
    assert.equal(positionAt(entry, { ...lib, eciToGeodetic: () => geo }, new Date(0)), null);
  }
  assert.equal(positionAt(entry, { ...lib, gstime: () => NaN }, new Date(0)), null);
  assert.equal(positionAt(entry, { ...lib, propagate() { throw new Error('decayed'); } }, new Date(0)), null);
  assert.equal(positionAt({ ...entry, record: { error: 6 } }, lib, new Date(0)), null);
});

test('directly overhead satellite has ninety-degree elevation', () => {
  assert.equal(elevationAt({latitude: 0, longitude: 0, altitude: 500}, {latitude: 0, longitude: 0}), 90);
});

test('look angles use station ellipsoidal altitude and a stable zenith convention', () => {
  assert.equal(typeof orbit.lookAnglesAt, 'function');
  const station = Object.freeze({ latitude: 45, longitude: 127, altitudeKm: 0.75 });
  const target = Object.freeze({ latitude: 45, longitude: 127, altitude: 500 });
  const angles = orbit.lookAnglesAt(target, station);
  close(angles.rangeKm, 499.25);
  close(angles.elevation, 90);
  assert.equal(angles.azimuth, 0); // Zenith/nadir azimuth is undefined; the API uses 0 by convention.
  close(elevationAt(target, station), angles.elevation);
});

test('look angles preserve east and west azimuth quadrants and geometric range', () => {
  assert.equal(typeof orbit.lookAnglesAt, 'function');
  const station = { latitude: 0, longitude: 0 };
  for (const [longitude, azimuth] of [[10, 90], [-10, 270]]) {
    const result = orbit.lookAnglesAt({ latitude: 0, longitude, altitude: 500 }, station);
    close(result.azimuth, azimuth);
    close(result.rangeKm, 1258.156841621362, 1e-6);
    close(result.elevation, 18.32177219377554, 1e-6);
  }
});

test('WGS84 horizon and polar geometry do not use a spherical Earth approximation', () => {
  assert.equal(typeof orbit.lookAnglesAt, 'function');
  const station = { latitude: 0, longitude: 0 };
  const horizon = orbit.lookAnglesAt({ latitude: 0, longitude: 21.981326185553144, altitude: 500 }, station);
  close(horizon.elevation, 0, 1e-6);
  close(horizon.rangeKm, 2574.51684787651, 1e-6);
  const pole = orbit.lookAnglesAt({ latitude: 90, longitude: 0, altitude: 500 }, station);
  close(pole.azimuth, 0);
  close(pole.elevation, -42.92890654112093, 1e-6);
  close(pole.rangeKm, 9364.59736933071, 1e-6);
});

test('look angles reject invalid coordinates, missing target altitude and zero separation', () => {
  assert.equal(typeof orbit.lookAnglesAt, 'function');
  const station = { latitude: 0, longitude: 0 };
  const target = { latitude: 0, longitude: 0, altitude: 500 };
  for (const invalid of [null, {}, { ...target, latitude: 91 }, { ...target, longitude: -181 },
    { ...target, latitude: null }, { ...target, longitude: false }, { ...target, altitude: undefined },
    { ...target, altitude: NaN }, { ...target, altitude: -1 },
  ]) {
    assert.equal(orbit.lookAnglesAt(invalid, station), null);
    assert.equal(elevationAt(invalid, station), null);
  }
  for (const invalid of [null, {}, { ...station, altitudeKm: null }, { ...station, altitudeKm: Infinity },
    { ...station, altitudeKm: -6378.137 }, { ...station, latitude: -91 },
  ]) assert.equal(orbit.lookAnglesAt(target, invalid), null);
  assert.equal(orbit.lookAnglesAt({ ...target, altitude: 0 }, station), null);
  close(orbit.lookAnglesAt(target, { ...station, altitudeKm: -0.4 }).rangeKm, 500.4);
});

const testStation = Object.freeze({ name: 'test', latitude: 0, longitude: 0 });
function equatorialPass(date) {
  const angle = (date.getTime() / 1000 - 397.125) * 0.08;
  return { latitude: 0, longitude: ((angle + 180) % 360 + 360) % 360 - 180, altitude: 500 };
}

test('pass crossings are refined to one second and peak time between samples is refined', () => {
  // At 500 km above the equator, the 5-degree-mask central angle is
  // acos(6378.137 / 6878.137 * cos(5 deg)) - 5 deg = 17.5153136946 deg.
  const [pass] = predictPasses(equatorialPass, testStation, new Date(0), 0.25);
  assert.ok(pass, 'a pass within the Unix-epoch search window must be returned');
  assert.equal(pass.station, 'test');
  close(pass.aos.getTime(), 178183.5788173, 1000);
  close(pass.los.getTime(), 616066.4211827, 1000);
  close(pass.maxAt.getTime(), 397125, 100);
  close(pass.maxElevation, 90, 0.1);
  assert.equal(pass.durationSeconds, Math.round((pass.los - pass.aos) / 1000));
  assert.equal(pass.inProgress, false);
  assert.equal(pass.truncated, false);
});

test('pass mask changes crossings and the result limit is configurable with a default of twelve', () => {
  const [pass] = predictPasses(equatorialPass, testStation, new Date(0), 0.25, { maskDegrees: 20 });
  assert.ok(pass, 'a pass above the requested mask must be returned');
  close(pass.aos.getTime(), 279871.1938950, 1000);
  close(pass.los.getTime(), 514378.8061050, 1000);
  assert.equal(predictPasses(equatorialPass, testStation, new Date(0)).length, 12);
  const limited = predictPasses(equatorialPass, testStation, new Date(0), 24, { maxPasses: 2 });
  assert.equal(limited.length, 2);
  assert.ok(limited[1].aos > limited[0].los);
});

test('passes distinguish an already active search start from an unobserved search end', () => {
  const [started] = predictPasses(equatorialPass, testStation, new Date(300000), 0.25);
  assert.equal(started.aos.getTime(), 300000);
  close(started.los.getTime(), 616066.4211827, 1000);
  assert.equal(started.inProgress, true);
  assert.equal(started.truncated, false);
  const [ended] = predictPasses(equatorialPass, testStation, new Date(0), 500 / 3600);
  assert.equal(ended.los.getTime(), 500000);
  assert.equal(ended.inProgress, false);
  assert.equal(ended.truncated, true);
  const [both] = predictPasses(equatorialPass, testStation, new Date(300000), 50 / 3600);
  assert.equal(both.aos.getTime(), 300000);
  assert.equal(both.los.getTime(), 350000);
  assert.equal(both.maxAt.getTime(), 350000);
  assert.equal(both.durationSeconds, 50);
  assert.equal(both.inProgress, true);
  assert.equal(both.truncated, true);
});

test('peak refinement includes a maximum within the first or last sampling interval', () => {
  const [nearStart] = predictPasses(equatorialPass, testStation, new Date(390000), 300 / 3600);
  close(nearStart.maxAt.getTime(), 397125, 100);
  close(nearStart.maxElevation, 90, 0.1);
  const [nearEnd] = predictPasses(equatorialPass, testStation, new Date(0), 400 / 3600);
  close(nearEnd.maxAt.getTime(), 397125, 100);
  close(nearEnd.maxElevation, 90, 0.1);
});

test('missing positions split passes rather than connecting visibility across a data gap', () => {
  const passes = predictPasses(date => date.getTime() >= 300000 && date.getTime() <= 500000 ? null : equatorialPass(date),
    testStation, new Date(0), 0.25);
  assert.equal(passes.length, 2);
  assert.ok(passes[0].los.getTime() < 300000);
  assert.ok(passes[1].aos.getTime() > 500000);
  for (const pass of passes) {
    assert.equal(pass.truncated, true);
    assert.equal(pass.inProgress, false);
    assert.ok(pass.maxAt >= pass.aos && pass.maxAt <= pass.los);
  }
});

test('a gap discovered during peak refinement also splits the pass', () => {
  const passes = predictPasses(date => date.getTime() > 396000 && date.getTime() < 399000 ? null : equatorialPass(date),
    testStation, new Date(0), 0.25);
  assert.equal(passes.length, 2);
  assert.ok(passes[0].los.getTime() <= 396000);
  assert.ok(passes[1].aos.getTime() >= 399000);
  assert.ok(passes.every(pass => pass.truncated));
});

test('peak refinement can detect a short grazing pass between coarse samples', () => {
  const path = date => {
    const elevation = Math.max(1, 6 - ((date.getTime() / 1000 - 45.125) / 10) ** 2) * Math.PI / 180;
    // A specified local line of sight at the equator, independent of orbit helpers.
    const x = 6378.137 + 500 * Math.sin(elevation);
    const y = 500 * Math.cos(elevation);
    return { latitude: 0, longitude: Math.atan2(y, x) * 180 / Math.PI, altitude: Math.hypot(x, y) - 6378.137 };
  };
  const passes = predictPasses(path, testStation, new Date(0), 120 / 3600);
  assert.equal(passes.length, 1);
  close(passes[0].aos.getTime(), 35125, 1000);
  close(passes[0].los.getTime(), 55125, 1000);
  close(passes[0].maxAt.getTime(), 45125, 100);
  close(passes[0].maxElevation, 6, 0.01);
});

test('invalid pass queries are rejected before any propagation and cannot create unbounded loops', () => {
  const mustNotPropagate = () => { throw new Error('invalid query reached the propagator'); };
  for (const hours of [0, -1, 169, Infinity, NaN, null]) {
    assert.throws(() => predictPasses(mustNotPropagate, testStation, new Date(0), hours), RangeError);
  }
  for (const maskDegrees of [-1, 90, Infinity, NaN, null]) {
    assert.throws(() => predictPasses(mustNotPropagate, testStation, new Date(0), 24, { maskDegrees }), RangeError);
  }
  for (const maxPasses of [0, -1, 1.5, 101, Infinity, null]) {
    assert.throws(() => predictPasses(mustNotPropagate, testStation, new Date(0), 24, { maxPasses }), RangeError);
  }
  for (const date of [null, undefined, new Date(NaN), new Date(8640000000000000)]) {
    assert.throws(() => predictPasses(mustNotPropagate, testStation, date), RangeError);
  }
  assert.throws(() => predictPasses(mustNotPropagate, { ...testStation, latitude: 91 }, new Date(0)), RangeError);
  assert.throws(() => predictPasses(mustNotPropagate, testStation, new Date(0), 24, null), TypeError);
  assert.throws(() => predictPasses(null, testStation, new Date(0)), TypeError);
});

test('a failing propagator gives no fabricated passes and an always visible window has its exact endpoint', () => {
  assert.deepEqual(predictPasses(() => { throw new Error('unavailable'); }, testStation, new Date(0), 0.01), []);
  assert.deepEqual(predictPasses(() => ({ latitude: null, longitude: 0, altitude: 500 }), testStation, new Date(0), 0.01), []);
  let calls = 0;
  const [pass] = predictPasses(date => {
    calls += 1;
    assert.ok(date.getTime() >= 0 && date.getTime() <= 36000);
    return { latitude: 0, longitude: 0, altitude: 500 };
  }, testStation, new Date(0), 0.01);
  assert.equal(pass.aos.getTime(), 0);
  assert.equal(pass.los.getTime(), 36000);
  assert.equal(pass.maxElevation, 90);
  assert.equal(pass.inProgress, true);
  assert.equal(pass.truncated, true);
  assert.ok(calls < 100);
});
