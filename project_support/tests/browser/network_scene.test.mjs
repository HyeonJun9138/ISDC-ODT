import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkScene, GROUND_LINK_COLORS, ROUTE_COLOR } from '../../../digital_twin/visualization/network_scene.js';

class Cartesian3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  static fromDegrees(longitude, latitude, height) { return new Cartesian3(longitude, latitude, height); }
}
class Color {
  constructor(css, alpha = 1) { this.css = css; this.alpha = alpha; }
  static fromCssColorString(css) { return new Color(css); }
  withAlpha(alpha) { return new Color(this.css, alpha); }
}
Color.WHITE = new Color('#fff');
class EntityCollection {
  constructor() { this.items = []; }
  add(entity) { entity.show = entity.show ?? true; this.items.push(entity); return entity; }
  remove(entity) { const index = this.items.indexOf(entity); if (index >= 0) this.items.splice(index, 1); return index >= 0; }
}
const fakeCesium = () => ({
  Cartesian3, Color,
  PolylineCollection: EntityCollection,
  Material: { fromType: (type, uniforms) => ({ type, uniforms }) },
  Cartesian2: class { constructor(x, y) { this.x = x; this.y = y; } },
  CallbackProperty: class { constructor(getter) { this.getter = getter; } },
  PolylineDashMaterialProperty: class { constructor(options) { this.dashed = true; this.color = options.color; } },
  CustomDataSource: class { constructor(name) { this.name = name; this.entities = new EntityCollection(); } },
  ArcType: { NONE: 'none' },
  LabelStyle: { FILL_AND_OUTLINE: 2 },
  NearFarScalar: class { constructor(...values) { this.values = values; } },
});
function fakeGlobe(ids) {
  const dataSources = [];
  return {
    viewer: { scene: { primitives: { add: m => m, remove: () => true }, pick: () => null }, entities: new EntityCollection(), dataSources: { items: dataSources, add(source) { dataSources.push(source); return source; } } },
    records: new Map(ids.map(id => [id, { item: { ORBIT_REGIME: 'LEO', PERIOD_MINUTES: 95 } }])),
    tracksVisible: true,
    palette: () => ({ LEO: '#ff9f43', fallback: '#ff9f43' }),
    positionAt: id => ({ longitude: Number(id), latitude: 10, altitude: 550, velocity: 7.6 }),
  };
}
const station = (id, longitude) => ({ id, name: id, latitude: 36, longitude, altitude_km: 0.1, min_elevation_deg: 5, bands: ['X'] });

test('stations get a marker and a coverage ellipse sized by the injected radius; removal cleans both', () => {
  const globe = fakeGlobe(['1', '2']);
  const scene = new NetworkScene({ globe, cesium: fakeCesium(), timeSource: () => new Date(0), coverageRadiusKm: site => site.min_elevation_deg === 5 ? 2000 : 0 });
  scene.setStations([station('GS-A', 127), station('GS-B', 15)]);
  const entities = scene.entityCollection().items;
  assert.equal(scene.stations.size, 2);
  assert.equal(entities.filter(entity => entity.id.startsWith('station-coverage-')).length, 2);
  const coverage = entities.find(entity => entity.id === 'station-coverage-GS-A');
  assert.equal(coverage.ellipse.semiMajorAxis, 2_000_000);
  assert.equal(coverage.show, true);
  scene.setStations([{ ...station('GS-A', 127), name: '대전', min_elevation_deg: 30 }]);
  assert.equal(scene.stations.size, 1);
  assert.equal(entities.some(entity => entity.id === 'station-GS-B'), false);
  assert.equal(entities.find(entity => entity.id === 'station-GS-A').label.text, '대전');
  assert.equal(coverage.show, false, 'a zero radius hides the coverage');
  assert.equal(scene.setCoverageVisible(false), false);
});

test('ground links follow the fabric state, hide when unusable and take route or selection emphasis', () => {
  const globe = fakeGlobe(['1', '2']);
  const cesium = fakeCesium();
  const scene = new NetworkScene({ globe, cesium, timeSource: () => new Date(0), coverageRadiusKm: () => 1000 });
  scene.setStations([station('GS-A', 127)]);
  scene.setLinks([{ key: 'N1|N2', a: '1', b: '2', state: 'locked' }]);
  scene.setGroundLinks([{ id: 'GS-A|N1', station: 'GS-A', satellite: '1', state: 'usable' }, { id: 'GS-A|N2', station: 'GS-A', satellite: '2', state: 'unusable' }]);
  const usable = scene.groundLinks.get('GS-A|N1');
  const unusable = scene.groundLinks.get('GS-A|N2');
  assert.equal(usable.line.show, true);
  assert.equal(usable.line.material.uniforms.color.css, GROUND_LINK_COLORS.usable);
  assert.equal(usable.positions.length, 2);
  assert.equal(unusable.line.show, false);
  scene.setRoute(['GS-A|N1', 'N1|N2']);
  assert.equal(usable.line.material.uniforms.color.css, ROUTE_COLOR);
  assert.equal(usable.line.width, 4.5);
  assert.equal(scene.links.get('N1|N2').line.material.uniforms.color.css, ROUTE_COLOR);
  scene.setRoute([]);
  assert.equal(usable.line.width, 2);
  assert.equal(scene.links.get('N1|N2').line.material.uniforms.color.css, '#3ddc84');
  scene.setSelectedLink('GS-A|N1');
  assert.equal(usable.line.width, 4);
  scene.setGroundLinks([{ id: 'GS-A|N1', station: 'GS-A', satellite: '1', state: 'fault' }]);
  assert.equal(usable.line.material.type, 'PolylineDash');
  assert.equal(scene.groundLinks.has('GS-A|N2'), false);
  assert.equal(scene.setGroundLinksVisible(false), false);
  assert.equal(usable.line.show, false);
  scene.setStations([]);
  assert.equal(scene.groundLinks.size, 0, 'links of a removed station go with it');
  scene.clear();
  assert.equal(scene.stations.size, 0);
});

test('stationAt reads the station id off a picked entity', () => {
  const globe = fakeGlobe([]);
  const scene = new NetworkScene({ globe, cesium: fakeCesium(), timeSource: () => new Date(0) });
  globe.viewer.scene.pick = () => ({ id: { properties: { stationId: { getValue: () => 'GS-A' } } } });
  assert.equal(scene.stationAt({ x: 1, y: 1 }), 'GS-A');
  globe.viewer.scene.pick = () => ({ id: { satelliteId: '1' } });
  assert.equal(scene.stationAt({ x: 1, y: 1 }), null);
});
