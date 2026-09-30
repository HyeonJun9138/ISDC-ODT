import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStatic } from './load_static.mjs';

const { createScenarioRunner, STORAGE_KEY } = await loadStatic('user_application/web/scripts/scenario/runner.js');
const { createConstellationStore } = await loadStatic('user_application/web/scripts/nodes/constellation.js');
const { createGroundSegmentStore } = await loadStatic('user_application/web/scripts/communication/ground_segment.js');
const { createMissionStore } = await loadStatic('user_application/web/scripts/missions/mission_store.js');

const T0 = Date.UTC(2026, 8, 8, 0, 0, 0);
const iso = seconds => new Date(T0 + seconds * 1000).toISOString();

const definition = {
  id: 'SDC_POC_01', name: 'PoC 1차', version: '1.0', kind: 'poc',
  constellation: {
    prefix: 'SDC', preset: 'walker_delta', planes: 4, per_plane: 10, altitude_km: 550, inclination: 53, phasing: 1, raan_start: 0, raan_spread: 60, anomaly_start: 0, bus: 'comms_small', link_policy: 'grid',
    equipment: { all: ['dtn_store'], roles: { source: ['eo_camera'] } },
    roles: { source: { label: 'N1', plane: 0, index: 2 }, relay: { label: 'N2', plane: 0, index: 3 }, alternate: { label: 'N3', plane: 1, index: 2 }, gateway: { label: 'N4', plane: 0, index: 4 } },
  },
  stations: ['daejeon', 'jeju'],
  missions: [
    { key: 'relay', kind: 'relay', name: 'N1→N4 데이터 중계', priority: 2, deadline_hours: 2, commit: true, params: { source: 'satellite:@source', destination: 'satellite:@gateway', volume_mb: 120000, max_latency_ms: 40 } },
    { key: 'observe', kind: 'observe', name: '독도 관측 인도', priority: 3, deadline_hours: 24, commit: false, params: { target: 'dokdo', max_off_nadir_deg: 60, product_mb: 800 } },
  ],
  route: { source: '@source', target: '@gateway', objective: 'latency' },
  service: { class: 'imagery', destination: '@gateway' },
  playback: { speed: 2, speeds: [1, 2, 5], sample_interval_s: 1 },
  steps: [
    { id: 'nominal', order: 1, title: '정상 운용', tab: 'mission', tabs: ['mission'], speed: 2, at: { offset_s: 0 }, narrative: 'N1({source}) 경로 {relay.path}', flows: [], actions: [{ kind: 'route' }, { kind: 'sample', phase: 'baseline', delay_s: 5 }], checks: [{ metric: 'route.status', equals: 'available', label: '경로' }] },
    { id: 'fault', order: 2, title: 'Fault 주입', tab: 'status', tabs: ['status'], speed: 1, at: { anchor: 'task', mission: 'relay', task_kind: 'crosslink', index: 0, edge: 'start', offset_s: 20, fallback_s: 40 }, narrative: '{fault.link}', flows: [], actions: [{ kind: 'inject_fault', target: { from_plan: 'relay', task_kind: 'crosslink', index: 0 }, fault: 'link_loss', severity: 'high', duration_s: 300 }, { kind: 'sample', phase: 'fault', delay_s: 3 }], checks: [] },
    { id: 'sync', order: 3, title: '상태 전달', tab: 'communication', tabs: ['communication'], speed: 1, at: { after: 'fault', offset_s: 4 }, narrative: '', flows: [], actions: [{ kind: 'verify_link_unusable' }], checks: [{ metric: 'fabric.fault_link_unusable', equals: true, label: '판정' }] },
    { id: 'reroute', order: 4, title: '우회·재전송', tab: 'mission', tabs: ['mission'], speed: 5, at: { after: 'fault', offset_s: 10 }, narrative: '{relay.replan_path} {route.path}', flows: [], actions: [{ kind: 'replan_mission', mission: 'relay' }, { kind: 'route' }, { kind: 'sample', phase: 'reroute', delay_s: 2 }], checks: [] },
    { id: 'verdict', order: 5, title: '복구 판정', tab: 'mission', tabs: ['mission'], speed: 5, at: { max: [{ anchor: 'mission_end', mission: 'relay' }, { anchor: 'fault_end', step: 'fault' }], offset_s: 5, fallback_s: 600 }, narrative: '', flows: [], actions: [{ kind: 'dm_request' }, { kind: 'sample', phase: 'recovery' }, { kind: 'verdict' }], checks: [] },
  ],
  criteria: [
    { id: 'reach', label: '도달', rules: [{ metric: 'mission.relay.status', equals: 'completed', label: '완료' }, { metric: 'mission.relay.margin_s', min: 0, label: '여유' }] },
    { id: 'state', label: '상태', rules: [{ metric: 'route.reconverge_s', max: 90, label: '재수렴' }, { metric: 'route.primary_restored', equals: true, label: '복귀' }, { metric: 'security.nominal_throughout', equals: true, label: '보안' }] },
  ],
};

