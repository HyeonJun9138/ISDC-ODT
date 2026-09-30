// Mission model for the space data center: the five service kinds the constellation performs,
// the tasks a plan is made of, target presets, representative rates, and the functions that
// create, normalise, validate and read a mission. Pure data and functions; no DOM, storage or
// transport. Rates are representative engineering figures for a sandbox, not flight values.
import { equipmentActive, equipmentSpec } from '/static/model_library/satellite_nodes.js';

export const MISSION_SCHEMA = 1;

export const MISSION_KINDS = Object.freeze({
  observe: { label: '관측 인도', short: '관측', color: '#3ddc84', note: '지정한 지점을 촬영해 궤도에서 처리하고 기한 안에 지상국으로 내려보낸다.' },
  compute: { label: '궤도상 연산', short: '연산', color: '#79b3e3', note: '위성에 있는 데이터를 궤도에서 처리해 결과만 내려보낸다.' },
  relay: { label: '중계 전송', short: '중계', color: '#a78bfa', note: '위성이나 지상국 사이의 데이터를 OISL 격자와 접속창으로 실어 나른다.' },
  pickup: { label: '외부 위성 데이터 수신', short: '수신', color: '#ffc357', note: '다른 기관의 위성이 가까이 지날 때 교차링크로 데이터를 받아 지상으로 인도한다.' },
  fleet_update: { label: '군집 소프트웨어 갱신', short: '갱신', color: '#f28b82', note: '접속창마다 갱신 이미지를 올리고 정해진 수의 위성씩 순서대로 적용한다.' },
});

export const TASK_KINDS = Object.freeze({
  collect: { label: '촬영', color: '#3ddc84' },
  process: { label: '궤도상 처리', color: '#79b3e3' },
  store: { label: '보관', color: '#6b7d94' },
  crosslink: { label: '위성 간 전달', color: '#a78bfa' },
  transfer: { label: '지상 전송', color: '#4ac4ee' },
  uplink: { label: '지상 상향', color: '#f4b860' },
  apply: { label: '갱신 적용', color: '#f28b82' },
  pickup: { label: '외부 위성 수신', color: '#ffc357' },
});

export const MISSION_STATUSES = Object.freeze({
  draft: { label: '초안', tone: 'neutral' }, planned: { label: '계획됨', tone: 'info' }, committed: { label: '실행 중', tone: 'ok' },
  completed: { label: '완료', tone: 'ok' }, failed: { label: '기한 초과', tone: 'danger' }, aborted: { label: '중단', tone: 'warning' },
});

export const PRIORITY_LABELS = Object.freeze({ 1: '최우선', 2: '높음', 3: '보통', 4: '낮음', 5: '여유' });

// Observation targets an operator can pick without typing coordinates. Coordinates are public.
export const TARGET_PRESETS = Object.freeze([
  { key: 'seoul', name: '서울', latitude: 37.5665, longitude: 126.978 },
  { key: 'daejeon', name: '대전', latitude: 36.3504, longitude: 127.3845 },
  { key: 'busan', name: '부산항', latitude: 35.1028, longitude: 129.0403 },
  { key: 'jeju', name: '제주', latitude: 33.4996, longitude: 126.5312 },
  { key: 'dokdo', name: '독도', latitude: 37.2431, longitude: 131.8643 },
  { key: 'saemangeum', name: '새만금', latitude: 35.7911, longitude: 126.6216 },
  { key: 'pyeongtaek', name: '평택항', latitude: 36.9663, longitude: 126.8324 },
  { key: 'tokyo', name: '도쿄', latitude: 35.6762, longitude: 139.6503 },
  { key: 'singapore', name: '싱가포르 해협', latitude: 1.2, longitude: 103.85 },
  { key: 'dubai', name: '두바이', latitude: 25.2048, longitude: 55.2708 },
  { key: 'svalbard', name: '스발바르', latitude: 78.2298, longitude: 15.4078 },
  { key: 'antarctica', name: '남극 세종기지', latitude: -62.2203, longitude: -58.7867 },
]);

