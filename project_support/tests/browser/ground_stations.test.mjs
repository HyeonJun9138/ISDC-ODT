import test from 'node:test';
import assert from 'node:assert/strict';
import { BANDS, DEFAULT_STATION_KEYS, STATION_PRESETS, antennaGainDbi, coverageRadiusKm, createStation, figureOfMeritDbK, normalizeStation, stationIdFor, surfaceDistanceKm, validateStation } from '../../../digital_twin/model_library/browser/ground_stations.js';

test('presets are real sites with bands, a dish and a mask', () => {
  for (const preset of Object.values(STATION_PRESETS)) {
    assert.ok(Math.abs(preset.latitude) <= 90 && Math.abs(preset.longitude) <= 180, preset.key);
    assert.ok(preset.bands.length && preset.bands.every(band => BANDS.includes(band)), preset.key);
    assert.ok(preset.dish_m > 0 && preset.min_elevation_deg >= 0, preset.key);
    assert.deepEqual(validateStation(createStation({ preset: preset.key })), [], preset.key);
  }
  assert.ok(DEFAULT_STATION_KEYS.every(key => STATION_PRESETS[key]));
  assert.equal(STATION_PRESETS.daejeon.region, '대한민국');
  assert.equal(stationIdFor('punta_arenas'), 'GS-PUNTA_ARENAS');
});

test('antenna gain and G/T follow the dish size and band', () => {
  const gainX = antennaGainDbi(7.3, 'X');
  const gainKa = antennaGainDbi(7.3, 'Ka');
  assert.ok(gainX > 50 && gainX < 56, `7.3 m at 8.2 GHz ≈ 53.7 dBi, got ${gainX}`);
  assert.ok(gainKa > gainX, 'higher frequency, higher gain for the same dish');
  assert.ok(antennaGainDbi(13, 'X') > gainX);
  const gt = figureOfMeritDbK(7.3, 'X');
  assert.ok(gt > 28 && gt < 33, `G/T ≈ 30.7 dB/K, got ${gt}`);
  assert.equal(antennaGainDbi(7.3, 'L'), null);
  assert.equal(figureOfMeritDbK(0, 'X'), null);
});

test('create, normalise and validate a custom site', () => {
  const station = createStation({ name: '  고흥 ', latitude: 34.6, longitude: 127.2, dish_m: 5, bands: ['X', 'L'], min_elevation_deg: 10 }, { id: 'GS-CUSTOM' });
  assert.equal(station.id, 'GS-CUSTOM');
  assert.equal(station.name, '고흥');
  assert.equal(station.preset, null);
  assert.deepEqual(station.bands, ['X'], 'unknown bands are dropped');
  assert.equal(station.enabled, true);
  assert.deepEqual(validateStation(station), []);
  assert.deepEqual(validateStation({ ...station, latitude: 95, bands: [], dish_m: 0 }).length, 3);
  assert.equal(normalizeStation({ name: 'no id' }), null);
  const restored = normalizeStation({ id: 'GS-SEOUL', preset: 'seoul', enabled: false, min_elevation_deg: '8' });
  assert.equal(restored.name, '서울');
  assert.equal(restored.enabled, false);
  assert.equal(restored.min_elevation_deg, 8);
});

test('surface distance and coverage radius are geometric', () => {
  const seoulJeju = surfaceDistanceKm(STATION_PRESETS.seoul, STATION_PRESETS.jeju);
  assert.ok(seoulJeju > 440 && seoulJeju < 470, `Seoul–Jeju ≈ 455 km, got ${seoulJeju}`);
  assert.equal(surfaceDistanceKm(STATION_PRESETS.seoul, STATION_PRESETS.seoul), 0);
  const zero = coverageRadiusKm(550, 0);
  const masked = coverageRadiusKm(550, 10);
  assert.ok(zero > 2500 && zero < 2700, `horizon range at 550 km ≈ 2600 km, got ${zero}`);
  assert.ok(masked < zero && masked > 1500);
  assert.equal(coverageRadiusKm(0, 0), 0);
});
