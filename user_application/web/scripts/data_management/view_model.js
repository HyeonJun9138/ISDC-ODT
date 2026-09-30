// Pure view helpers for the data management tab: labels, formatting, row models and event merging.
// No DOM access, so node:test covers them. Values come from the ICD-01 dashboard payload.
export const CLASS_LABELS = { imagery: "관측 영상", science: "과학 관측", telemetry: "위성 텔레메트리", mission_log: "임무 로그", ops_snapshot: "DT 운용 스냅샷" };
export const NODE_KIND_LABELS = { core: "지상 코어", edge: "엣지 캐시", onboard: "탑재 저장소" };
export const STATUS_LABELS = { healthy: ["정상", "ok"], degraded: ["복제 부족", "warning"], critical: ["위험", "danger"], expired: ["만료", "neutral"], pending: ["대기", "neutral"] };
export const REPLICA_LABELS = { verified: "검증됨", syncing: "동기화 중", stale: "재검사 대기", unreachable: "접근 불가", corrupt: "손상", lost: "유실" };
export const TIER_LABELS = { hot: "핫", warm: "웜", cold: "콜드" };
export const GRADE_LABELS = { stable: ["안정", "ok"], caution: ["주의", "warning"], unstable: ["불안정", "danger"] };
export const EVENT_KIND_LABELS = {
  ingest_completed: "수집 등록", placement_failed: "저장 실패", under_replicated: "복제 부족", integrity_failed: "무결성 손상", heal_started: "자가복구 시작",
  heal_completed: "자가복구 완료", heal_blocked: "복구 불가", node_unavailable: "노드 사용 불가", node_recovered: "노드 복귀", capacity_warning: "용량 경고",
  request_failed: "서비스 실패", policy_changed: "정책 변경", retention_purged: "보존 만료", verify_completed: "무결성 검사 완료", rebalance_completed: "재균형 완료",
};
export const ACTION_GUIDES = {
  verify: "모든 검증된 복제본의 체크섬을 다시 확인합니다. 불일치가 발견되면 자가복구가 시작됩니다.",
  heal: "복제 부족 또는 손상 상태인 모든 객체의 복구 작업을 시작합니다.",
  rebalance: "사용률 80 % 이상인 노드의 복제본을 여유 있는 노드로 옮깁니다.",
  purge_expired: "보존 기간이 지나 만료된 객체 기록을 카탈로그에서 정리합니다.",
};

export function classLabel(name) {
  return CLASS_LABELS[name] || name || "—";
}

export function formatSize(sizeMb) {
  const value = Number(sizeMb);
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} PB`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)} GB`;
  if (value >= 1) return `${value.toFixed(value >= 100 ? 0 : 1)} MB`;
  return `${(value * 1024).toFixed(0)} KB`;
}

export function formatGb(gb) {
  const value = Number(gb);
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} PB`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)} TB`;
  return `${value.toFixed(value >= 100 ? 0 : 1)} GB`;
}

export function elapsedLabel(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), rest = total % 60;
  return `T+${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export function percent(fraction, digits = 0) {
  if(fraction == null) return "—";
  const value = Number(fraction);
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)} %` : "—";
}

export function gradeOf(stability) {
  if(stability && stability.score == null) return {label:"평가 대기",tone:"neutral",score:null};
  const [label, tone] = GRADE_LABELS[stability?.grade] || ["—", "neutral"];
  return { label, tone, score: Number.isFinite(Number(stability?.score)) ? Number(stability.score) : null };
}

export function componentRows(stability) {
  const components = stability?.components || {};
  return [
    ["availability", "노드 가용", 0.30], ["replication", "복제 충족", 0.25], ["integrity", "정합성", 0.20], ["service", "서비스 성공", 0.15], ["headroom", "용량 여유", 0.10],
  ].map(([key, label, weight]) => {
    const value = components[key] == null ? NaN : Number(components[key]);
    const fraction = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
    return { key, label, weight, fraction, tone: fraction === null ? "neutral" : fraction >= 0.9 ? "ok" : fraction >= 0.7 ? "warning" : "danger" };
  });
}

export function tileRows(overview) {
  const metrics = overview?.metrics || {};
  const capacity = overview?.capacity || {};
  const status = overview?.objects_by_status || {};
  return [
    { key: "ingest", label: "수집 처리율", value: Number.isFinite(Number(metrics.ingest_mbps)) ? `${Number(metrics.ingest_mbps).toFixed(1)} Mbps` : "—", tone: "" },
    { key: "objects", label: "데이터 객체", value: `${metrics.objects ?? "—"}`, tone: "" },
    { key: "replicas", label: "검증 복제본", value: `${metrics.verified_replicas ?? "—"} / ${metrics.replicas ?? "—"}`, tone: (metrics.damaged_replicas || 0) ? "warning" : "" },
    { key: "capacity", label: "저장 사용률", value: percent(capacity.used_ratio, 1), tone: (capacity.used_ratio || 0) >= 0.8 ? "warning" : "" },
    { key: "healing", label: "자가복구 진행", value: `${metrics.healing_jobs ?? 0}건`, tone: (metrics.healing_jobs || 0) ? "warning" : "" },
    { key: "degraded", label: "복제 부족 · 위험", value: `${status.degraded || 0} · ${status.critical || 0}`, tone: (status.critical || 0) ? "danger" : (status.degraded || 0) ? "warning" : "" },
  ];
}