function memoryStorage() {
  const data = new Map();
  return { getItem: key => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, value), data };
}

function harness({ storage = memoryStorage(), runId = 'RUN-A' } = {}) {
  const constellation = createConstellationStore({ storage: memoryStorage(), now: () => T0 });
  constellation.load();
  const groundSegment = createGroundSegmentStore({ storage: memoryStorage() });
  groundSegment.load();
  const missionStore = createMissionStore({ storage: memoryStorage(), now: () => T0 });
  missionStore.load();
  const runtime = { run_id: runId, started_at: new Date(T0).toISOString(), elapsed_seconds: 0, running: false, speed: 1, active_faults: [] };
  const calls = [];
  const state = { faulted: false, cleared: false, plans: 0 };
  const api = {
    scenarios: async () => ({ scenarios: [{ id: definition.id, kind: 'poc', name: definition.name }, { id: 'LEO_STANDARD', kind: 'sim' }] }),
    scenario: async id => { assert.equal(id, definition.id); return JSON.parse(JSON.stringify(definition)); },
    runtimeControl: async action => { calls.push(['control', action]); runtime.running = action === 'start'; return { ...runtime }; },
    selectScenario: async id => { calls.push(['select', id]); runtime.run_id = runId; runtime.elapsed_seconds = 0; return { ...runtime }; },
    runtimeSpeed: async speed => { calls.push(['speed', speed]); runtime.speed = speed; return { ...runtime }; },
    injectFault: async payload => { calls.push(['fault', payload]); state.faulted = true; const fault = { id: 'FLT-1', ...payload, active: true, created_at: runtime.elapsed_seconds, expires_at: runtime.elapsed_seconds + payload.duration_seconds }; runtime.active_faults = [fault]; return fault; },
    scenarioAdvance: async seconds => { calls.push(['advance', seconds]); runtime.elapsed_seconds += seconds; return { ...runtime }; },
    dataManagementDashboard: async () => ({ deployment: { scope_id: 'RUN-A:deployment:x' }, module: { reachable: true }, overview: { stability: { score: 97, grade: 'stable' }, metrics: { objects: 8, replicas: 16, verified_replicas: 16 }, objects_by_status: {} } }),
    securityDashboard: async () => ({ module: { reachable: true }, overview: { verdict: { authentication: 'nominal' }, observation: { auth_percent: 99.8 } } }),
    dataManagementRequest: async body => { calls.push(['dm_request', body]); return { id: 'REQ-1', status: 'served', served_from: body.destination, latency_ms: 93, destination: body.destination }; },
  };
  const dataDeployment = { deploy: async () => { const nodes = constellation.deploy(constellation.drafts); return { nodes, revision: 1 }; } };
  const planner = {
    invalidateWindows() {},
    async plan(mission) {
      state.plans += 1;
      const sats = constellation.deployed.map(node => node.id);
      const source = String(mission.params.source || '').split(':')[1];
      if (mission.kind !== 'relay') return { request: { horizon: {} }, answer: { feasible: true, tasks: [], summary: { path: [], finish_at: iso(3600), margin_s: 1000 }, checks: [] } };
      const primary = [source, sats[3], sats[4]];
      const detour = [source, sats[12], sats[13], sats[14], sats[4]];
      const path = state.faulted ? detour : primary;
      const start = runtime.elapsed_seconds;
      const tasks = path.slice(0, -1).map((id, index) => ({ id: `${mission.id}-T${index + 1}`, kind: 'crosslink', satellite: id, counterpart: path[index + 1], start: iso(start + index * 100), end: iso(start + index * 100 + 96) }));
      const finish = iso(start + (path.length - 1) * 100 - 4);
      return { request: { horizon: { faulted_links: state.faulted ? [`${source}|${sats[3]}`] : [] }, exclude: [] }, answer: { feasible: true, tasks, summary: { path, hops: path.length - 1, finish_at: finish, margin_s: 7200 - (path.length - 1) * 100, latency_ms: (path.length - 1) * 8 }, checks: [] } };
    },
    async commit(mission, decision) { calls.push(['commit', mission.id, decision]); return { held_tasks: mission.plan?.tasks?.length || 0 }; },
    affectedTasks() { return { satellites: [], links: [], tasks: [] }; },
  };
  const twin = {
    report: null, fabricLinks: new Map(), fabricNodes: new Map(), fabricState: { reachable: null }, last: {}, ticks: 0,
    resetHistories() {}, reachable() { return true; },
    tick() { this.ticks += 1; return this.last; },
    async exchange() { const faultLink = runtime.active_faults[0]?.target; this.report = { sequence: this.ticks, summary: { usable_links: state.faulted ? 158 : 160, links: 160 }, links: faultLink ? [{ id: faultLink, usable: false, reason: 'fault' }] : [], nodes: [{ id: constellation.deployed[2]?.id, custody: 'passing', stored_mb: 0, capacity_mb: 2_000_000 }] }; this.fabricState = { reachable: true, sequence: this.ticks }; return this.report; },
    async route(source, target) { const sats = constellation.deployed.map(node => node.id); const path = state.faulted && !state.cleared ? [source, sats[12], sats[13], sats[14], target] : [source, sats[3], target]; return { status: 'available', path, hops: path.length - 1, total_delay_ms: (path.length - 1) * 15.8, reliability: 0.95, hop_list: path.slice(0, -1).map((id, index) => ({ link_id: [id, path[index + 1]].sort().join('|') })) }; },
  };
  const clock = { elapsed: () => runtime.elapsed_seconds, startMs: () => T0, now: () => T0 + runtime.elapsed_seconds * 1000, get running() { return runtime.running; }, get speed() { return runtime.speed; }, engaged: false, engage() { this.engaged = true; }, disengage() { this.engaged = false; } };
  const events = [];
  const tabs = [];
  const runner = createScenarioRunner({
    api, constellation, groundSegment, missionStore, dataDeployment, planner, networkTwin: twin, clock, storage, emit: (name, payload) => events.push([name, payload]),
    switchTab: tab => tabs.push(tab), runtime: () => runtime, now: () => T0 + runtime.elapsed_seconds * 1000, pressSdcFilter: () => calls.push(['sdc']), wait: async () => {},
  });
  runner.setHostTab(() => 'orbit');
  const advance = async seconds => { runtime.elapsed_seconds += seconds; await runner.tick(); };
  return { runner, constellation, groundSegment, missionStore, runtime, calls, state, events, tabs, twin, advance, storage, clock };
}

