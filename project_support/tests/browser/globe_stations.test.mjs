import test from 'node:test';
import assert from 'node:assert/strict';

import { loadGlobe } from './load_globe.mjs';
const { GlobeController, GROUND_STATIONS } = await loadGlobe();

const colour = (css, alpha = 1) => ({ css, alpha, withAlpha(next) { return colour(css, next); } });
const sites = {
  SEOUL: { key: 'SEOUL', name: '서울', latitude: 37.5665, longitude: 126.978, altitudeKm: .04 },
  DAEJEON: { key: 'DAEJEON', name: '대전', latitude: 36.3742, longitude: 127.3567, altitudeKm: .07 },
  GOLDSTONE: { key: 'GOLDSTONE', name: '골드스톤', latitude: 35.4267, longitude: -116.89, altitudeKm: 1 },
};

function globeWithSites(options = {}) {
  globalThis.window = {
    Cesium: {
      Cartesian3: { fromDegrees: (lon, lat, h) => ({ lon, lat, h }) },
      Cartesian2: class { constructor(x, y) { this.x = x; this.y = y; } },
      NearFarScalar: class { constructor(...args) { this.args = args; } },
      LabelStyle: { FILL_AND_OUTLINE: 1 },
      Color: { fromCssColorString: colour, WHITE: colour('white') },
      Math: { toRadians: degrees => degrees * Math.PI / 180 },
    },
  };
  const selected = [];
  const globe = new GlobeController({ style: {} }, {}, { sunElement: {}, stations: sites, onStationSelect: key => selected.push(key), ...options });
  const entities = [];
  const flights = [];
  globe.viewer = {
    entities: { add(entity) { entities.push(entity); return entity; }, removeAll() { entities.length = 0; } },
    scene: { requestRender() {}, canvas: { style: {} } },
    camera: { flyTo(options) { flights.push(options); } },
  };
  return { globe, entities, flights, selected };
}

test('the console passes its own site list; the built-in list stays the default for existing callers', () => {
  const { globe } = globeWithSites();
  assert.equal(globe.stations, sites);
  assert.deepEqual(Object.keys(new GlobeController({ style: {} }, {}, { sunElement: {} }).stations), Object.keys(GROUND_STATIONS));
});

test('every site becomes a marker with a label; the observer site is the large bright one', () => {
  const { globe, entities } = globeWithSites();
  globe.addGroundStations();
  assert.deepEqual(entities.map(entity => entity.id), ['ground-SEOUL', 'ground-DAEJEON', 'ground-GOLDSTONE']);
  assert.equal(entities[2].position.h, 1000, 'site height is used for the marker');
  const marker = key => globe.stationEntities.get(key).point;
  assert.equal(marker('SEOUL').pixelSize, 10, 'SEOUL is the default observer');
  assert.equal(marker('DAEJEON').pixelSize, 6);
  assert.equal(marker('SEOUL').color.alpha, 1);
  assert.ok(marker('DAEJEON').color.alpha < 1);
  globe.setObserver('GOLDSTONE', 10);
  assert.equal(marker('GOLDSTONE').pixelSize, 10);
  assert.equal(marker('SEOUL').pixelSize, 6);
  assert.equal(globe.observerKey, 'GOLDSTONE');
  globe.setObserver('NOWHERE');
  assert.equal(globe.observerKey, 'SEOUL', 'an unknown key falls back to Seoul');
});

test('clicking a site marker reports its key and nothing else is mistaken for a site', () => {
  const { globe, selected } = globeWithSites();
  globe.addGroundStations();
  assert.equal(globe.stationKeyFromPick({ id: { id: 'ground-DAEJEON' } }), 'DAEJEON');
  assert.equal(globe.stationKeyFromPick({ id: { id: 'ground-NOWHERE' } }), null);
  assert.equal(globe.stationKeyFromPick({ id: { satelliteId: '25544' } }), null);
  assert.equal(globe.stationKeyFromPick(null), null);
  globe.onStationSelect(globe.stationKeyFromPick({ id: { id: 'ground-GOLDSTONE' } }));
  assert.deepEqual(selected, ['GOLDSTONE']);
});

test('flying to a site looks straight down on it from a regional height', () => {
  const { globe, flights } = globeWithSites();
  assert.equal(globe.flyToStation('DAEJEON'), true);
  assert.deepEqual(flights[0].destination, { lon: 127.3567, lat: 36.3742, h: 2_500_000 });
  assert.ok(flights[0].orientation.pitch < -1.55);
  assert.equal(globe.flyToStation('NOWHERE'), false);
  assert.equal(flights.length, 1);
});

test('observer geometry and pass prediction use the console site list', () => {
  const { globe } = globeWithSites();
  globe.records.set('1', { item: {} });
  const sampledStations = [];
  globe.positionAt = () => ({ longitude: 127.3567, latitude: 36.3742, altitude: 500, velocity: 7.6 });
  globe.elevationAt = (position, station) => { sampledStations.push(station.key); return 89; };
  globe.setObserver('DAEJEON', 5);
  const passes = globe.predictPasses('1', 'GOLDSTONE', 1, { maskDegrees: 5, maxPasses: 1 });
  assert.ok(Array.isArray(passes));
  globe.tracksVisible = false; // the elevation gate runs before any line primitive is created
  globe.placeStationLink(globe.positionAt('1', new Date()));
  assert.ok(sampledStations.includes('DAEJEON'), 'the observer line uses the selected observer site');
});