// On-orbit processing throughput per bus preset (Mbps of input data).
export const COMPUTE_RATE_MBPS = Object.freeze({ flat_panel: 400, comms_small: 200, eo_smallsat: 300, cubesat_3u: 20, geo_relay: 100 });
export const DEFAULT_COMPUTE_RATE_MBPS = 200;
// Ground-to-satellite uplink rate per station band.
export const UPLINK_RATE_MBPS = Object.freeze({ S: 0.5, X: 20, Ka: 100 });
export const CROSSLINK_DEFAULTS = Object.freeze({ rate_mbps: 50, max_range_km: 2000 });
export const DEADLINE_PRESETS = Object.freeze([[2, '2시간 안'], [6, '6시간 안'], [12, '12시간 안'], [24, '24시간 안']]);
export const DEFAULT_STORAGE_GB = 64;

export const DEFAULT_PARAMS = Object.freeze({
  observe: { target: 'seoul', target_name: '서울', latitude: 37.5665, longitude: 126.978, max_off_nadir_deg: 30, product_mb: 800, processing: true, processing_ratio: 0.4, preferred_satellite: '', station: '' },
  compute: { source_satellite: '', input_mb: 2000, output_ratio: 0.2, station: '' },
  relay: { source: '', destination: '', volume_mb: 500, max_latency_ms: 0 },
  pickup: { external_id: '', external_name: '', volume_mb: 1500, crosslink_rate_mbps: CROSSLINK_DEFAULTS.rate_mbps, max_range_km: CROSSLINK_DEFAULTS.max_range_km, station: '' },
  fleet_update: { image_mb: 120, apply_s: 600, max_concurrent: 4, satellites: [] },
});

const DEFAULT_REQUESTERS = Object.freeze({ observe: '국토 관측 고객', compute: '데이터 분석 고객', relay: '위성 운영 기관', pickup: '외부 위성 운영 기관', fleet_update: '군집 운용팀' });