test('setup assembles the console through the modules and records the ICD exchanges', async t => {
  const h = harness();
  const listing = await h.runner.list();
  assert.deepEqual(listing.map(item => item.id), ['SDC_POC_01']);
  await h.runner.select('SDC_POC_01');
  assert.equal(h.runner.state.phase, 'selected');
  await h.runner.setup();
  assert.equal(h.runner.state.phase, 'ready');
  assert.equal(h.constellation.deployed.length, 40);
  assert.equal(h.groundSegment.enabled.map(station => station.id).join(','), 'GS-DAEJEON,GS-JEJU');
  assert.equal(h.missionStore.missions.length, 2);
  const relay = h.missionStore.find(h.runner.state.missions.relay);
  assert.equal(relay.status, 'committed');
  assert.equal(relay.plan.tasks.length, 2);
  const observe = h.missionStore.find(h.runner.state.missions.observe);
  assert.equal(observe.status, 'planned', 'missions without commit stay planned');
  assert.ok(h.calls.some(([kind, action]) => kind === 'control' && action === 'pause'));
  assert.ok(h.calls.some(([kind]) => kind === 'select'));
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'commit').map(([, id, decision]) => decision), ['commit']);
  assert.ok(h.calls.some(([kind, speed]) => kind === 'speed' && speed === 2));
  assert.equal(h.clock.engaged, true);
  const view = h.runner.view();
  assert.equal(view.roles.source.name, 'SDC-A3');
  assert.equal(view.roles.gateway.name, 'SDC-A5');
  assert.equal(view.setup.done.length, 7);
  const icds = view.log.map(entry => entry.icd);
  for (const icd of ['ICD-07', 'ICD-01', 'ICD-03', 'ICD-02']) assert.ok(icds.includes(icd), icd);
  assert.ok(h.tabs.includes('communication') && h.tabs.at(-1) === 'orbit', 'the views are warmed and the console returns to the dashboard');
  assert.ok(h.calls.some(([kind]) => kind === 'sdc'));
  const saved = JSON.parse(h.storage.data.get(STORAGE_KEY));
  assert.equal(saved.phase, 'ready');
  assert.equal(saved.runId, 'RUN-A');
});

