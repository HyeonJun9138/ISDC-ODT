import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ICDS, LINKS, MODES, MODULES, STORAGE_KEY, VIEWBOX, ZONES,
  bezierPath, centerOf, endpointOf, evaluateLinks, isEmbeddedHost, layoutEdges, linkById, linkState, loadSettings,
  moduleStatus, normalizeLinkSettings, probeReason, probeTargets, resolveLink, saveSettings, sideFor, summarize, securityDeployment,
} from '../../../user_application/web/scripts/settings/topology.js';

const ids = items => items.map(item => item.id);

test('security deployment displays server reports rather than diagnostic addresses', () => {
  assert.equal(securityDeployment(null).placement, '미확인');
  assert.equal(securityDeployment(null).state, 'idle');
  const report = { placement: 'remote', endpoint: 'http://actual.example:8765', reachable: true,
    contract_version: '1.0', implementation: 'security-sim' };
  const view = securityDeployment(report);
  assert.equal(view.placement, '외부');
  assert.equal(view.endpoint, report.endpoint);
  assert.equal(view.response, '응답 확인');
  assert.equal(view.contract, '1.0');
  assert.equal(securityDeployment({ ...report, reachable: false }).state, 'warn');
  assert.equal(securityDeployment(report, '시간 초과').state, 'warn');
  assert.match(securityDeployment(report, '시간 초과').response, /시간 초과/);
  assert.match(securityDeployment(report, '시간 초과').placement, /마지막/);
  assert.equal(securityDeployment({ placement: 'embedded', reachable: true, endpoint: 'in-process' }).placement, '내장 SIM');
  assert.equal(securityDeployment({ placement: 'embedded', reachable: true, endpoint: null }).endpoint, '동일 프로세스 / in-process');
  assert.equal(securityDeployment({ placement: 'remote', reachable: true, endpoint: null }).endpoint, '미확인');
});

test('security modules preserve old settings and require real evidence', () => {
  const ops = MODULES.find(module => module.id === 'security-ops');
  const external = MODULES.find(module => module.id === 'security-external');
  assert.ok(ops && external, 'separate security SW and external-system cards');
  assert.equal(ops.group, 'ops');
  assert.match(ops.role, /SIM/);
  assert.equal(external.placement, 'external');
  const icd = ICDS.find(item => item.id === 'ICD-08');
  assert.equal(icd.status, 'draft');
  const opsLink = linkById(icd.link);
  const externalLink = LINKS.find(link => [link.from, link.to].includes(external.id));
  assert.equal(linkState(opsLink).state, 'unknown');
  assert.equal(resolveLink(externalLink).enabled, false);
  assert.equal(linkState(externalLink).state, 'disabled');
  assert.equal(linkState(externalLink, { overrides: { [externalLink.id]: { enabled: true } } }).state, 'unknown');
  assert.equal(probeTargets(evaluateLinks()).some(item => item.id === externalLink.id), false);
  const saved = loadSettings({ getItem: () => JSON.stringify({ mode: 'em', links: { L01: { host: 'legacy.local', port: 9001 } } }) });
  assert.equal(resolveLink(linkById('L01'), saved.links).host, 'legacy.local');
  assert.equal(resolveLink(externalLink, saved.links).enabled, false);
});

test('the catalog is internally consistent', () => {
  assert.deepEqual(ids(MODES), ['standalone', 'em', 'integration']);
  assert.equal(new Set(ids(MODULES)).size, MODULES.length, 'module ids are unique');
  assert.equal(new Set(ids(LINKS)).size, LINKS.length, 'link ids are unique');
  assert.equal(new Set(ids(ICDS)).size, ICDS.length, 'ICD ids are unique');
  const moduleIds = new Set(ids(MODULES));
  for (const link of LINKS) {
    assert.ok(moduleIds.has(link.from) && moduleIds.has(link.to), `${link.id} joins known modules`);
    assert.ok(link.modes.length > 0 && link.modes.every(mode => ids(MODES).includes(mode)), `${link.id} lists valid modes`);
    if (link.icd) assert.ok(ICDS.some(icd => icd.id === link.icd), `${link.id} references a registered ICD`);
    if (link.kind === 'external') assert.ok(linkById(link.via), `${link.id} names its gateway link`);
  }
  for (const icd of ICDS) {
    const link = linkById(icd.link);
    assert.ok(link, `${icd.id} points at a link`);
    assert.deepEqual(new Set(icd.parties), new Set([link.from, link.to]), `${icd.id} parties match its link`);
    assert.ok(icd.messages.length >= 3);
  }
  for (const module of MODULES) {
    const zone = ZONES.find(item => item.group === module.group);
    assert.ok(module.x >= zone.x && module.x + module.w <= zone.x + zone.w && module.y >= zone.y && module.y + module.h <= zone.y + zone.h, `${module.id} sits inside its zone`);
  }
  for (const a of MODULES) for (const b of MODULES) {
    if (a === b) continue;
    const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    assert.ok(!overlap, `${a.id} and ${b.id} do not overlap`);
  }
});

