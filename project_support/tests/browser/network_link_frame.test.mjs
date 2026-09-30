import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkScene } from '../../../digital_twin/visualization/network_scene.js';

class Collection {
  items = [];
  add(item) { item.show ??= true; this.items.push(item); return item; }
  remove(item) { const i = this.items.indexOf(item); if (i < 0) return false; this.items.splice(i, 1); return true; }
}
class Color {
  constructor(css, alpha = 1) { Object.assign(this, { css, alpha }); }
  static fromCssColorString(css) { return new Color(css); }
  withAlpha(alpha) { return new Color(this.css, alpha); }
}
function setup() {
  const cesium = {
    Color, Cartesian3: { fromDegrees: (x, y, z) => ({ x, y, z }) },
    CallbackProperty: class { constructor(getter) { this.getValue = getter; } },
    CustomDataSource: class { entities = new Collection(); },
    PolylineCollection: Collection,
    Material: { fromType: (type, uniforms) => ({ type, uniforms }) },
    ArcType: { NONE: 0 },
  };
  const globe = {
    viewer: { entities: new Collection(), dataSources: new Collection(), scene: { primitives: new Collection() } },
    positionAt: (id, date) => ({ longitude: Number(id) + date.getTime() / 1000, latitude: 10, altitude: 550 }),
  };
  const scene = new NetworkScene({ globe, cesium, timeSource: () => new Date(0) });
  scene.setLinks([{ key: '1|2', a: '1', b: '2', state: 'locked' }]);
  scene.stations.set('GS', { station: { longitude: 127, latitude: 36 } });
  scene.setGroundLinks([{ id: 'GS|1', station: 'GS', satellite: '1', state: 'usable' }]);
  // Cesium evaluates Entity properties before Scene.preUpdate. Primitive geometry is consumed after it.
  function frame(date) {
    const entities = [globe.viewer.entities, ...globe.viewer.dataSources.items.map(source => source.entities)];
    const rendered = entities.flatMap(collection => collection.items.filter(item => item.polyline && item.show)
      .map(item => ({ id: item.id, positions: item.polyline.positions.getValue?.() ?? item.polyline.positions })));
    scene.syncFrame(date);
    for (const collection of globe.viewer.scene.primitives.items) {
      for (const line of collection.items || []) if (line.show) rendered.push({ id: line.id, positions: line.positions });
    }
    return rendered;
  }
  return { scene, globe, frame };
}

test('OISL endpoints render at the same frame time as the moving satellites, including seeks', () => {
  const { frame } = setup();
  for (const [ms, first, second] of [[16, 1.016, 2.016], [49, 1.049, 2.049], [60000, 61, 62], [0, 1, 2]]) {
    const line = frame(new Date(ms)).find(item => item.id === 'node-link-1|2');
    assert.deepEqual(line.positions.map(position => position.x), [first, second]);
  }
});

test('ground links share the satellite frame while keeping the station fixed', () => {
  const { frame } = setup();
  const line = frame(new Date(32)).find(item => item.id === 'ground-link-GS|1');
  assert.deepEqual(line.positions.map(position => position.x), [127, 1.032]);
});

test('hidden, removed and missing-position links do not leave stale geometry', () => {
  const { scene, globe, frame } = setup();
  scene.setLinksVisible(false);
  assert.equal(frame(new Date(16)).some(line => line.id.startsWith('node-link')), false);
  scene.setLinksVisible(true);
  assert.equal(frame(new Date(32)).filter(line => line.id.startsWith('node-link')).length, 1);
  globe.positionAt = () => null;
  assert.deepEqual(frame(new Date(64)), []);
  scene.setLinks([]);
  scene.setGroundLinks([]);
  assert.deepEqual(frame(new Date(80)), []);
  scene.stations.clear();
  scene.clear();
  assert.equal(globe.viewer.scene.primitives.items.length, 0, 'release the link collection when clearing the scene');
});