test('playback fires the five steps from the plan anchors and ends with a verdict', async () => {
  const h = harness();
  await h.runner.select('SDC_POC_01');
  await h.runner.setup();
  await h.runner.play();
  assert.equal(h.runner.state.phase, 'playing');
  assert.equal(h.runtime.running, true);
  await h.runner.tick();
  assert.equal(h.runner.state.currentStep, 'nominal');
  assert.ok(h.events.some(([name, payload]) => name === 'scenario:route' && payload.source === h.runner.state.roles.source));
  assert.equal(h.tabs.at(-1), 'mission');
  const step = h.events.find(([name]) => name === 'scenario:step')[1];
  assert.match(h.runner.view().steps[0].narrativeText, /SDC-A3/);
  assert.match(h.runner.view().steps[0].narrativeText, /SDC-A3 → SDC-A4 → SDC-A5/);
  await h.advance(6);
  assert.ok(h.runner.state.phases.baseline, 'the baseline sample is taken after its delay');
  assert.equal(h.runner.state.phases.baseline.route.hops, 2);
  assert.deepEqual(h.runner.state.events.primary_path, [h.runner.state.roles.source, h.constellation.deployed[3].id, h.runner.state.roles.gateway]);
  await h.advance(10);
  assert.equal(h.runner.state.currentStep, 'nominal', 'the fault waits for task start + 20 s');
  await h.advance(5);
  assert.equal(h.runner.state.currentStep, 'fault');
  const fault = h.calls.find(([kind]) => kind === 'fault')[1];
  assert.equal(fault.target, `${h.runner.state.roles.source}|${h.constellation.deployed[3].id}`, 'the fault hits the first crosslink of the plan');
  assert.equal(fault.severity, 'high');
  assert.equal(h.runner.state.events.fault_at_s, 21);
  assert.ok(h.calls.some(([kind, speed]) => kind === 'speed' && speed === 1), 'the step slows the playback');
  await h.advance(2);
  assert.equal(h.runner.state.events.detour_available_at_s, 23, 'the route sample notices the detour');
  await h.advance(3);
  assert.equal(h.runner.state.currentStep, 'sync');
  assert.ok(h.runner.state.phases.fault);
  assert.equal(h.runner.state.phases.fault.fabric.fault_link_usable, false);
  const syncChecks = h.runner.view().steps[2].checkResults;
  assert.equal(syncChecks[0].ok, true);
  await h.advance(6);
  assert.equal(h.runner.state.currentStep, 'reroute');
  assert.equal(h.state.plans, 3, 'the relay mission was re-planned');
  const relay = h.missionStore.find(h.runner.state.missions.relay);
  assert.equal(relay.plan.summary.hops, 4);
  assert.equal(relay.status, 'committed');
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'commit').map(([, , decision]) => decision), ['commit', 'commit']);
  await h.advance(3);
  assert.equal(h.runner.state.phases.reroute.mission.hops, 4);
  // The verdict waits for both the mission end (T+32 + 396 s) and the fault expiry (T+321 s).
  await h.advance(250);
  assert.equal(h.runner.state.currentStep, 'reroute');
  h.runtime.active_faults = []; h.state.cleared = true;
  await h.advance(50);
  assert.equal(h.runner.state.events.fault_end_s, 321);
  assert.ok(h.runner.state.events.primary_restored_at_s >= 321);
  await h.advance(120);
  assert.equal(h.runner.state.phase, 'finished');
  assert.equal(h.runner.state.currentStep, 'verdict');
  assert.ok(h.calls.some(([kind]) => kind === 'dm_request'));
  const verdict = h.runner.state.verdict;
  assert.equal(verdict.total, 2);
  assert.equal(verdict.groups[0].ok, true, 'the relay mission completed before its deadline');
  assert.equal(verdict.groups[1].ok, true, JSON.stringify(verdict.groups[1].rules.map(rule => [rule.label, rule.ok, rule.value])));
  assert.equal(h.runtime.running, false, 'the runtime pauses when the verdict is reached');
  const record = h.runner.record();
  assert.equal(record.contract, 'ICD-06 VF-03');
  assert.equal(record.verdict.passed, 2);
  assert.ok(record.icd_log.some(entry => entry.message.startsWith('VF-03')));
  assert.equal(record.comparison.find(row => row.metric === 'route.hops').cells.map(cell => cell.display).join(','), '2,4,4,2');
});

