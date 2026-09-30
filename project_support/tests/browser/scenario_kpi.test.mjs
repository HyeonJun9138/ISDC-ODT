import test from 'node:test';
import assert from 'node:assert/strict';
import { takeSample, metricValue, evaluateChecks, verdict, comparisonRows, resultRecord, emptyEvents, formatMetric } from '../../../digital_twin/verification/browser/scenario_kpi.js';

const report = { sequence: 12, summary: { usable_links: 118, links: 160, satellites_with_ground_path: 30 },
  links: [{ id: 'A|B', usable: false, reason: 'fault' }, { id: 'B|C', usable: true }],
  nodes: [{ id: 'A', kind: 'satellite', custody: 'storing', stored_mb: 600, capacity_mb: 2_000_000 }] };
const route = { status: 'available', hops: 4, total_delay_ms: 47.2, reliability: 0.91, path: ['A', 'X', 'Y', 'Z', 'C'] };
const mission = { status: 'committed', plan: { feasible: true, version: 2, summary: { margin_s: 5400, hops: 4, latency_ms: 32, finish_at: '2026-09-08T00:10:00Z', path: ['A', 'X', 'C'] } } };
const dashboard = { overview: { stability: { score: 96, grade: 'stable' }, metrics: { objects: 12, replicas: 30, verified_replicas: 27 }, objects_by_status: { degraded: 1, critical: 0 } } };
const security = { module: { reachable: true }, overview: { verdict: { authentication: 'nominal' }, observation: { auth_percent: 99.8 } } };

function sample(at, overrides = {}) {
  return takeSample({ at_s: at, route, report, sourceId: 'A', faultLink: 'A|B', mission, missionPhase: { status: 'committed' }, dashboard, security, names: { A: 'N1', C: 'N4' }, ...overrides });
}

test('a sample copies what each module reported and resolves names', () => {
  const item = sample(42);
  assert.equal(item.route.path_label, 'N1 → X → Y → Z → N4');
  assert.equal(item.fabric.fault_link_usable, false);
  assert.equal(item.fabric.fault_link_reason, 'fault');
  assert.equal(item.fabric.source_custody, 'storing');
  assert.equal(item.data.stability, 96);
  assert.ok(Math.abs(item.data.verified_ratio - 0.9) < 1e-9);
  assert.equal(item.security.authentication, 'nominal');
  assert.equal(item.mission.hops, 4);
  const empty = takeSample({ at_s: 1 });
  assert.equal(empty.route, null);
  assert.equal(empty.fabric, null);
  assert.equal(empty.security, null);
});

test('metrics derive durations from events and extremes from the series', () => {
  const events = { ...emptyEvents(), fault_at_s: 100, detour_available_at_s: 104, fault_end_s: 400, primary_restored_at_s: 402 };
  const series = [sample(50, { dashboard: { overview: { stability: { score: 99 }, metrics: {}, objects_by_status: {} } } }), sample(150), sample(450, { report: { ...report, nodes: [{ id: 'A', kind: 'satellite', custody: 'passing', stored_mb: 1_400_000, capacity_mb: 2_000_000 }] } })];
  const context = { series, events, phases: { baseline: series[0] } };
  assert.equal(metricValue('route.reconverge_s', context), 4);
  assert.equal(metricValue('route.primary_restored', context), true);
  assert.equal(metricValue('fabric.source_stored_ratio_max', context), 0.7);
  assert.equal(metricValue('data.stability_min', context), 96);
  assert.equal(metricValue('security.nominal_throughout', context), true);
  assert.equal(metricValue('fabric.fault_link_unusable', context), true);
  assert.equal(metricValue('route.primary_restored', { series, events: { ...events, fault_end_s: null } }), null, 'undecided until the fault clears');
  assert.equal(metricValue('made.up', context), null);
});

test('checks and the verdict evaluate rules with pending values', () => {
  const series = [sample(10)];
  const context = { series, events: emptyEvents(), phases: {} };
  const checks = evaluateChecks([{ metric: 'route.status', equals: 'available', label: '경로' }, { metric: 'route.reconverge_s', max: 90, label: '재수렴' }, { metric: 'data.stability', min: 97, label: '안정성' }], context);
  assert.deepEqual(checks.map(check => [check.ok, check.pending]), [[true, false], [false, true], [false, false]]);
  assert.equal(checks[0].display, '경로 있음');
  assert.equal(checks[2].rule, '≥ 97');
  const result = verdict([{ id: 'reach', label: '도달', rules: [{ metric: 'mission.relay.margin_s', min: 0 }] }, { id: 'state', label: '상태', rules: [{ metric: 'route.reconverge_s', max: 90 }] }], context);
  assert.equal(result.passed, 1);
  assert.equal(result.ok, false);
  assert.equal(result.pending, true);
  const rows = comparisonRows({ baseline: sample(1), fault: sample(2, { route: { ...route, hops: 2, total_delay_ms: 31.6 } }) });
  const hops = rows.find(row => row.metric === 'route.hops');
  assert.deepEqual(hops.cells.map(cell => cell.display), ['4', '2', '—', '—']);
  assert.equal(formatMetric('route.total_delay_ms', 31.6), '31.6 ms');
  assert.equal(formatMetric('security.authentication', 'warning'), '기준 미달');
  const record = resultRecord({ scenario: { id: 'SDC_POC_01', version: '1.0' }, runId: 'RUN-1', phases: {}, series, events: emptyEvents(), verdictResult: result, log: [{ t: 1 }] });
  assert.equal(record.contract, 'ICD-06 VF-03');
  assert.equal(record.samples, 1);
  assert.equal(record.is_simulation, true);
});