function isoOf(value) {
  const time = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function timeOf(value) {
  const time = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? time : null;
}

export function missionLabel(mission) {
  const kind = MISSION_KINDS[mission?.kind];
  if (!kind) return mission?.name || mission?.id || '임무';
  const params = mission.params || {};
  const subject = mission.kind === 'observe' ? params.target_name : mission.kind === 'pickup' ? params.external_name || params.external_id : mission.kind === 'relay' ? `${endpointName(params.source)} → ${endpointName(params.destination)}` : mission.kind === 'compute' ? params.source_satellite || '자동 배정' : `${params.satellites?.length || '전체'} 기`;
  return `${kind.label} · ${subject || '—'}`;
}

export function endpointName(value, names = {}) {
  const text = String(value || '');
  const id = text.includes(':') ? text.split(':')[1] : text;
  return names[id] || id || '—';
}

// A complete mission definition. Missing fields come from the kind's defaults; ids come from the caller.
export function createMission(partial = {}, { id = 'MSN-0000', now = Date.now() } = {}) {
  const kind = MISSION_KINDS[partial.kind] ? partial.kind : 'observe';
  const params = { ...DEFAULT_PARAMS[kind], ...(partial.params || {}) };
  if (kind === 'fleet_update') params.satellites = Array.isArray(params.satellites) ? params.satellites.map(String) : [];
  const created = isoOf(partial.created_at) || new Date(now).toISOString();
  const windowStart = isoOf(partial.window_start) || new Date(now).toISOString();
  const deadline = isoOf(partial.deadline) || new Date(now + 6 * 3600_000).toISOString();
  const priority = Number.isInteger(Number(partial.priority)) && Number(partial.priority) >= 1 && Number(partial.priority) <= 5 ? Number(partial.priority) : 3;
  const mission = {
    schema: MISSION_SCHEMA, id, kind, name: String(partial.name || '').trim(), requester: String(partial.requester ?? DEFAULT_REQUESTERS[kind]).trim(),
    priority, window_start: windowStart, deadline, params, status: MISSION_STATUSES[partial.status] ? partial.status : 'draft',
    plan: partial.plan && typeof partial.plan === 'object' ? { ...partial.plan } : null, notes: String(partial.notes || ''),
    created_at: created, updated_at: new Date(now).toISOString(), committed_at: isoOf(partial.committed_at), exclude: Array.isArray(partial.exclude) ? partial.exclude.map(String) : [],
  };
  if (!mission.name) mission.name = missionLabel(mission);
  return mission;
}

export function normalizeMission(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  return createMission(raw, { id: raw.id, now });
}

export function validateMission(mission, { satellites = [], stations = [] } = {}) {
  const errors = [];
  if (!mission || typeof mission !== 'object') return ['임무 정의가 없습니다.'];
  if (!MISSION_KINDS[mission.kind]) errors.push('알 수 없는 임무 종류입니다.');
  const name = String(mission.name ?? '').trim();
  if (!name || name.length > 60) errors.push('임무 이름은 1~60자여야 합니다.');
  const start = timeOf(mission.window_start); const deadline = timeOf(mission.deadline);
  if (start === null) errors.push('시작 시각이 필요합니다.');
  if (deadline === null) errors.push('인도 기한이 필요합니다.');
  if (start !== null && deadline !== null && deadline <= start) errors.push('인도 기한은 시작 시각보다 뒤여야 합니다.');
  if (start !== null && deadline !== null && deadline - start > 72 * 3600_000) errors.push('계획 창은 72시간을 넘을 수 없습니다.');
  const params = mission.params || {};
  const positive = (key, label) => { if (!(Number(params[key]) > 0)) errors.push(`${label}은(는) 0보다 커야 합니다.`); };
  const satIds = new Set(satellites.map(item => item.id));
  const stationIds = new Set(stations.map(item => item.id));
  switch (mission.kind) {
    case 'observe':
      if (!(Math.abs(Number(params.latitude)) <= 90) || !(Math.abs(Number(params.longitude)) <= 180)) errors.push('관측 지점의 위도와 경도가 필요합니다.');
      if (!(Number(params.max_off_nadir_deg) > 0 && Number(params.max_off_nadir_deg) < 90)) errors.push('최대 관측각은 0°와 90° 사이여야 합니다.');
      positive('product_mb', '산출물 크기');
      if (params.preferred_satellite && !satIds.has(params.preferred_satellite)) errors.push('지정한 담당 위성이 배치 목록에 없습니다.');
      break;
    case 'compute':
      positive('input_mb', '입력 데이터 크기');
      if (!(Number(params.output_ratio) > 0 && Number(params.output_ratio) <= 1)) errors.push('결과 비율은 0과 1 사이여야 합니다.');
      if (params.source_satellite && !satIds.has(params.source_satellite)) errors.push('지정한 처리 위성이 배치 목록에 없습니다.');
      break;
    case 'relay': {
      positive('volume_mb', '전송량');
      for (const [key, label] of [['source', '출발'], ['destination', '도착']]) {
        const [kind, id] = String(params[key] || '').split(':');
        if (!id || (kind !== 'satellite' && kind !== 'station')) errors.push(`${label} 지점을 고르세요.`);
        else if (kind === 'satellite' ? !satIds.has(id) : !stationIds.has(id)) errors.push(`${label} 지점 ${id}이(가) 목록에 없습니다.`);
      }
      if (params.source && params.source === params.destination) errors.push('출발과 도착 지점이 같습니다.');
      break;
    }
    case 'pickup':
      if (!String(params.external_id || '').trim()) errors.push('외부 위성을 고르세요.');
      positive('volume_mb', '수신량'); positive('crosslink_rate_mbps', '교차링크 전송률'); positive('max_range_km', '최대 거리');
      break;
    case 'fleet_update':
      positive('image_mb', '갱신 이미지 크기'); positive('apply_s', '적용 시간');
      if (!(Number(params.max_concurrent) >= 1)) errors.push('동시 적용 수는 1 이상이어야 합니다.');
      for (const id of params.satellites || []) if (!satIds.has(id)) errors.push(`갱신 대상 ${id}이(가) 배치 목록에 없습니다.`);
      break;
    default:
      break;
  }
  if (params.station && !stationIds.has(params.station)) errors.push('지정한 지상국이 목록에 없습니다.');
  return errors;
}

// What the constellation operations module needs to know about one satellite.
export function satelliteCapabilities(node, { storageFreeMb = null } = {}) {
  const items = (node?.equipment || []).map(item => ({ item, spec: equipmentSpec(item) })).filter(entry => entry.spec && equipmentActive(node, entry.item));
  const storageGb = items.filter(entry => entry.spec.kind === 'storage').reduce((sum, entry) => sum + (Number(entry.spec.capacity_gb) || 0), 0) || DEFAULT_STORAGE_GB;
  return {
    camera: items.some(entry => entry.spec.kind === 'payload'),
    compute_mbps: COMPUTE_RATE_MBPS[node?.bus] || DEFAULT_COMPUTE_RATE_MBPS,
    storage_gb: storageGb,
    storage_free_mb: storageFreeMb == null ? storageGb * 1000 : Math.max(0, storageFreeMb),
    oisl: items.some(entry => entry.spec.kind === 'oisl'),
    rf_bands: [...new Set(items.filter(entry => entry.spec.kind === 'rf').map(entry => entry.spec.band))],
  };
}

export function taskStatusAt(task, nowMs) {
  const start = timeOf(task?.start); const end = timeOf(task?.end);
  if (start === null || end === null) return 'planned';
  if (nowMs < start) return 'planned';
  if (nowMs < end) return 'running';
  return 'done';
}

// Execution phase derived from the stored status and the analysis time; nothing is persisted here.
export function missionPhase(mission, nowMs = Date.now()) {
  const stored = MISSION_STATUSES[mission?.status] ? mission.status : 'draft';
  const tasks = mission?.plan?.tasks || [];
  const deadline = timeOf(mission?.deadline);
  if (stored === 'aborted') return { status: 'aborted', progress: 0, ...MISSION_STATUSES.aborted };
  if (stored === 'draft' || !tasks.length) return { status: stored === 'draft' ? 'draft' : 'planned', progress: 0, ...MISSION_STATUSES[stored === 'draft' ? 'draft' : 'planned'] };
  if (stored === 'planned') return { status: 'planned', progress: 0, ...MISSION_STATUSES.planned };
  const total = tasks.reduce((sum, task) => sum + Math.max(1, (timeOf(task.end) || 0) - (timeOf(task.start) || 0)), 0);
  const done = tasks.reduce((sum, task) => {
    const start = timeOf(task.start) || 0; const end = timeOf(task.end) || 0;
    return sum + Math.max(0, Math.min(end, nowMs) - start);
  }, 0);
  const progress = total ? Math.max(0, Math.min(1, done / total)) : 0;
  const finish = Math.max(...tasks.map(task => timeOf(task.end) || 0));
  if (nowMs >= finish) return { status: 'completed', progress: 1, ...MISSION_STATUSES.completed };
  if (deadline !== null && nowMs > deadline && finish > deadline) return { status: 'failed', progress, ...MISSION_STATUSES.failed };
  return { status: 'committed', progress, ...MISSION_STATUSES.committed };
}

// The mission's stored parameters as the ICD-03 request expects them.
export function requestParams(mission) {
  const params = { ...(mission.params || {}) };
  if (mission.kind === 'observe') params.processing = params.processing !== false;
  return params;
}
