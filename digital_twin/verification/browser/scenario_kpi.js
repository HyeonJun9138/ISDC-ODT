// KPI samples of a PoC scenario and the recovery verdict (the embedded implementation of the
// ICD-06 verification support: VF-02 KPI samples and VF-03 result record). Pure functions of the
// module reports the player collected; no DOM, transport or storage. Samples are copies of what
// the data fabric, constellation operations, data management and security modules reported, never
// values computed here in their place.

export const PHASES = Object.freeze([
  ['baseline', '정상'], ['fault', '장애'], ['reroute', '우회'], ['recovery', '복구'],
]);

export const METRIC_LABELS = Object.freeze({
  'route.status': '경로 상태', 'route.hops': '경로 홉 수', 'route.total_delay_ms': '편도 지연', 'route.reliability': '경로 신뢰도',
  'route.reconverge_s': '대체 경로 재수렴', 'route.primary_restored': '주 경로 복귀',
  'mission.relay.status': '중계 임무 상태', 'mission.relay.margin_s': '기한 여유', 'mission.relay.hops': '임무 경로 홉', 'mission.relay.latency_ms': '임무 종단 지연', 'mission.relay.feasible': '실행 가능',
  'fabric.usable_links': '사용 가능 링크', 'fabric.fault_link_unusable': '장애 링크 판정', 'fabric.source_custody': 'N1 저장 전달', 'fabric.source_stored_mb': 'N1 보관량', 'fabric.source_stored_ratio_max': 'N1 최대 보관 비율',
  'data.stability': '데이터 안정성', 'data.stability_min': '데이터 안정성 최저', 'data.objects': '데이터 객체', 'data.degraded': '복제 부족 객체', 'data.service_status': '서비스 요청', 'data.service_latency_ms': '서비스 지연',
  'security.authentication': '보안 판정', 'security.auth_percent': '인증률', 'security.nominal_throughout': '보안 판정 유지',
});

// null and undefined are missing values, never zero.
const number = value => (value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null);

function pathNames(path, names) {
  return (path || []).map(id => names?.[id] || id).join(' → ');
}

// One sample: what each module reported at this instant. Inputs are the last answers the player
// holds; a missing module leaves its block null rather than inventing a value.
export function takeSample({ at_s = 0, route = null, report = null, sourceId = null, faultLink = null, mission = null, missionPhase = null,
  dashboard = null, security = null, service = null, names = {} } = {}) {
  const fabricNode = report?.nodes?.find(node => node.id === sourceId) || null;
  const faultVerdict = faultLink ? report?.links?.find(link => link.id === faultLink) || null : null;
  const summary = mission?.plan?.summary || null;
  const overview = dashboard?.overview || null;
  const observation = security?.overview?.observation || null;
  return {
    at_s: number(at_s) ?? 0,
    route: route ? { status: route.status, hops: number(route.hops), total_delay_ms: number(route.total_delay_ms), reliability: number(route.reliability), path: [...(route.path || [])], path_label: pathNames(route.path, names) } : null,
    mission: mission ? {
      status: missionPhase?.status || mission.status, feasible: mission.plan ? mission.plan.feasible !== false : null, margin_s: number(summary?.margin_s),
      hops: number(summary?.hops), latency_ms: number(summary?.latency_ms), finish_at: summary?.finish_at || null, version: number(mission.plan?.version), path: [...(summary?.path || [])], path_label: pathNames(summary?.path, names),
    } : null,
    fabric: report ? {
      usable_links: number(report.summary?.usable_links), links: number(report.summary?.links), satellites_with_ground_path: number(report.summary?.satellites_with_ground_path),
      fault_link: faultLink, fault_link_usable: faultVerdict ? faultVerdict.usable === true : null, fault_link_reason: faultVerdict?.reason ?? null,
      source_custody: fabricNode?.custody ?? null, source_stored_mb: number(fabricNode?.stored_mb), source_capacity_mb: number(fabricNode?.capacity_mb), sequence: number(report.sequence),
    } : null,
    data: dashboard ? {
      stability: number(overview?.stability?.score), grade: overview?.stability?.grade ?? null, objects: number(overview?.metrics?.objects), degraded: number(overview?.objects_by_status?.degraded) ?? 0,
      critical: number(overview?.objects_by_status?.critical) ?? 0, verified_ratio: overview?.metrics?.replicas ? number(overview.metrics.verified_replicas) / number(overview.metrics.replicas) : null,
      service_status: service?.status ?? null, service_latency_ms: number(service?.latency_ms), service_from: service?.served_from ?? null,
    } : null,
    security: security ? { authentication: security.overview?.verdict?.authentication ?? null, auth_percent: number(observation?.auth_percent), reachable: security.module?.reachable === true } : null,
  };
}