export function stageRows(overview) {
  const stages = overview?.stages || {};
  const total = stages.ingested || 0;
  return [
    { key: "ingested", label: "수집", count: total, note: `${stages.filtered || 0}건 필터링` },
    { key: "filtered", label: "추출·필터", count: Math.max(0, total - (stages.filtered || 0)), note: "규칙 통과" },
    { key: "stored", label: "저장·분산", count: stages.stored ?? 0, note: "1개 이상 검증" },
    { key: "replicated", label: "복제·동기화", count: stages.replicated ?? 0, note: "복제 계수 충족" },
    { key: "served", label: "서비스", count: stages.served ?? 0, note: `${stages.failed || 0}건 실패` },
  ];
}

export function replicaSummary(obj) {
  const counts = {};
  for (const replica of obj?.replicas || []) counts[replica.state] = (counts[replica.state] || 0) + 1;
  return { verified: counts.verified || 0, total: (obj?.replicas || []).length, damaged: (counts.corrupt || 0) + (counts.lost || 0), pending: (counts.syncing || 0) + (counts.stale || 0), unreachable: counts.unreachable || 0 };
}

export function objectRow(obj, target) {
  const [statusLabel, tone] = STATUS_LABELS[obj?.status] || [obj?.status || "—", "neutral"];
  const summary = replicaSummary(obj);
  return {
    id: obj.id, label: obj.label, classLabel: classLabel(obj.class), source: obj.source, size: formatSize(obj.size_mb),
    replicas: `${summary.verified} / ${target ?? "—"}`, replicaTone: summary.damaged ? "danger" : summary.verified < (target ?? 0) ? "warning" : "ok",
    integrity: summary.damaged ? `손상 ${summary.damaged}` : summary.unreachable ? `접근 불가 ${summary.unreachable}` : summary.pending ? `동기화 ${summary.pending}` : "검증됨",
    tier: TIER_LABELS[obj.tier] || obj.tier || "—", statusLabel, tone, created: elapsedLabel(obj.created_s),
  };
}

export function nodeRow(node) {
  const ratio = node?.used_ratio == null ? null : Number(node.used_ratio) || 0;
  const tone = node?.state === "down" ? "danger" : node?.state === "warning" ? "warning" : "ok";
  return { id: node.id, name: node.name || node.id, kind: NODE_KIND_LABELS[node.kind] || node.kind, ratio, used: formatGb(node.used_gb), capacity: formatGb(node.capacity_gb), objects: node.objects ?? 0, tone, reason: node.reason || "", available: node.available !== false, replicas: node.replicas || {} };
}

export function eventRow(event) {
  return { sequence: event.sequence, kind: EVENT_KIND_LABELS[event.kind] || event.kind, severity: event.severity || "info", message: event.message, time: elapsedLabel(event.time_s), objectId: event.object_id || null, node: event.node || null };
}

// Newest first, deduplicated by sequence, capped; incoming events may overlap the previous poll.
export function mergeEvents(existing, incoming, max = 200) {
  const seen = new Set();
  const merged = [];
  for (const event of [...(incoming || []), ...(existing || [])].sort((a, b) => b.sequence - a.sequence)) {
    if (seen.has(event.sequence)) continue;
    seen.add(event.sequence);
    merged.push(event);
    if (merged.length >= max) break;
  }
  return merged;
}

export function moduleBadge(module) {
  if (!module) return { label: "연결 확인 중", tone: "neutral" };
  if (module.reachable === false) return { label: "외부 모듈 응답 없음", tone: "danger" };
  return module.placement === "remote" ? { label: `외부 · ${module.endpoint || ""}`.trim(), tone: "ok" } : { label: "내장 임시 구현 · ICD-01", tone: "ok" };
}

export function deploymentView(report, error = '') {
  const failed = !!error || report?.module?.reachable === false;
  const nodes = report?.deployment?.nodes || [];
  const storage = (report?.nodes || []).filter(node => Number(node.capacity_gb) > 0 && node.available !== false);
  const connected = !!report?.deployment && !failed;
  const canConfigure = connected && storage.length > 0;
  return {
    canConfigure, canOperate:canConfigure && (report?.overview?.metrics?.objects || 0) > 0,
    message:failed ? '배치 동기화 또는 데이터 모듈 조회 실패' : !connected ? '배치 구성 확인 중' : !nodes.length ? '배치된 SDC 위성이 없습니다. 노드 탭에서 위성을 배치하세요.' : !storage.length ? '사용 가능한 SDC 저장소가 없습니다. 저장 장치 설정과 운용 상태를 확인하세요.' : `배치된 SDC ${nodes.length}기 / 사용 가능한 저장소 ${storage.length}개`,
  };
}

export function acceptsDeploymentReport(report, expected, runId) {
  if(!report?.deployment || (runId && report.runtime?.run_id !== runId)) return false;
  if(!expected) return true;
  const incoming=report.deployment;
  if(incoming.revision < expected.revision) return false;
  return incoming.revision > expected.revision || incoming.scope_id === expected.scope_id;
}
