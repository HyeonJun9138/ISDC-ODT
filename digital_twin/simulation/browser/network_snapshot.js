// Builds the ICD-02 "네트워크 상태 갱신" message the twin sends to the data fabric: the user's
// satellites and ground stations as nodes, and the OISL pairs, ground links and terrestrial mesh
// as links with the geometry and terminal states the twin computed. Active SIM faults are folded
// in as link or node attributes here, so the fabric never has to know the runtime's fault model.
// Pure function of its inputs; no DOM, transport or storage.
import { equipmentActive, equipmentSpec } from '/static/model_library/satellite_nodes.js';
import { groundLink, pairId, terrestrialLinks } from '/static/simulation/ground_links.js';
import { linkMargin } from '/static/simulation/oisl.js';

export const HOUSEKEEPING_MBPS = 0.2;
export const PAYLOAD_GENERATION_MBPS = Object.freeze({ payload: 40 });
export const DEFAULT_STORAGE_GB = 64;
export const FAULT_EXTRA_DELAY_MS = Object.freeze({ low: 40, medium: 85, high: 200 });

// Data a satellite produces for the fabric to move: housekeeping plus any active payload.
export function generationMbps(node) {
  let total = HOUSEKEEPING_MBPS;
  for (const item of node?.equipment || []) {
    const spec = equipmentSpec(item);
    if (spec && equipmentActive(node, item)) total += PAYLOAD_GENERATION_MBPS[spec.kind] || 0;
  }
  return Math.round(total * 1000) / 1000;
}

export function storageGb(node) {
  let capacity = 0;
  for (const item of node?.equipment || []) {
    const spec = equipmentSpec(item);
    if (spec?.kind === 'storage' && equipmentActive(node, item)) capacity += Number(spec.capacity_gb) || 0;
  }
  return capacity || DEFAULT_STORAGE_GB;
}

function faultTargets(faults, kind) {
  return new Set((faults || []).filter(fault => fault?.kind === kind && fault.active !== false).map(fault => String(fault.target)));
}

function touches(targets, ...names) {
  return names.some(name => name != null && targets.has(String(name)));
}

// nodes: satellite definitions; states: Map node id -> nodeStateAt result; pairs: OISL pairs from
// resolveLinks; stations: enabled ground stations; faults: runtime active faults.
export function buildNetworkSnapshot({ date, nodes = [], states = new Map(), pairs = [], stations = [], faults = [] }) {
  const time = (date instanceof Date ? date : new Date(date)).toISOString();
  const lossTargets = faultTargets(faults, 'link_loss');
  const latencyFaults = (faults || []).filter(fault => fault?.kind === 'latency_spike' && fault.active !== false);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const nodeRecords = nodes.map(node => {
    const extra = latencyFaults.filter(fault => touches(new Set([String(fault.target)]), node.id, node.name))
      .reduce((sum, fault) => sum + (FAULT_EXTRA_DELAY_MS[fault.severity] || FAULT_EXTRA_DELAY_MS.medium), 0);
    return { id: node.id, name: node.name, kind: 'satellite', mode: node.mode, generation_mbps: generationMbps(node), storage_gb: storageGb(node), extra_delay_ms: extra };
  });
  for (const station of stations) {
    nodeRecords.push({ id: station.id, name: station.name, kind: 'ground', mode: 'nominal', generation_mbps: 0, storage_gb: 0, extra_delay_ms: 0 });
  }
  const links = [];
  for (const pair of pairs) {
    const a = byId.get(pair.a); const b = byId.get(pair.b);
    if (!a || !b) continue;
    const direction = pair.directions?.find(item => item.geometry) || pair.directions?.[0];
    const spec = direction?.spec;
    const margin = pair.range_km && spec ? linkMargin(pair.range_km, spec) : { margin_db: null };
    links.push({
      id: pairId(a.id, b.id), a: a.id, b: b.id, kind: 'oisl', state: pair.state,
      range_km: pair.range_km == null ? null : Math.round(pair.range_km * 10) / 10,
      data_rate_mbps: spec ? Number(spec.data_rate_mbps) || 0 : 0,
      margin_db: margin.margin_db == null ? null : Math.round(margin.margin_db * 100) / 100,
      faulted: touches(lossTargets, pairId(a.id, b.id), a.id, a.name, b.id, b.name),
    });
  }
  for (const station of stations) {
    for (const node of nodes) {
      const state = states.get(node.id);
      const link = groundLink(station, node, state?.geodetic || null);
      if (!link) continue;
      links.push({ ...link, faulted: touches(lossTargets, link.id, station.id, station.name, node.id, node.name) });
    }
  }
  for (const link of terrestrialLinks(stations)) {
    links.push({ ...link, faulted: touches(lossTargets, link.id, link.a, link.b) });
  }
  return { time, nodes: nodeRecords, links };
}

// Display helpers shared by the list, scene and diagram.
export const LINK_KIND_LABELS = Object.freeze({ oisl: 'OISL 광 링크', ground: '지상 RF 링크', terrestrial: '지상망' });
export const CUSTODY_LABELS = Object.freeze({ passing: '실시간 전달', forwarding: '보관분 전달 중', storing: '보관 중 (지상 경로 없음)', full: '저장 용량 초과', idle: '대기' });
export const REASON_LABELS = Object.freeze({ fault: '장애 주입', not_locked: '양방향 추적 아님', margin: '여유 부족', below_mask: '고각 마스크 아래', no_budget: '예산 계산 불가', no_radio: '지원 대역 없음' });