// Timeline events the player records while it runs; the metrics below derive durations from them.
export function emptyEvents() {
  return { fault_at_s: null, fault_end_s: null, fault_link: null, reroute_at_s: null, detour_available_at_s: null, primary_restored_at_s: null, primary_path: null };
}

// Metric lookup over the collected context: { phases, series, events, latest }.
export function metricValue(name, context = {}) {
  const latest = context.latest || context.series?.[context.series.length - 1] || null;
  const series = context.series || [];
  const events = context.events || emptyEvents();
  const baseline = context.phases?.baseline || null;
  switch (name) {
    case 'route.status': return latest?.route?.status ?? null;
    case 'route.hops': return latest?.route?.hops ?? null;
    case 'route.total_delay_ms': return latest?.route?.total_delay_ms ?? null;
    case 'route.reliability': return latest?.route?.reliability ?? null;
    case 'route.reconverge_s': return events.fault_at_s != null && events.detour_available_at_s != null ? Math.max(0, events.detour_available_at_s - events.fault_at_s) : null;
    case 'route.primary_restored': return events.fault_end_s == null ? null : events.primary_restored_at_s != null;
    case 'mission.relay.status': return latest?.mission?.status ?? null;
    case 'mission.relay.margin_s': return latest?.mission?.margin_s ?? null;
    case 'mission.relay.hops': return latest?.mission?.hops ?? null;
    case 'mission.relay.latency_ms': return latest?.mission?.latency_ms ?? null;
    case 'mission.relay.feasible': return latest?.mission?.feasible ?? null;
    case 'fabric.usable_links': return latest?.fabric?.usable_links ?? null;
    case 'fabric.fault_link_unusable': return latest?.fabric?.fault_link_usable == null ? null : latest.fabric.fault_link_usable === false;
    case 'fabric.source_custody': return latest?.fabric?.source_custody ?? null;
    case 'fabric.source_stored_mb': return latest?.fabric?.source_stored_mb ?? null;
    case 'fabric.source_stored_ratio_max': {
      const ratios = series.map(sample => (sample.fabric?.source_capacity_mb > 0 ? sample.fabric.source_stored_mb / sample.fabric.source_capacity_mb : null)).filter(value => value != null);
      return ratios.length ? Math.max(...ratios) : null;
    }
    case 'data.stability': return latest?.data?.stability ?? null;
    case 'data.stability_min': {
      const scores = series.filter(sample => !baseline || sample.at_s >= baseline.at_s).map(sample => sample.data?.stability).filter(value => value != null);
      return scores.length ? Math.min(...scores) : null;
    }
    case 'data.objects': return latest?.data?.objects ?? null;
    case 'data.degraded': return latest?.data?.degraded ?? null;
    case 'data.service_status': return latest?.data?.service_status ?? null;
    case 'data.service_latency_ms': return latest?.data?.service_latency_ms ?? null;
    case 'security.authentication': return latest?.security?.authentication ?? null;
    case 'security.auth_percent': return latest?.security?.auth_percent ?? null;
    case 'security.nominal_throughout': {
      const verdicts = series.map(sample => sample.security?.authentication).filter(value => value != null);
      return verdicts.length ? verdicts.every(value => value === 'nominal') : null;
    }
    default: return null;
  }
}

export function evaluateRule(rule, value) {
  if (value == null) return { ok: false, pending: true };
  if ('equals' in rule) return { ok: value === rule.equals, pending: false };
  const numeric = number(value);
  if (numeric === null) return { ok: false, pending: false };
  if ('min' in rule && numeric < Number(rule.min)) return { ok: false, pending: false };
  if ('max' in rule && numeric > Number(rule.max)) return { ok: false, pending: false };
  return { ok: true, pending: false };
}

