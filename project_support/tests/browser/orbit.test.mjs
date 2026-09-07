import test from 'node:test';
import assert from 'node:assert/strict';
import { positionAt, elevationAt, predictPasses } from '../../../digital_twin/simulation/browser/orbit.js';

test('demo propagation preserves baseline at epoch without a browser or Cesium', () => {
  const entry = { item: { demo: true, altitude_km: 420, inclination: 51.64, phase: 0 }, record: null, index: 0 };
  assert.deepEqual(positionAt(entry, null, new Date(0)), { longitude: -180, latitude: 0, altitude: 420, velocity: 7.3 });
  assert.equal(positionAt(null, null, new Date(0)), null);
});

test('SGP4 output is converted with the injected satellite adapter', () => {
  const date = new Date(0);
  const record = { meanMotion: 15 };
  const lib = {
    propagate(input, at) { assert.equal(input, record); assert.equal(at, date); return {position: {x: 1}, velocity: {x: 3, y: 4, z: 0}}; },
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

test('directly overhead satellite has ninety-degree elevation', () => {
  assert.equal(elevationAt({latitude: 0, longitude: 0, altitude: 500}, {latitude: 0, longitude: 0}), 90);
});

test('pass prediction samples forty-five-second intervals and keeps duration', () => {
  const station = {name: 'test', latitude: 0, longitude: 0};
  const result = predictPasses(date => ({latitude: 0, longitude: date.getTime() < 90000 ? 0 : 180, altitude: 500}), station, new Date(1), 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].durationSeconds, 45);
  assert.equal(result[0].maxElevation, 90);
});
