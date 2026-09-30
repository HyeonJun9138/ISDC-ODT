import test from 'node:test';
import assert from 'node:assert/strict';
import { diagramMarkup, layoutNetwork, linkTone } from '../../../digital_twin/visualization/network_diagram.js';

const formation = (plane, index, id, anomaly) => ({ id, name: id, raan: plane * 90, meanAnomaly: anomaly, formation: { id: 'FRM', plane, index } });

test('orbital planes form separate stable rings with ground stations below them', () => {
  const satellites = [formation(1, 0, 'B1', 90), formation(0, 1, 'A2', 180), formation(0, 0, 'A1', 0), formation(1, 1, 'B2', 270)];
  const input = structuredClone(satellites);
  const layout = layoutNetwork({ satellites, stations: [{id:'GS-B', longitude:127}, {id:'GS-A', longitude:15}] });
  assert.equal(layout.rings?.length, 2, 'each plane gets a ring rather than a shared horizontal row');
  assert.deepEqual(satellites, input, 'layout does not mutate the model input');
  assert.ok(layout.rings[0].cx < layout.rings[1].cx);
  assert.equal(layout.positions.get('A1').angle, layout.positions.get('B1').angle, 'formation indices keep their ring order despite phasing');
  assert.ok(layout.positions.get('GS-A').x < layout.positions.get('GS-B').x);
  for (const ring of layout.rings) for (const point of layout.positions.values()) {
    if (point.kind === 'satellite' && point.row === ring.index) {
      assert.ok(Math.abs(Math.hypot(point.x-ring.cx, point.y-ring.cy)-ring.radius) < .1);
      assert.ok(point.y + point.h/2 < layout.groundTop);
    }
  }
  const reordered = layoutNetwork({satellites:[...satellites].reverse()});
  assert.deepEqual(reordered.rings.map(r=>r.key), layout.rings.map(r=>r.key));
  assert.equal(layoutNetwork({}).rings.length, 0);
  const pair = diagramMarkup(layout, [{id:'pair',a:'A1',b:'A2',kind:'oisl',usable:true,quality:90}]);
  assert.match(pair, /<path class="line" d="M [-\d.]+ [-\d.]+ A/, 'two-node planes avoid drawing through the centre label');
});

test('sparse and dense rings keep every node card inside the diagram without overlap', () => {
  for (const [planes, count, stations] of [[1,1,0], [1,2,3], [1,12,3], [2,12,3], [6,8,8], [1,64,12]]) {
    const satellites = Array.from({length:planes}, (_,p)=>Array.from({length:count},(_,i)=>formation(p,i,`${p}-${i}`,i*360/count))).flat();
    const layout = layoutNetwork({satellites, stations:Array.from({length:stations},(_,i)=>({id:`GS-${i}`,longitude:i}))});
    const points = [...layout.positions.values()];
    assert.equal(points.length, planes*count+stations);
    for (const point of points) {
      assert.ok(point.x-point.w/2 >= 0 && point.x+point.w/2 <= layout.width, `${point.label} fits horizontally`);
      assert.ok(point.y-point.h/2 >= 0 && point.y+point.h/2 <= layout.height, `${point.label} fits vertically`);
    }
    for (let i=0;i<points.length;i++) for(let j=i+1;j<points.length;j++) {
      const a=points[i],b=points[j];
      assert.ok(Math.abs(a.x-b.x) >= (a.w+b.w)/2+3 || Math.abs(a.y-b.y) >= (a.h+b.h)/2+3, `${a.label} overlaps ${b.label}`);
    }
  }
});

test('link tone follows the fabric verdict and the markup carries selection, route and node state', () => {
  assert.equal(linkTone({ kind: 'oisl', usable: true, quality: 90 }), 'usable');
  assert.equal(linkTone({ kind: 'oisl', usable: true, quality: 60 }), 'degraded');
  assert.equal(linkTone({ kind: 'oisl', usable: false, reason: 'fault' }), 'fault');
  assert.equal(linkTone({ kind: 'ground', usable: true, quality: 100 }), 'ground');
  assert.equal(linkTone({ kind: 'terrestrial', usable: true }), 'terrestrial');
  assert.equal(linkTone({ kind: 'ground', usable: false, reason: 'below_mask' }), 'unusable');
  const layout = layoutNetwork({ satellites: [formation(0, 0, 'A1', 0), formation(0, 1, 'A2', 120), formation(0, 2, 'A3', 240)], stations: [{ id: 'GS', name: '대전', longitude: 127 }] });
  const links = [
    { id: 'A1|A2', a: 'A1', b: 'A2', kind: 'oisl', usable: true, quality: 95, delay_ms: 8.2 },
    { id: 'A1|A3', a: 'A1', b: 'A3', kind: 'oisl', usable: true, quality: 70, delay_ms: 9 },
    { id: 'A3|GS', a: 'GS', b: 'A3', kind: 'ground', usable: false, reason: 'below_mask' },
    { id: 'A2|GS', a: 'GS', b: 'A2', kind: 'ground', usable: true, quality: 100, delay_ms: 5 },
  ];
  const markup = diagramMarkup(layout, links, { selected: { type: 'link', id: 'A1|A2' }, routeLinkIds: new Set(['A2|GS']), hideUnusable: true, nodeStates: new Map([['A1', { tone: 'ok', badge: '12 MB', title: '대전까지 2홉' }]]) });
  assert.ok(markup.startsWith('<svg'));
  assert.match(markup, /data-diagram-link="A1\|A2"[^>]*>/);
  assert.match(markup, /class="nd-link usable oisl selected"/);
  assert.match(markup, /class="nd-link nd-tag ground ground routed"/, 'a ground contact is a tag beside its satellite');
  assert.match(markup, /class="nd-ground-line ground routed "/, 'only the routed contact also draws a line to the station');
  assert.match(markup, /class="nd-link degraded oisl dimmed"/, 'links that neither touch the selection nor carry the route fade');
  assert.doesNotMatch(diagramMarkup(layout, links, { hideUnusable: true }), /dimmed/, 'nothing fades without a selection');
  assert.doesNotMatch(markup, /data-diagram-link="A3\|GS"/, 'unusable ground links are hidden on request');
  assert.match(markup, /class="nd-link degraded oisl dimmed"[^>]*>[\s\S]*?<path class="line" d="M [-\d.]+ [-\d.]+ A/, 'same-plane neighbours follow the ring, including the wrap-around link');
  assert.match(markup, /class="nd-node satellite ok"[^>]*data-diagram-node="A1"/);
  assert.match(markup, /<text class="badge"[^>]*>12 MB<\/text>/);
  assert.match(markup, /data-diagram-node="GS"[^>]*>[\s\S]*?<rect class="body"/);
  assert.match(markup, /궤도면 01/);
  const escaped = diagramMarkup(layoutNetwork({ satellites: [{ id: 'S<1>', name: 'A&B', raan: 0, meanAnomaly: 0 }] }), []);
  assert.doesNotMatch(escaped, /A&B/);
  assert.match(escaped, /A&amp;B/);
});

test('ground contacts are tags beside the satellite that never cross the rings; lines appear only for the route or the selection', () => {
  const satellites = Array.from({ length: 12 }, (_, index) => ({ id: `S${index}`, name: `ODT-${index + 1}`, formation: { id: 'F', plane: 0, index } }));
  const layout = layoutNetwork({ satellites, stations: [{ id: 'GS-JEJU', name: '제주', longitude: 126.5 }, { id: 'GS-SVALBARD', name: '스발바르', longitude: 15.4 }] });
  const ring = layout.rings[0];
  const links = [
    { id: 'GS-JEJU|S1', a: 'GS-JEJU', b: 'S1', kind: 'ground', usable: true, quality: 100 },
    { id: 'GS-JEJU|S5', a: 'GS-JEJU', b: 'S5', kind: 'ground', usable: true, quality: 96 },
    { id: 'GS-SVALBARD|S1', a: 'GS-SVALBARD', b: 'S1', kind: 'ground', usable: true, quality: 90 },
    { id: 'GS-JEJU|S7', a: 'GS-JEJU', b: 'S7', kind: 'ground', usable: false, reason: 'fault' },
    { id: 'GS-JEJU|S9', a: 'GS-JEJU', b: 'S9', kind: 'ground', usable: false, reason: 'below_mask' },
  ];
  const plain = diagramMarkup(layout, links, { hideUnusable: true });
  const tags = [...plain.matchAll(/<g class="(nd-link nd-tag[^"]*)" data-diagram-link="([^"]+)"[^>]*>[\s\S]*?<rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*\/>[\s\S]*?<text[^>]*>([^<]*)<\/text>/g)]
    .map(match => ({ classes: match[1], id: match[2], x: Number(match[3]), y: Number(match[4]), w: Number(match[5]), h: Number(match[6]), text: match[7] }));
  assert.deepEqual(tags.map(tag => tag.id).sort(), ['GS-JEJU|S1', 'GS-JEJU|S5', 'GS-JEJU|S7', 'GS-SVALBARD|S1'], 'usable and faulted contacts show; a below-mask contact stays hidden');
  assert.equal(tags.find(tag => tag.id === 'GS-JEJU|S1').text, '제주 100%');
  assert.equal(tags.find(tag => tag.id === 'GS-SVALBARD|S1').text, '스발바르 90%');
  assert.equal(tags.find(tag => tag.id === 'GS-JEJU|S7').text, '제주 장애');
  assert.match(tags.find(tag => tag.id === 'GS-JEJU|S7').classes, /\bfault\b/);
  for (const tag of tags) {
    const card = layout.positions.get(tag.id.split('|')[1]);
    const centre = { x: tag.x + tag.w / 2, y: tag.y + tag.h / 2 };
    assert.ok(Math.hypot(centre.x - ring.cx, centre.y - ring.cy) > ring.radius + 20, `${tag.id} sits outside the ring`);
    assert.ok(Math.hypot(centre.x - card.x, centre.y - card.y) < 140, `${tag.id} stays beside its satellite`);
    for (const other of [...layout.positions.values()].filter(point => point.kind === 'satellite')) {
      const apart = tag.x + tag.w <= other.x - other.w / 2 || tag.x >= other.x + other.w / 2 || tag.y + tag.h <= other.y - other.h / 2 || tag.y >= other.y + other.h / 2;
      assert.ok(apart, `${tag.id} does not cover ${other.label}`);
    }
  }
  const s1 = tags.filter(tag => tag.id.endsWith('|S1'));
  assert.equal(s1.length, 2);
  assert.ok(s1[0].x + s1[0].w <= s1[1].x || s1[1].x + s1[1].w <= s1[0].x || s1[0].y + s1[0].h <= s1[1].y || s1[1].y + s1[1].h <= s1[0].y, 'two contacts of one satellite stack without overlapping');
  assert.doesNotMatch(plain, /nd-ground-line/, 'no contact draws a line to the ground tier by default');
  const routed = diagramMarkup(layout, links, { hideUnusable: true, routeLinkIds: new Set(['GS-JEJU|S5']) });
  const line = routed.match(/<g class="nd-ground-line ground routed "><path class="line" d="([^"]+)"/);
  assert.ok(line, 'the routed contact draws a line');
  const [endX, endY] = line[1].match(/ ([-\d.]+) ([-\d.]+)$/).slice(1).map(Number);
  const station = layout.positions.get('GS-JEJU');
  assert.ok(Math.abs(endX - station.x) < .6 && Math.abs(endY - (station.y - station.h / 2)) < .6, 'the line lands on top of the station card');
  assert.match(routed, /class="nd-link nd-tag ground ground routed"/);
  const selected = diagramMarkup(layout, links, { hideUnusable: true, selected: { type: 'link', id: 'GS-SVALBARD|S1' } });
  assert.match(selected, /class="nd-ground-line ground  selected"/);
  assert.match(selected, /class="nd-link nd-tag ground ground selected"/);
  assert.match(selected, /class="nd-link nd-tag ground ground dimmed"/, 'other contacts fade behind the selection');
});

test('planes fill the grid in serpentine order so neighbouring planes stay adjacent', () => {
  const satellites = Array.from({ length: 4 }, (_, plane) => Array.from({ length: 3 }, (_, index) => ({ id: `P${plane}-${index}`, name: `P${plane}-${index}`, raan: plane * 15, formation: { id: 'W', plane, index } }))).flat();
  const layout = layoutNetwork({ satellites });
  const [r0, r1, r2, r3] = layout.rings;
  assert.ok(r0.cx < r1.cx && Math.abs(r0.cy - r1.cy) < .1, 'planes 1 and 2 share the first row');
  assert.ok(r2.cy > r0.cy && r3.cy > r1.cy, 'planes 3 and 4 sit in the second row');
  assert.ok(Math.abs(r2.cx - r1.cx) < .1, 'plane 3 sits under plane 2, its RAAN neighbour');
  assert.ok(Math.abs(r3.cx - r0.cx) < .1, 'plane 4 sits under plane 1');
  const markup = diagramMarkup(layout, [{ id: 'x', a: 'P0-0', b: 'P1-0', kind: 'oisl', usable: true, quality: 80 }, { id: 'y', a: 'P0-0', b: 'P0-1', kind: 'oisl', usable: true, quality: 80 }]);
  assert.match(markup, /class="nd-link usable oisl cross"/, 'links between planes are marked cross');
  assert.match(markup, /class="nd-link usable oisl"/, 'links inside a plane are not');
});