export function formatMetric(name, value) {
  if (value == null) return '—';
  if (typeof value === 'boolean') return value ? '예' : '아니오';
  switch (name) {
    case 'route.status': return { available: '경로 있음', unavailable: '경로 없음', no_network: '네트워크 없음', error: '오류' }[value] || String(value);
    case 'route.total_delay_ms': case 'mission.relay.latency_ms': case 'data.service_latency_ms': return `${Number(value).toFixed(1)} ms`;
    case 'route.reliability': return `${(Number(value) * 100).toFixed(1)} %`;
    case 'route.reconverge_s': case 'mission.relay.margin_s': return `${Number(value).toFixed(0)} s`;
    case 'fabric.source_stored_mb': return `${Number(value).toFixed(0)} MB`;
    case 'fabric.source_stored_ratio_max': return `${(Number(value) * 100).toFixed(1)} %`;
    case 'fabric.source_custody': return { passing: '실시간 전달', forwarding: '보관분 전달 중', storing: '보관 중', full: '용량 초과', idle: '대기' }[value] || String(value);
    case 'mission.relay.status': return { draft: '초안', planned: '계획됨', committed: '실행 중', completed: '완료', failed: '기한 초과', aborted: '중단' }[value] || String(value);
    case 'security.authentication': return { nominal: '기준 충족', warning: '기준 미달', unknown: '미확인' }[value] || String(value);
    case 'security.auth_percent': return `${Number(value).toFixed(2)} %`;
    case 'data.service_status': return { served: '제공', failed: '실패' }[value] || String(value);
    case 'data.stability': case 'data.stability_min': return Number(value).toFixed(0);
    default: return typeof value === 'number' ? String(Math.round(value * 100) / 100) : String(value);
  }
}

export function ruleText(rule) {
  if ('equals' in rule) return `= ${formatMetric(rule.metric, rule.equals)}`;
  const parts = [];
  if ('min' in rule) parts.push(`≥ ${formatMetric(rule.metric, rule.min)}`);
  if ('max' in rule) parts.push(`≤ ${formatMetric(rule.metric, rule.max)}`);
  return parts.join(' · ');
}

// Step checks and verdict rules share one evaluation: { label, metric, value, display, ok, pending }.
export function evaluateChecks(checks, context) {
  return (checks || []).map(check => {
    const value = metricValue(check.metric, context);
    const result = evaluateRule(check, value);
    return { label: check.label || METRIC_LABELS[check.metric] || check.metric, metric: check.metric, value, display: formatMetric(check.metric, value), rule: ruleText(check), ...result };
  });
}

export function verdict(criteria, context) {
  const groups = (criteria || []).map(group => {
    const rules = evaluateChecks(group.rules, context);
    return { id: group.id, label: group.label, rules, ok: rules.length > 0 && rules.every(rule => rule.ok), pending: rules.some(rule => rule.pending) };
  });
  const passed = groups.filter(group => group.ok).length;
  return { groups, passed, total: groups.length, ok: groups.length > 0 && passed === groups.length, pending: groups.some(group => group.pending) };
}

// Rows of the phase comparison table shown at the end: one metric per row, one column per phase.
export function comparisonRows(phases = {}) {
  const rows = [
    ['route.hops', '경로 홉 수', sample => sample.route?.hops], ['route.total_delay_ms', '편도 지연', sample => sample.route?.total_delay_ms],
    ['route.reliability', '경로 신뢰도', sample => sample.route?.reliability], ['mission.relay.hops', '임무 경로 홉', sample => sample.mission?.hops],
    ['mission.relay.latency_ms', '임무 종단 지연', sample => sample.mission?.latency_ms], ['mission.relay.margin_s', '기한 여유', sample => sample.mission?.margin_s],
    ['fabric.usable_links', '사용 가능 링크', sample => sample.fabric?.usable_links], ['fabric.source_custody', 'N1 저장 전달', sample => sample.fabric?.source_custody],
    ['fabric.source_stored_mb', 'N1 보관량', sample => sample.fabric?.source_stored_mb], ['data.stability', '데이터 안정성', sample => sample.data?.stability],
    ['data.objects', '데이터 객체', sample => sample.data?.objects], ['security.authentication', '보안 판정', sample => sample.security?.authentication],
  ];
  return rows.map(([metric, label, pick]) => ({
    metric, label,
    cells: PHASES.map(([phase]) => { const sample = phases[phase]; const value = sample ? pick(sample) ?? null : null; return { phase, value, display: formatMetric(metric, value) }; }),
  }));
}

// VF-03 result record: everything a reviewer needs to reproduce the verdict.
export function resultRecord({ scenario, runId, phases, series, events, verdictResult, log, startedAt, finishedAt }) {
  return {
    contract: 'ICD-06 VF-03', scenario_id: scenario?.id || null, scenario_version: scenario?.version || null, run_id: runId || null,
    started_at: startedAt || null, finished_at: finishedAt || null, verdict: verdictResult ? { ok: verdictResult.ok, passed: verdictResult.passed, total: verdictResult.total, groups: verdictResult.groups } : null,
    phases: PHASES.map(([phase, label]) => ({ phase, label, sample: phases?.[phase] || null })), samples: series?.length || 0, events: events || emptyEvents(),
    comparison: comparisonRows(phases), icd_log: log || [], is_simulation: true,
  };
}