test('embedded hosts are recognised and settings are normalised against the link defaults', () => {
  assert.ok(isEmbeddedHost('127.0.0.1') && isEmbeddedHost('localhost') && isEmbeddedHost(' self ') && isEmbeddedHost('in-process') && isEmbeddedHost(''));
  assert.ok(!isEmbeddedHost('10.20.0.5') && !isEmbeddedHost('em-sbc.local'));
  const link = linkById('L01');
  const normalised = normalizeLinkSettings({ transport: 'UDP', host: ' 10.0.0.9 ', port: '6000', heartbeat: '1.25', timeout: 'abc', reconnect: true, enabled: false }, link);
  assert.deepEqual(normalised, { transport: 'UDP', host: '10.0.0.9', port: 6000, heartbeat: 1.3, timeout: 6, reconnect: true, enabled: false });
  assert.equal(normalizeLinkSettings({ transport: 'carrier-pigeon', port: 70000 }, link).transport, 'TCP');
  assert.equal(normalizeLinkSettings({ transport: 'carrier-pigeon', port: 70000 }, link).port, 5101);
  assert.equal(endpointOf(resolveLink(link)), '127.0.0.1:5101');
  assert.equal(endpointOf(resolveLink(linkById('L05'))), 'in-process');
  assert.equal(endpointOf(resolveLink(linkById('L09')), 'host:18766'), 'host:18766');
});

test('link state follows the mode, the operator settings, the gateway and the console socket', () => {
  const l01 = linkById('L01'), l04 = linkById('L04'), l09 = linkById('L09'), l13 = linkById('L13'), l10 = linkById('L10');
  assert.equal(linkState(l01, { mode: 'standalone' }).state, 'active');
  assert.equal(linkState(l04, { mode: 'standalone' }).state, 'standby');
  assert.equal(linkState(l04, { mode: 'em' }).state, 'active');
  assert.equal(linkState(l10, { mode: 'em' }).state, 'active', 'the embedded scenario player serves every mode');
  assert.equal(linkState(l10, { mode: 'integration' }).state, 'active');
  assert.equal(linkState(linkById('L11'), { mode: 'em' }).state, 'standby');
  assert.equal(linkState(l01, { mode: 'standalone', overrides: { L01: { enabled: false } } }).state, 'disabled');
  const remote = linkState(l01, { mode: 'standalone', overrides: { L01: { host: '10.1.1.4', port: 9000 } } });
  assert.equal(remote.state, 'down');
  assert.match(remote.reason, /10\.1\.1\.4:9000/);
  assert.equal(linkState(l09, { mode: 'standalone', health: { socket: 'open' } }).state, 'active');
  assert.equal(linkState(l09, { mode: 'standalone', health: { socket: 'closed' } }).state, 'down');
  assert.equal(linkState(l09, { mode: 'standalone', health: {} }).state, 'down');
  assert.equal(linkState(l13, { mode: 'em' }).state, 'active', 'EM internal links report through the gateway');
  assert.equal(linkState(l13, { mode: 'em', overrides: { L04: { enabled: false } } }).state, 'down');
  assert.equal(linkState(l13, { mode: 'standalone' }).state, 'standby');
});

