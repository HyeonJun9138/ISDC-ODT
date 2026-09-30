import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeScene, LINK_COLORS } from '../../../digital_twin/visualization/node_scene.js';

class Cartesian3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  static fromDegrees(longitude, latitude, height) { return new Cartesian3(longitude, latitude, height); }
  static subtract(a, b, result) { result.x = a.x - b.x; result.y = a.y - b.y; result.z = a.z - b.z; return result; }
  static magnitude(v) { return Math.hypot(v.x, v.y, v.z); }
  static normalize(v, result) { const m = Cartesian3.magnitude(v); result.x = v.x / m; result.y = v.y / m; result.z = v.z / m; return result; }
}
class Color {
  constructor(css, alpha = 1) { this.css = css; this.alpha = alpha; }
  static fromCssColorString(css) { return new Color(css); }
  withAlpha(alpha) { return new Color(this.css, alpha); }
}
class EntityCollection {
  constructor() { this.items = []; }
  add(entity) { entity.show = entity.show ?? true; this.items.push(entity); return entity; }
  remove(entity) { const index = this.items.indexOf(entity); if (index >= 0) this.items.splice(index, 1); return index >= 0; }
}

function fakeCesium(loads = []) {
  return {
    Cartesian3, Color,
    PolylineCollection: EntityCollection,
    Material: { fromType: (type, uniforms) => ({ type, uniforms }) },
    CallbackProperty: class { constructor(getter) { this.getter = getter; } },
    PolylineDashMaterialProperty: class { constructor(options) { this.dashed = true; this.color = options.color; } },
    CustomDataSource: class { constructor(name) { this.name = name; this.entities = new EntityCollection(); } },
    ArcType: { NONE: 'none' },
    Matrix3: class { static fromHeadingPitchRoll(hpr) { return { hpr }; } static multiply(a, b) { a.trim = b; return a; } },
    Matrix4: class { static fromRotationTranslation(rotation, translation) { return { rotation, translation }; } },
    HeadingPitchRoll: class { constructor(h, p, r) { Object.assign(this, { h, p, r }); } },
    Math: { toRadians: degrees => degrees * Math.PI / 180 },
    Ellipsoid: { WGS84: {} },
    Transforms: { rotationMatrixFromPositionVelocity: (position, velocity) => ({ position, velocity }), eastNorthUpToFixedFrame: position => ({ enu: position }) },
    ImageBasedLighting: class { constructor(options) { this.options = options; } },
    Model: { async fromGltfAsync(options) { loads.push(options); return { options, show: options.show, modelMatrix: null, destroyed: false, destroy() { this.destroyed = true; } }; } },
  };
}

function fakeGlobe(ids, { period = 95 } = {}) {
  const primitives = [];
  const dataSources = [];
  const records = new Map(ids.map(id => [id, { item: { ORBIT_REGIME: 'LEO', PERIOD_MINUTES: period } }]));
  return {
    viewer: {
      scene: { primitives: { items: primitives, add(model) { primitives.push(model); return model; }, remove(model) { const i = primitives.indexOf(model); if (i >= 0) primitives.splice(i, 1); return i >= 0; } } },
      entities: new EntityCollection(),
      dataSources: { items: dataSources, add(source) { dataSources.push(source); return source; } },
    },
    records,
    tracksVisible: true,
    palette: () => ({ LEO: '#ff9f43', fallback: '#ff9f43' }),
    positionAt: (id, date) => (id === 'dark' ? null : { longitude: Number(id) + date.getTime() / 100, latitude: 10, altitude: 550, velocity: 7.6 }),
  };
}

const model = key => ({ url: `/static/assets/models/${key}.glb`, scale: 2, minimumPixelSize: 12, orientation: { heading: 90 } });

