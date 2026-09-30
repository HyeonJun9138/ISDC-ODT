// Working set of missions for the mission console: requests, the plans the operations module
// answered, the operator's commit/abort decisions and a short decision log. A per-browser display
// configuration in localStorage (like the node working set), not server runtime state.
import { createMission, normalizeMission, validateMission } from "/static/model_library/mission_types.js";

export const MISSIONS_KEY = "spacetwin-missions-v1";
export const MAX_MISSIONS = 60;
export const MAX_LOG = 200;

function readJson(storage, key) {
  try { const raw = storage?.getItem?.(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function writeJson(storage, key, value) {
  try { storage?.setItem?.(key, JSON.stringify(value)); return true; } catch { return false; }
}

export function createMissionStore({ storage = null, now = () => Date.now() } = {}) {
  const listeners = new Set();
  let missions = [];
  let log = [];
  let sequence = 0;
  let selectedId = null;
  const notify = event => listeners.forEach(listener => listener(event, api));

  function persist() {
    writeJson(storage, MISSIONS_KEY, { schema: 1, sequence, selectedId, missions, log });
  }

  function load() {
    const saved = readJson(storage, MISSIONS_KEY);
    const epoch = now();
    missions = (Array.isArray(saved?.missions) ? saved.missions : []).map(item => normalizeMission(item, epoch)).filter(Boolean).slice(0, MAX_MISSIONS);
    log = (Array.isArray(saved?.log) ? saved.log : []).filter(entry => entry && typeof entry === "object").slice(-MAX_LOG);
    const highest = missions.reduce((max, mission) => Math.max(max, Number(/^MSN-(\d+)$/.exec(mission.id)?.[1]) || 0), 0);
    sequence = Math.max(Number(saved?.sequence) || 0, highest);
    selectedId = missions.some(mission => mission.id === saved?.selectedId) ? saved.selectedId : missions[0]?.id || null;
    notify("load");
  }

  function find(id) {
    return missions.find(mission => mission.id === id) || null;
  }

  function record(entry) {
    log = [...log, { time: new Date(now()).toISOString(), ...entry }].slice(-MAX_LOG);
  }

  function add(partial = {}, context = {}) {
    if (missions.length >= MAX_MISSIONS) throw new RangeError(`임무는 최대 ${MAX_MISSIONS}개까지 둘 수 있습니다.`);
    sequence += 1;
    const mission = createMission(partial, { id: `MSN-${String(sequence).padStart(4, "0")}`, now: now() });
    const errors = validateMission(mission, context);
    if (errors.length) { sequence -= 1; return { mission: null, errors }; }
    missions = [...missions, mission];
    selectedId = mission.id;
    record({ mission_id: mission.id, kind: "created", message: `${mission.name} 요청 등록` });
    persist(); notify("add");
    return { mission, errors: [] };
  }

  // Replace request fields; a changed request drops the plan and returns the mission to draft.
  function update(id, patch, context = {}) {
    const index = missions.findIndex(mission => mission.id === id);
    if (index < 0) return ["임무를 찾을 수 없습니다."];
    const current = missions[index];
    const candidate = createMission({ ...current, ...patch, params: { ...current.params, ...(patch.params || {}) }, plan: null, status: "draft", committed_at: null }, { id, now: now() });
    const errors = validateMission(candidate, context);
    if (errors.length) return errors;
    missions = missions.map(mission => (mission.id === id ? candidate : mission));
    record({ mission_id: id, kind: "edited", message: `${candidate.name} 요청 수정 · 계획 초기화` });
    persist(); notify("update");
    return [];
  }

  function setPlan(id, plan, { source = "orchestrator" } = {}) {
    const mission = find(id);
    if (!mission || !plan) return null;
    const version = (mission.plan?.version || 0) + 1;
    const next = { ...mission, plan: { ...plan, version, source, received_at: new Date(now()).toISOString() }, status: mission.status === "committed" ? "committed" : "planned", updated_at: new Date(now()).toISOString() };
    missions = missions.map(item => (item.id === id ? next : item));
    record({ mission_id: id, kind: plan.feasible ? "planned" : "infeasible", message: `${next.name} 계획 v${version} · ${plan.feasible ? `${plan.tasks?.length || 0}개 작업, ${plan.summary?.satellites?.length || 0}기` : (plan.reasons?.[0] || plan.checks?.find(check => !check.ok)?.detail || "실행 불가")}` });
    persist(); notify("plan");
    return next;
  }

  function setStatus(id, status, message = null) {
    const mission = find(id);
    if (!mission) return null;
    const next = { ...mission, status, updated_at: new Date(now()).toISOString(), committed_at: status === "committed" ? new Date(now()).toISOString() : status === "draft" || status === "planned" ? null : mission.committed_at };
    missions = missions.map(item => (item.id === id ? next : item));
    record({ mission_id: id, kind: status, message: message || `${next.name} · ${status}` });
    persist(); notify("status");
    return next;
  }

  function remove(id) {
    const mission = find(id);
    if (!mission) return false;
    missions = missions.filter(item => item.id !== id);
    if (selectedId === id) selectedId = missions[0]?.id || null;
    record({ mission_id: id, kind: "removed", message: `${mission.name} 삭제` });
    persist(); notify("remove");
    return true;
  }

  function duplicate(id) {
    const source = find(id);
    if (!source) return null;
    const { plan, status, committed_at, created_at, ...rest } = source;
    return add({ ...rest, name: `${source.name} 사본` }).mission;
  }

  function select(id) {
    selectedId = find(id) ? id : null;
    persist(); notify("select");
    return selectedId;
  }

  const api = {
    load, add, update, setPlan, setStatus, remove, duplicate, select, find, record: entry => { record(entry); persist(); notify("log"); },
    get missions() { return missions; },
    get log() { return log; },
    get selectedId() { return selectedId; },
    get selected() { return find(selectedId); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return api;
}

export const missionStore = createMissionStore({ storage: globalThis.localStorage || null });