test('evaluations summarise per state and roll up into module status', () => {
  const standalone = evaluateLinks({ mode: 'standalone', health: { socket: 'open' } });
  assert.deepEqual(summarize(standalone), { total: 17, active: 9, down: 0, standby: 6, disabled: 1, unknown: 1 }, 'the embedded scenario player link L10 is active in every mode');
  assert.equal(moduleStatus('framework', standalone), 'ok');
  assert.equal(moduleStatus('em-ops', standalone), 'idle');
  const everything = evaluateLinks({ mode: 'integration', health: { socket: 'open' } });
  assert.equal(summarize(everything).active, 15);
  const broken = evaluateLinks({ mode: 'integration', health: { socket: 'closed' }, overrides: { L02: { host: 'fabric.remote' } } });
  assert.equal(summarize(broken).down, 2);
  assert.equal(moduleStatus('console', broken), 'warn');
  assert.equal(moduleStatus('data-fabric', broken), 'warn');
  assert.equal(moduleStatus('model', broken), 'ok');
});

test('settings persist through a storage-like object and tolerate garbage', () => {
  const memory = new Map();
  const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  assert.deepEqual(loadSettings(storage), { mode: 'standalone', links: {} });
  assert.ok(saveSettings(storage, { mode: 'em', links: { L01: { enabled: false } } }));
  assert.deepEqual(loadSettings(storage), { mode: 'em', links: { L01: { enabled: false } } });
  memory.set(STORAGE_KEY, '{not json');
  assert.deepEqual(loadSettings(storage), { mode: 'standalone', links: {} });
  memory.set(STORAGE_KEY, JSON.stringify({ mode: 'bogus', links: 'nope' }));
  assert.deepEqual(loadSettings(storage), { mode: 'standalone', links: {} });
  assert.deepEqual(loadSettings(null), { mode: 'standalone', links: {} });
  assert.equal(saveSettings({ setItem() { throw new Error('quota'); } }, {}), false);
});

test('backend probe results override the placement rule and unprobed links read as unverified', () => {
  const l01 = linkById('L01'), l09 = linkById('L09'), l13 = linkById('L13');
  const up = { L01: { state: 'up', method: 'tcp-connect', latency_ms: 3.4, detail: '10.1.1.4:5101 TCP 연결 성공' } };
  assert.deepEqual(linkState(l01, { mode: 'standalone', overrides: { L01: { host: '10.1.1.4' } }, health: { probes: up } }), { state: 'active', reason: 'TCP · 10.1.1.4:5101 TCP 연결 성공 · 3.4 ms' });
  const down = { L01: { state: 'down', method: 'tcp-connect', latency_ms: null, detail: '127.0.0.1:5101 응답 없음 · 1s 초과' } };
  assert.equal(linkState(l01, { mode: 'standalone', health: { probes: down } }).state, 'down');
  const unverified = { L01: { state: 'unverified', method: 'udp-resolve', latency_ms: 1.2, detail: 'fabric:5102 주소 해석 성공' } };
  assert.equal(linkState(l01, { mode: 'standalone', health: { probes: unverified } }).state, 'unknown');
  assert.deepEqual(linkState(l01, { mode: 'standalone', health: { probes: {} } }), { state: 'unknown', reason: '연결 확인 중' });
  assert.equal(probeReason({ state: 'up', method: 'in-process', latency_ms: 0.2, detail: '프레임워크 응답 · 런타임 실행' }), '내장 · 프레임워크 응답 · 런타임 실행', 'in-process latency is not worth showing');
  assert.equal(linkState(l09, { mode: 'standalone', health: { probes: {}, socket: 'open' } }).state, 'active', 'the console link never waits for a probe');
  assert.equal(linkState(l13, { mode: 'em', health: { probes: { L04: { state: 'down', method: 'tcp-connect', detail: 'x' } } }, overrides: { L04: { host: '10.0.0.7' } } }).state, 'down', 'EM bus follows the probed gateway');
  assert.equal(summarize(evaluateLinks({ mode: 'standalone', health: { probes: {}, socket: 'open' } })).unknown, 9);
});