test('the saved state resumes for the same run and is marked stale for another', async () => {
  const storage = memoryStorage();
  const first = harness({ storage });
  await first.runner.select('SDC_POC_01');
  await first.runner.setup();
  await first.runner.play();
  await first.runner.tick();
  first.runner.suspend();
  const same = harness({ storage, runId: 'RUN-A' });
  assert.equal(await same.runner.restore(), true);
  assert.equal(same.runner.state.phase, 'playing');
  assert.equal(same.runner.state.currentStep, 'nominal');
  assert.equal(same.clock.engaged, true);
  same.runner.stop({ keepSelection: true });
  const other = harness({ storage, runId: 'RUN-B' });
  assert.equal(await other.runner.restore(), true);
  assert.equal(other.runner.state.phase, 'stale');
  assert.equal(other.clock.engaged, false);
  other.runner.stop();
  assert.equal(other.runner.state.phase, 'idle');
});

test('skipping advances the runtime clock to the next step and unresolvable anchors fall back', async () => {
  const h = harness();
  await h.runner.select('SDC_POC_01');
  await h.runner.setup();
  await h.runner.play();
  await h.runner.tick();
  const next = await h.runner.skipToNextStep();
  assert.equal(next, 'fault');
  assert.ok(h.calls.some(([kind, seconds]) => kind === 'advance' && seconds >= 19 && seconds <= 21));
  assert.equal(h.runner.state.currentStep, 'fault');
  const view = h.runner.view();
  assert.equal(view.steps[4].due, 326, 'the verdict waits for the later of the mission end and the fault expiry');
  assert.equal(view.steps[2].due, 25);
  h.runner.stop();
});

test('ticks requested while one runs are coalesced into a single follow-up tick', async () => {
  const h = harness();
  await h.runner.select('SDC_POC_01');
  await h.runner.setup();
  await h.runner.play();
  let ticks = 0;
  h.runner.subscribe(event => { if (event === 'tick') ticks += 1; });
  const before = ticks;
  const first = h.runner.tick();
  const second = h.runner.tick();
  const third = h.runner.tick();
  assert.equal(second, third, 'a second and third request while a tick runs share one queued tick');
  await Promise.all([first, second, third]);
  assert.equal(ticks - before, 2, 'one running tick plus one coalesced follow-up');
  h.runner.stop();
});
