import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeScene } from '../../../digital_twin/visualization/node_scene.js';
import { NetworkScene, ROUTE_COLOR } from '../../../digital_twin/visualization/network_scene.js';

function groundSetup() {
  const scene = setup(NetworkScene);
  scene.stations.set('GS', { station: { longitude: 127, latitude: 36 } });
  scene.setGroundLinks([{id:'GS|1',station:'GS',satellite:'1',state:'usable'}]);
  return scene;
}

test('usable ground links advance their packet phase while hidden and missing-position links stop', t => {
  t.mock.method(performance, 'now', () => 1000);
  const scene = groundSetup();
  const line = scene.groundLinks.get('GS|1').line;
  const before = line.material.uniforms.time;
  t.mock.method(performance, 'now', () => 1250);
  scene.syncFrame(new Date(0));
  assert.ok(line.material.uniforms.time > before, 'ground packet phase must advance with render frames');
  const phase = line.material.uniforms.time;
  scene.setGroundLinksVisible(false);
  t.mock.method(performance, 'now', () => 1500);
  scene.syncFrame(new Date(0));
  assert.equal(line.material.uniforms.time, phase);
  scene.setGroundLinksVisible(true);
  scene.globe.positionAt = () => null;
  scene.syncFrame(new Date(0));
  assert.equal(line.show, false);
  assert.equal(line.material.uniforms.time, phase);
});

test('ground route and selection emphasis retain the same animated material across snapshots', () => {
  const scene = groundSetup();
  const line = scene.groundLinks.get('GS|1').line;
  const material = line.material;
  assert.ok(Number.isFinite(material.uniforms.time));
  scene.setRoute(['GS|1']);
  scene.setSelectedLink('GS|1');
  scene.setGroundLinks([{id:'GS|1',station:'GS',satellite:'1',state:'usable'}]);
  assert.equal(line.material, material);
  assert.equal(material.uniforms.color.css, ROUTE_COLOR);
  scene.setRoute([]);
  assert.equal(line.material, material);
  assert.equal(material.uniforms.color.css, '#4ac4ee');
});

test('ground visible-only, fault and disconnected states never show packets and reconnect resumes', () => {
  const scene = groundSetup();
  const line = scene.groundLinks.get('GS|1').line;
  scene.setRoute(['GS|1']);
  for (const state of ['visible','fault','unusable']) {
    scene.setGroundLinks([{id:'GS|1',station:'GS',satellite:'1',state}]);
    assert.equal(line.material.uniforms.time, undefined);
  }
  assert.equal(line.show, false);
  scene.setGroundLinks([{id:'GS|1',station:'GS',satellite:'1',state:'usable'}]);
  assert.equal(line.show, true);
  assert.ok(Number.isFinite(line.material.uniforms.time));
});

class Material {
  constructor(options) { Object.assign(this, options); this.uniforms = options.fabric.uniforms; }
  static fromType(type, uniforms) { return { type, uniforms }; }
}
const color = (css, alpha = 1) => ({ css, alpha, withAlpha: value => color(css, value) });
class Collection {
  items = [];
  add(item) { this.items.push(item); return item; }
  remove(item) { this.items = this.items.filter(value => value !== item); }
}
function setup(Scene = NodeScene) {
  const cesium = { Material, Color: { fromCssColorString: color }, PolylineCollection: Collection,
    Cartesian3: { fromDegrees: (x, y, z) => ({ x, y, z }) } };
  const globe = { viewer: { scene: { primitives: new Collection() } },
    positionAt: id => ({ longitude: Number(id), latitude: 10, altitude: 550 }) };
  const scene = new Scene({ globe, cesium, timeSource: () => new Date(0) });
  scene.setLinks([{ key: '1|2', a: '1', b: '2', state: 'locked' }]);
  return scene;
}

test('locked OISL links animate on render frames even with a paused analysis clock', t => {
  t.mock.method(performance, 'now', () => 1000);
  const scene = setup();
  const line = scene.links.get('1|2').line;
  const before = line.material.uniforms.time;
  t.mock.method(performance, 'now', () => 1250);
  scene.syncFrame(new Date(0));
  assert.ok(line.material.uniforms.time > before, 'packet phase must advance, not remain a solid line');
  const phase = line.material.uniforms.time;
  scene.setLinksVisible(false);
  t.mock.method(performance, 'now', () => 1500);
  scene.syncFrame(new Date(0));
  assert.equal(line.material.uniforms.time, phase, 'hidden links do not animate');
  scene.setLinksVisible(true);
  scene.syncFrame(new Date(0));
  assert.ok(line.material.uniforms.time > phase);
});

test('route emphasis preserves the moving material and periodic snapshots do not restart it', () => {
  const scene = setup(NetworkScene);
  const line = scene.links.get('1|2').line;
  const material = line.material;
  scene.setRoute(['1|2']);
  assert.equal(line.material, material);
  assert.equal(line.material.uniforms.color.css, ROUTE_COLOR);
  assert.ok(Number.isFinite(line.material.uniforms.time));
  scene.setLinks([{ key: '1|2', a: '1', b: '2', state: 'locked' }]);
  assert.equal(line.material, material);
  scene.setRoute([]);
  assert.equal(line.material, material);
  assert.equal(line.material.uniforms.color.css, '#3ddc84');
});

test('acquisition and one-way links do not imply bidirectional data flow; reconnect resumes', () => {
  const scene = setup();
  const line = scene.links.get('1|2').line;
  for (const state of ['acquiring', 'slewing', 'one_way', 'blocked']) {
    scene.setLinks([{ key: '1|2', a: '1', b: '2', state }]);
    assert.equal(line.material.uniforms.time, undefined);
  }
  assert.equal(line.show, false);
  scene.setLinks([{ key: '1|2', a: '1', b: '2', state: 'locked' }]);
  assert.equal(line.show, true);
  assert.ok(Number.isFinite(line.material.uniforms.time));
});