test('probe targets carry the effective endpoint of every link the backend can check', () => {
  const targets = probeTargets(evaluateLinks({ mode: 'em', overrides: { L01: { host: '10.1.1.4', port: 9000, timeout: 9 }, L03: { enabled: false } } }));
  assert.deepEqual(targets.map(target => target.id), ['L01', 'L02', 'L04', 'L05', 'L06', 'L07', 'L08', 'L10', 'L16'], 'standby, disabled, console and EM-bus links are skipped');
  assert.deepEqual(targets[0], { id: 'L01', transport: 'TCP', host: '10.1.1.4', port: 9000, timeout_s: 5, endpoints: ['data-dist', 'framework'] });
  assert.deepEqual(targets.find(target => target.id === 'L05'), { id: 'L05', transport: 'IPC', host: 'in-process', port: 0, timeout_s: 3, endpoints: ['framework', 'dt-comm'] });
  assert.equal(probeTargets(evaluateLinks({ mode: 'integration' })).length, 12);
});

test('edges leave the facing sides, fan out without sharing anchors and stay on the canvas', () => {
  const framework = MODULES.find(module => module.id === 'framework');
  const dataDist = MODULES.find(module => module.id === 'data-dist');
  const engine = MODULES.find(module => module.id === 'engine');
  assert.equal(sideFor(framework, dataDist), 'right');
  assert.equal(sideFor(framework, engine), 'bottom');
  const { d, mid } = bezierPath({ x: 0, y: 0 }, 'right', { x: 100, y: 40 }, 'left');
  assert.match(d, /^M 0 0 C 45 0 55 40 100 40$/);
  assert.deepEqual(mid, { x: 50, y: 20 });
  const edges = layoutEdges();
  assert.equal(edges.length, LINKS.length);
  const anchors = new Map();
  for (const edge of edges) {
    for (const point of [edge.from, edge.to]) {
      assert.ok(point.x >= 0 && point.x <= VIEWBOX.width && point.y >= 0 && point.y <= VIEWBOX.height, `${edge.id} stays inside the view box`);
      const key = `${point.x},${point.y}`;
      assert.ok(!anchors.has(key), `${edge.id} shares an anchor with ${anchors.get(key)}`);
      anchors.set(key, edge.id);
    }
    assert.match(edge.d, /^M [\d.]+ [\d.]+ C /);
  }
  const hubRight = edges.filter(edge => edge.id === 'L10' || ['L01', 'L02', 'L03'].includes(edge.id)).map(edge => edge.id === 'L10' ? edge.from : edge.to);
  assert.ok(hubRight.every(point => point.x === framework.x + framework.w), 'ops and verification links leave the hub on its right edge');
  assert.deepEqual([...new Set(hubRight.map(point => point.y))].length, 4, 'four distinct anchors on the hub right edge');
  assert.throws(() => layoutEdges([{ id: 'X', from: 'framework', to: 'ghost' }]), /unknown module/);
});

const overlaps = (a, b, gap = 0) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap
  && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

test('every link label has clearance from cards and other labels, including OFF on internal links', () => {
  const labels = layoutEdges().map(edge => {
    // Reserve the longest displayed label in every state, not just the current mode.
    const w = linkById(edge.id).icd ? 58 : 36;
    return { id: edge.id, x: edge.mid.x - w / 2, y: edge.mid.y - 10, w, h: 20 };
  });
  for (const label of labels) {
    for (const module of MODULES) assert.ok(!overlaps(label, module, 6), `${label.id} label is covered by ${module.id}`);
    for (const other of labels) if (label !== other) assert.ok(!overlaps(label, other, 6), `${label.id} label collides with ${other.id}`);
  }
});

test('connection curves do not run through unrelated module cards', () => {
  for (const edge of layoutEdges()) {
    const link = linkById(edge.id);
    const [px, py, ax, ay, bx, by, qx, qy] = edge.d.match(/-?\d+(?:\.\d+)?/g).map(Number);
    for (let step = 1; step < 100; step++) {
      const t = step / 100, s = 1 - t;
      const point = { x: s**3*px + 3*s*s*t*ax + 3*s*t*t*bx + t**3*qx,
        y: s**3*py + 3*s*s*t*ay + 3*s*t*t*by + t**3*qy, w: 0, h: 0 };
      for (const module of MODULES.filter(item => ![link.from, link.to].includes(item.id))) {
        assert.ok(!overlaps(point, module, 4), `${edge.id} crosses ${module.id}`);
      }
    }
  }
});