test('models load once per node, hide for the selected node and are removed with the node', async () => {
  const loads = [];
  const globe = fakeGlobe(['1', '2', '3']);
  const scene = new NodeScene({ globe, cesium: () => fakeCesium(loads), timeSource: () => new Date(0) });
  await scene.setNodes([{ id: '1', model: model('a') }, { id: '2', model: model('b') }, { id: '3', model: null }]);
  assert.equal(loads.length, 2);
  assert.deepEqual(loads.map(load => load.id), [{ satelliteId: '1' }, { satelliteId: '2' }]);
  assert.equal(loads[0].scale, 2);
  assert.equal(globe.viewer.scene.primitives.items.length, 2);
  assert.equal(scene.models.get('1').model.show, true);
  assert.deepEqual(scene.models.get('1').model.modelMatrix.rotation.velocity, new Cartesian3(1, 0, 0), 'oriented along the propagated motion');
  assert.equal(scene.models.get('1').model.modelMatrix.rotation.trim.hpr.h, Math.PI / 2, 'manifest heading trim applied');
  scene.select('1');
  assert.equal(scene.models.get('1').model.show, false, 'the selected node is drawn by the follow layer');
  assert.equal(scene.models.get('2').model.show, true);
  await scene.setNodes([{ id: '2', model: model('b') }]);
  assert.equal(loads.length, 2, 'an unchanged model is not reloaded');
  assert.equal(scene.models.has('1'), false);
  assert.equal(globe.viewer.scene.primitives.items.length, 1);
  await scene.setNodes([{ id: '2', model: model('c') }]);
  assert.equal(loads.length, 3, 'a changed model key reloads');
  scene.setModelsVisible(false);
  assert.equal(scene.models.get('2').model.show, false);
});

test('trajectories are sampled over one period in a dedicated data source and hidden for the selected node', async () => {
  const globe = fakeGlobe(['1', 'dark']);
  const scene = new NodeScene({ globe, cesium: () => fakeCesium(), timeSource: () => new Date(0) });
  await scene.setNodes([{ id: '1', model: null }, { id: 'dark', model: null }]);
  assert.equal(globe.viewer.dataSources.items.length, 1, 'one CustomDataSource for scene entities');
  assert.equal(globe.viewer.entities.items.length, 0, 'the default collection stays untouched');
  const path = scene.paths.get('1');
  assert.equal(path.positions.length, 121);
  assert.equal(path.entity.show, true);
  assert.equal(scene.paths.get('dark').positions.length, 0, 'no position, no line');
  assert.equal(scene.paths.get('dark').entity.show, false);
  scene.select('1');
  assert.equal(path.entity.show, false);
  const builtAt = path.builtAt;
  scene.update(new Date(10_000));
  assert.equal(path.builtAt, builtAt, 'rebuilt only every 30 s');
  scene.update(new Date(40_000));
  assert.equal(path.builtAt, 40_000);
  globe.tracksVisible = false;
  scene.select(null);
  assert.equal(path.entity.show, false, 'follows the globe trajectory toggle');
});

test('links draw by state, use a dashed material while acquiring and vanish when blocked or removed', async () => {
  const globe = fakeGlobe(['1', '2', '3']);
  const scene = new NodeScene({ globe, cesium: () => fakeCesium(), timeSource: () => new Date(0) });
  await scene.setNodes([{ id: '1' }, { id: '2' }, { id: '3' }]);
  scene.setLinks([{ key: '1|2', a: '1', b: '2', state: 'locked' }, { key: '2|3', a: '2', b: '3', state: 'acquiring' }, { key: '1|3', a: '1', b: '3', state: 'blocked' }]);
  const locked = scene.links.get('1|2');
  assert.equal(locked.line.show, true);
  assert.equal(locked.line.material.uniforms.color.css, LINK_COLORS.locked);
  assert.equal(locked.positions.length, 2);
  assert.equal(scene.links.get('2|3').line.material.type, 'PolylineDash');
  assert.equal(scene.links.get('1|3').line.show, false, 'a blocked pair is not drawn');
  scene.setLinks([{ key: '1|2', a: '1', b: '2', state: 'one_way' }]);
  assert.equal(scene.links.size, 1);
  assert.equal(scene.links.get('1|2').line.material.uniforms.color.css, LINK_COLORS.one_way);
  scene.setLinksVisible(false);
  assert.equal(scene.links.get('1|2').line.show, false);
  scene.setLinksVisible(true);
  assert.equal(scene.links.get('1|2').line.show, true);
  await scene.setNodes([{ id: '1' }]);
  assert.equal(scene.links.size, 0, 'a link loses its endpoint with the removed node');
  scene.clear();
  assert.equal(scene.paths.size, 0);
  assert.equal(scene.dataSource.entities.items.length, 0);
});

test('without Cesium the scene degrades to a no-op instead of throwing', async () => {
  const scene = new NodeScene({ globe: { viewer: null, records: new Map(), positionAt: () => null }, cesium: () => undefined });
  await scene.setNodes([{ id: '1', model: model('a') }]);
  scene.setLinks([{ key: '1|2', a: '1', b: '2', state: 'locked' }]);
  scene.update(new Date(0), true);
  scene.select('1');
  scene.setTheme('light');
  assert.equal(scene.models.size, 0);
  assert.equal(scene.links.size, 0);
});
