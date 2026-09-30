// 임무 탭. 우주 데이터 센터가 맡는 서비스 임무(관측 인도, 궤도상 연산, 중계 전송, 외부 위성 데이터 수신,
// 군집 소프트웨어 갱신)를 요청으로 등록하고, 디지털 트윈이 계산한 창(지상국 접속, 관측 통과, 식, 외부 위성
// 교차링크)과 위성 상태를 군집 운용 모듈(ICD-03)에 보내 위성별 작업 배정과 판정을 받아 일정표에 올린다.
// 위성은 노드 탭에서 배치한 내 위성, 지상국은 통신 탭의 지상국이며, 외부 위성은 대시보드 카탈로그(GP)에서
// 고른다. 임무와 계획은 브라우저에 저장되는 화면 구성이고, 배정 논리는 모듈이 맡는다. 실행 상태는 분석
// 시각으로 판정하며 모듈이 응답하지 않으면 계획을 만들지 않는다. 모든 값은 모의 계산이다.
import { MISSION_KINDS, TASK_KINDS, MISSION_STATUSES, PRIORITY_LABELS, TARGET_PRESETS, DEADLINE_PRESETS, DEFAULT_PARAMS, missionLabel, missionPhase, taskStatusAt, satelliteCapabilities, requestParams, timeOf } from "/static/model_library/mission_types.js";
import { NODE_MODES } from "/static/model_library/satellite_nodes.js";
import { layoutTimeline, timelineMarkup, TIMELINE } from "/static/visualization/mission_timeline.js?v=20260908-scenario3";
import { api } from "/static/communication/api.js";
import { emit, store } from "../state.js";
import { OrbitClock } from "../orbit/clock.js?v=20260908-scenario1";
import { displayNumber, escapeMarkup as esc, utcLabel } from "../orbit/catalog.js";
import { constellation } from "../nodes/constellation.js";
import { groundSegment } from "../communication/ground_segment.js";
import { missionStore } from "../missions/mission_store.js";
import { missionPlanner } from "../missions/planner_client.js";

const $ = selector => document.querySelector(selector);
const STATUS_POLL_MS = 30_000;
const TIMELINE_REFRESH_MS = 10_000;

let view, clock, orchestration;
let active = false, tickTimer = null, statusTimer = null, lastTimelineMs = 0, lastTimelineWidth = 0, lastTimelineRowHeight = 0;
const TIMELINE_ROW_MAX = 40;
let listFilter = "all";
let timelineHours = 12;
let rowFilter = "busy";
let selectedTaskId = null;
let formState = null;          // { mode: 'new' | 'edit', id, kind, values }
let planning = null;           // { missionId, stage }
let moduleState = { placement: null, endpoint: "", implementation: null, version: null, reachable: null, rtt: null, error: null, sequence: null };
let searchTimer = null;
let searchResults = [];
let listKey = null, logKey = null;

const toast = (type, title, message) => emit("toast", { type, title, message });
const satellites = () => constellation.deployed;
const stations = () => groundSegment.enabled;
const satelliteById = id => satellites().find(node => node.id === id) || null;
const stationById = id => groundSegment.find(id);
const kindOf = mission => MISSION_KINDS[mission?.kind] || { label: mission?.kind, short: "?", color: "#8ea4b8" };

function nameOf(id) {
  const text = String(id ?? "");
  if (text.includes("|")) return text.split("|").map(nameOf).join(" ↔ ");
  const bare = text.includes(":") ? text.split(":")[1] : text;
  const node = satelliteById(bare);
  if (node) return node.name;
  const station = stationById(bare);
  if (station) return station.name;
  for (const mission of missionStore.missions) if (String(mission.params?.external_id) === bare && mission.params?.external_name) return mission.params.external_name;
  return bare || "—";
}

/* ---------- planning through the shared planner (missions/planner.js) ---------- */

async function planMission(id, { exclude = [], reason = "계획 생성" } = {}) {
  const mission = missionStore.find(id);
  if (!mission || planning) return;
  if (!satellites().length) { toast("warning", reason, "배치된 위성이 없습니다. 노드 탭에서 배치 완료를 누르세요."); return; }
  const started = performance.now();
  try {
    const { request, answer } = await missionPlanner.plan(mission, { exclude, onStage: stage => { planning = { missionId: id, stage }; renderPlanningState(); } });
    moduleState = { ...moduleState, reachable: true, rtt: Math.round(performance.now() - started), error: null, sequence: answer.sequence, implementation: answer.implementation, version: answer.version };
    missionStore.setPlan(id, { ...answer, request_horizon: request.horizon, exclude: request.exclude });
    toast(answer.feasible ? "success" : "warning", reason, answer.feasible ? `${answer.tasks.length}개 작업 · ${utcLabel(answer.summary.finish_at).slice(11, 16)} UTC 완료 예정` : answer.reasons?.[0] || answer.checks?.find(check => !check.ok)?.detail || "실행 불가");
  } catch (error) {
    if (error.unavailable) moduleState = { ...moduleState, reachable: false, error: error.message };
    toast("error", `${reason} 실패`, error.message);
  } finally {
    planning = null; renderAll();
  }
}

async function pollStatus() {
  try {
    const status = await missionPlanner.orchestration.status();
    const endpoint = missionPlanner.orchestration.endpoint();
    moduleState = { ...moduleState, placement: endpoint.placement === "remote" ? "remote" : status.placement, endpoint: endpoint.placement === "remote" ? endpoint.base : status.endpoint, implementation: status.implementation, version: status.version,
      reachable: status.reachable !== false ? (moduleState.reachable ?? true) : false, error: status.reachable === false ? status.detail : moduleState.error };
  } catch (error) {
    moduleState = { ...moduleState, reachable: false, error: error.message };
  }
  renderModuleChip();
}

/* ---------- derived views ---------- */

function missionRows() {
  const now = clock.now().getTime();
  return missionStore.missions.map(mission => ({ mission, phase: missionPhase(mission, now) }));
}

// Satellites and faulted OISL pairs (as "a|b" keys) a committed plan can no longer rely on.
function needsReconfiguration(mission) {
  const affected = missionPlanner.affectedTasks(mission, clock.now().getTime());
  return [...affected.satellites, ...affected.links];
}

function allTasks() {
  const now = clock.now().getTime();
  const tasks = [];
  for (const mission of missionStore.missions) {
    if (!mission.plan?.tasks || mission.status === "draft" || mission.status === "aborted") continue;
    for (const task of mission.plan.tasks) {
      tasks.push({ ...task, mission_id: mission.id, status: mission.status === "committed" ? taskStatusAt(task, now) : "planned", feasible: mission.plan.feasible !== false });
    }
  }
  return tasks;
}

/* ---------- rendering: left ---------- */

function renderSummary() {
  const rows = missionRows();
  const count = status => rows.filter(row => row.phase.status === status).length;
  const risky = rows.filter(row => (row.mission.plan && row.mission.plan.feasible === false && row.phase.status !== "aborted") || needsReconfiguration(row.mission).length).length;
  $("#msn-counts").innerHTML = [["전체", rows.length], ["계획됨", count("planned")], ["실행 중", count("committed")], ["완료", count("completed")], ["주의", risky]]
    .map(([label, value]) => `<span class="${label === "주의" && value ? "warn" : ""}"><b>${esc(value)}</b><small>${esc(label)}</small></span>`).join("");
  $("#msn-source").textContent = satellites().length ? `배치 위성 ${satellites().length}기 · 지상국 ${stations().length}곳` : "배치된 위성 없음";
}

function missionRow({ mission, phase }) {
  const kind = kindOf(mission);
  const deadline = timeOf(mission.deadline);
  const now = clock.now().getTime();
  const remaining = deadline === null ? null : deadline - now;
  const margin = mission.plan?.summary?.margin_s;
  const reconfigure = needsReconfiguration(mission).length > 0;
  const tone = reconfigure ? "danger" : phase.status === "failed" ? "danger" : mission.plan?.feasible === false ? "warning" : phase.status === "committed" || phase.status === "completed" ? "ok" : phase.status === "planned" ? "info" : "neutral";
  const sub = [kind.label, mission.requester, remaining === null ? "" : remaining < 0 ? "기한 지남" : `기한까지 ${displayNumber(remaining / 3600_000, 1)} h`].filter(Boolean).join(" · ");
  const aside = reconfigure ? "재구성 필요" : mission.plan ? (mission.plan.feasible ? `여유 ${displayNumber((margin || 0) / 60, 0)}분` : "실행 불가") : "계획 없음";
  return `<button class="msn-row" role="option" aria-selected="${missionStore.selectedId === mission.id}" data-msn-id="${esc(mission.id)}"><span class="status-dot ${tone}"></span><span class="msn-row-body"><b>${esc(mission.name)}</b><small>${esc(sub)}</small></span><span class="msn-row-aside"><i class="msn-chip ${esc(phase.tone)}">${esc(phase.label)}</i><small>${esc(aside)}</small></span></button>`;
}

function renderList() {
  const list = $("#msn-list");
  const rows = missionRows().filter(row => listFilter === "all" || (listFilter === "active" ? ["planned", "committed", "draft"].includes(row.phase.status) : ["completed", "failed", "aborted"].includes(row.phase.status)))
    .sort((p, q) => (timeOf(p.mission.deadline) || 0) - (timeOf(q.mission.deadline) || 0));
  list.innerHTML = rows.map(missionRow).join("") || `<div class="msn-empty">${missionStore.missions.length ? "이 구분에 해당하는 임무가 없습니다." : "임무가 없습니다. <b>＋ 새 임무</b>로 요청을 등록하면 군집 운용 모듈이 위성별 작업을 배정합니다."}</div>`;
}

function renderModuleChip() {
  const chip = $("#msn-module-chip");
  const endpoint = orchestration?.endpoint();
  const where = endpoint?.placement === "remote" ? `외부 ${endpoint.base}` : moduleState.placement === "remote" ? `외부 ${moduleState.endpoint || ""} (서버 전달)` : "내장 임시 구현";
  const state = moduleState.reachable === null ? "확인 중" : moduleState.reachable ? `응답 ${moduleState.rtt ?? "—"} ms${moduleState.sequence ? ` · #${moduleState.sequence}` : ""}` : "미응답";
  chip.className = `msn-module ${moduleState.reachable === false ? "down" : moduleState.reachable ? "up" : ""}`;
  chip.innerHTML = `<i></i><b>군집 운용 모듈</b><span>${esc(where)}${moduleState.version ? ` v${esc(moduleState.version)}` : ""}</span><span class="msn-module-state">${esc(state)}</span>${moduleState.error && moduleState.reachable === false ? `<small>${esc(moduleState.error)}</small>` : ""}`;
}

/* ---------- rendering: centre ---------- */

function renderClock() {
  if (!clock) return;
  $("#msn-clock").textContent = utcLabel(clock.now());
  $("#msn-clock-mode").textContent = clock.isLive ? "현재 시각" : clock.running ? "시간 탐색" : "일시정지";
  $("#msn-clock-pause").textContent = clock.running ? "Ⅱ" : "▶";
  $("#msn-clock-speed").value = String(clock.speed);
  $("#msn-clock-now").setAttribute("aria-pressed", String(clock.isLive));
}

function renderPlanningState() {
  const label = $("#msn-planning");
  if (!label) return;
  if (!planning) { label.hidden = true; return; }
  const mission = missionStore.find(planning.missionId);
  label.hidden = false;
  label.textContent = `${mission?.name || planning.missionId}: ${planning.stage === "windows" ? "접속창과 관측 창 계산 중…" : "군집 운용 모듈에 편성 요청 중…"}`;
}

// The schedule is drawn at the host's pixel width so glyphs and bars are never stretched or
// squeezed to fit; a hidden host (width 0) falls back to the renderer's nominal width.
function timelineWidth(host) {
  const measured = Math.round(host?.clientWidth || 0);
  return measured >= 320 ? measured : TIMELINE.width;
}

// A few rows spread over the schedule area (up to TIMELINE_ROW_MAX px each) instead of huddling
// under the header; many rows keep the nominal height and scroll.
function timelineRowHeight(host, rowCount) {
  const available = Math.round(host?.clientHeight || 0) - TIMELINE.header - TIMELINE.padding;
  if (available <= 0 || rowCount < 1) return TIMELINE.rowHeight;
  return Math.max(TIMELINE.rowHeight, Math.min(TIMELINE_ROW_MAX, Math.floor(available / rowCount)));
}

function renderTimeline() {
  const host = $("#msn-timeline");
  if (!host) return;
  const now = clock.now().getTime();
  const start = now - 30 * 60_000;
  const end = start + timelineHours * 3600_000;
  const tasks = allTasks();
  const busySatellites = new Set([...tasks.map(task => task.satellite), ...(missionPlanner.extraWindows.get(missionStore.selectedId)?.access || []).map(window => window.satellite)]);
  const rows = satellites().filter(node => rowFilter === "all" || busySatellites.has(node.id)).sort((p, q) => p.name.localeCompare(q.name, "en", { numeric: true }))
    .map(node => ({ id: node.id, label: node.name, note: node.mode !== "nominal" ? NODE_MODES[node.mode]?.label || node.mode : "" }));
  if (!rows.length) {
    host.innerHTML = `<div class="msn-empty tall">${satellites().length ? "작업이 배정된 위성이 없습니다. 임무를 계획하거나 <b>전체 위성</b>을 선택하세요." : "배치된 위성이 없습니다. 노드 탭에서 위성을 배치하고 <b>배치 완료 → 대시보드</b>를 누르세요."}</div>`;
    return;
  }
  lastTimelineWidth = timelineWidth(host);
  lastTimelineRowHeight = timelineRowHeight(host, rows.length);
  const layout = layoutTimeline({ rows, start, end, width: lastTimelineWidth, rowHeight: lastTimelineRowHeight });
  const windowsCache = missionPlanner.windows;
  const contacts = windowsCache ? windowsCache.contacts.map(window => ({ ...window, station_name: stationById(window.station)?.name || window.station })) : [];
  const eclipses = windowsCache ? windowsCache.eclipses : [];
  const deadlines = missionStore.missions.filter(mission => mission.plan || mission.id === missionStore.selectedId).map(mission => ({ ms: timeOf(mission.deadline), label: `${mission.name} 기한`, mission_id: mission.id })).filter(item => item.ms !== null);
  const accesses = missionPlanner.extraWindows.get(missionStore.selectedId)?.access || [];
  host.innerHTML = timelineMarkup(layout, { tasks: tasks.map(task => ({ ...task, label: TASK_KINDS[task.kind]?.label || task.kind })), contacts, eclipses, accesses, now, deadlines, selectedTaskId, selectedMissionId: missionStore.selectedId, kinds: TASK_KINDS });
  host.style.setProperty("--mt-height", `${layout.height}px`);
  lastTimelineMs = Date.now();
  $("#msn-timeline-foot").textContent = `${rows.length}기 표시 · 작업 ${tasks.length}개 · ${windowsCache ? `접속창 ${windowsCache.contacts.length}개, 식 ${windowsCache.eclipses.length}회 (${utcLabel(new Date(windowsCache.start)).slice(11, 16)} UTC부터 ${windowsCache.hours} h)` : "접속창 미계산 (임무를 계획하면 계산)"} · Kepler+J2 기하`;
}

function moveNowLine() {
  const svg = $("#msn-timeline svg");
  if (!svg || Date.now() - lastTimelineMs > TIMELINE_REFRESH_MS) { renderTimeline(); return; }
  const line = svg.querySelector(".mt-now line"); const text = svg.querySelector(".mt-now text");
  if (!line) { renderTimeline(); return; }
  const width = Number(svg.viewBox.baseVal.width); const gutter = Number(line.dataset.gutter || 150);
  const start = clock.now().getTime() - 30 * 60_000 - (Date.now() - lastTimelineMs) * (clock.isLive ? 1 : clock.running ? clock.speed : 0);
  const x = gutter + Math.max(0, Math.min(1, (clock.now().getTime() - start) / (timelineHours * 3600_000))) * (width - gutter - 6);
  line.setAttribute("x1", x.toFixed(1)); line.setAttribute("x2", x.toFixed(1)); if (text) text.setAttribute("x", (x + 4).toFixed(1));
}

function renderChecks() {
  const host = $("#msn-checks");
  const mission = missionStore.selected;
  if (!mission) { host.innerHTML = `<div class="msn-empty">임무를 고르면 군집 운용 모듈의 검토 결과를 보여 줍니다.</div>`; return; }
  const plan = mission.plan;
  if (!plan) { host.innerHTML = `<div class="msn-empty">아직 계획이 없습니다. <b>계획 생성</b>을 누르세요.</div>`; return; }
  const reconfigure = needsReconfiguration(mission);
  const rows = [
    ...(plan.checks || []).map(check => `<tr class="${check.ok ? "ok" : "bad"}"><td>${esc(check.label)}</td><td><span class="msn-chip ${check.ok ? "ok" : "danger"}">${check.ok ? "통과" : "미달"}</span></td><td>${esc(check.detail || "")}</td></tr>`),
    ...(plan.reasons || []).map(reason => `<tr class="bad"><td>사유</td><td><span class="msn-chip danger">불가</span></td><td>${esc(reason)}</td></tr>`),
    ...(plan.unavailable || []).map(item => `<tr class="muted"><td>제외 위성</td><td><span class="msn-chip neutral">${esc(nameOf(item.satellite))}</span></td><td>${esc(item.reason)}</td></tr>`),
    ...(reconfigure.length ? [`<tr class="bad"><td>재구성</td><td><span class="msn-chip danger">필요</span></td><td>${esc(reconfigure.map(nameOf).join(", "))}이(가) 사용할 수 없게 되어 남은 작업을 다시 배정해야 합니다.</td></tr>`] : []),
  ];
  host.innerHTML = `<div class="msn-table-wrap"><table><thead><tr><th>항목</th><th>결과</th><th>내용</th></tr></thead><tbody>${rows.join("")}</tbody></table></div><small class="msn-foot">계획 v${esc(plan.version)} · ${esc(plan.implementation === "stand_in" ? "내장 임시 구현" : plan.implementation || "모듈")} ${esc(plan.version_module || plan.version_tag || "")} · 대안 ${esc(plan.alternatives ?? 0)}개 검토 · ${esc(utcLabel(plan.received_at).slice(11, 19))} UTC 수신</small>`;
}

function renderTaskTable() {
  const host = $("#msn-tasks");
  const mission = missionStore.selected;
  const now = clock.now().getTime();
  if (!mission?.plan?.tasks?.length) { host.innerHTML = `<div class="msn-empty">${mission ? "배정된 작업이 없습니다." : "임무를 고르세요."}</div>`; return; }
  const rows = mission.plan.tasks.map((task, index) => {
    const status = mission.status === "committed" ? taskStatusAt(task, now) : mission.status === "aborted" ? "aborted" : "planned";
    const label = { planned: "예정", running: "진행", done: "완료", aborted: "중단" }[status];
    return `<tr class="${esc(status)} ${selectedTaskId === task.id ? "selected" : ""}" data-msn-task="${esc(task.id)}"><td>${index + 1}</td><td><i class="msn-swatch" style="background:${esc(TASK_KINDS[task.kind]?.color || "#8ea4b8")}"></i>${esc(TASK_KINDS[task.kind]?.label || task.kind)}</td><td>${esc(nameOf(task.satellite))}</td><td>${esc(task.counterpart ? nameOf(task.counterpart) : "—")}</td><td>${esc(utcLabel(task.start).slice(5, 16))}</td><td>${esc(displayNumber(task.duration_s / 60, 1))} min</td><td>${task.volume_mb ? esc(displayNumber(task.volume_mb, 0)) + " MB" : "—"}</td><td><span class="msn-chip ${status === "done" ? "ok" : status === "running" ? "info" : status === "aborted" ? "warning" : "neutral"}">${esc(label)}</span></td></tr>`;
  });
  host.innerHTML = `<div class="msn-table-wrap"><table><thead><tr><th>#</th><th>작업</th><th>위성</th><th>상대</th><th>시작 UTC</th><th>길이</th><th>크기</th><th>상태</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

function renderLog() {
  const host = $("#msn-log");
  const entries = [...missionStore.log].reverse().slice(0, 40);
  const key = `${entries.length}|${entries[0]?.time}`;
  if (key === logKey) return;
  logKey = key;
  host.innerHTML = entries.length ? `<div class="msn-table-wrap"><table><thead><tr><th>시각 UTC</th><th>임무</th><th>기록</th></tr></thead><tbody>${entries.map(entry => `<tr><td>${esc(utcLabel(entry.time).slice(5, 19))}</td><td>${esc(missionStore.find(entry.mission_id)?.name || entry.mission_id || "—")}</td><td>${esc(entry.message)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="msn-empty">아직 기록이 없습니다.</div>`;
}

/* ---------- rendering: right (detail and form) ---------- */

function optionList(options, selected, blank = null) {
  return [blank ? `<option value="">${esc(blank)}</option>` : "", ...options.map(([value, label]) => `<option value="${esc(value)}" ${String(selected) === String(value) ? "selected" : ""}>${esc(label)}</option>`)].join("");
}

function satelliteOptions(filter = () => true) {
  return satellites().filter(filter).map(node => [node.id, `${node.name}${node.mode !== "nominal" ? ` (${NODE_MODES[node.mode]?.label || node.mode})` : ""}`]);
}

function stationOptions() {
  return stations().map(station => [station.id, station.name]);
}

function endpointOptions() {
  return [...satellites().map(node => [`satellite:${node.id}`, `위성 ${node.name}`]), ...stations().map(station => [`station:${station.id}`, `지상국 ${station.name}`])];
}

function kindFields(kind, values) {
  const p = values.params;
  if (kind === "observe") {
    return `<div class="msn-grid-2"><label>관측 지점 <select data-field="params.target">${optionList(TARGET_PRESETS.map(item => [item.key, item.name]), p.target, "직접 입력")}</select></label><label>지점 이름 <input data-field="params.target_name" value="${esc(p.target_name)}" maxlength="40"></label></div>
      <div class="msn-grid-3"><label>위도 ° <input data-field="params.latitude" type="number" step="0.0001" min="-90" max="90" value="${esc(p.latitude)}"></label><label>경도 ° <input data-field="params.longitude" type="number" step="0.0001" min="-180" max="180" value="${esc(p.longitude)}"></label><label>최대 관측각 ° <input data-field="params.max_off_nadir_deg" type="number" step="1" min="1" max="89" value="${esc(p.max_off_nadir_deg)}"></label></div>
      <div class="msn-grid-3"><label>산출물 MB <input data-field="params.product_mb" type="number" step="10" min="1" value="${esc(p.product_mb)}"></label><label class="msn-check"><input type="checkbox" data-field="params.processing" ${p.processing !== false ? "checked" : ""}> 궤도상 처리</label><label>결과 비율 <input data-field="params.processing_ratio" type="number" step="0.05" min="0.05" max="1" value="${esc(p.processing_ratio)}"></label></div>
      <div class="msn-grid-2"><label>담당 위성 <select data-field="params.preferred_satellite">${optionList(satelliteOptions(node => satelliteCapabilities(node).camera), p.preferred_satellite, "자동 배정 (촬영 장비 보유)")}</select></label><label>인도 지상국 <select data-field="params.station">${optionList(stationOptions(), p.station, "가장 빠른 지상국")}</select></label></div>`;
  }
  if (kind === "compute") {
    return `<div class="msn-grid-2"><label>처리 위성 <select data-field="params.source_satellite">${optionList(satelliteOptions(), p.source_satellite, "자동 배정")}</select></label><label>인도 지상국 <select data-field="params.station">${optionList(stationOptions(), p.station, "가장 빠른 지상국")}</select></label></div>
      <div class="msn-grid-2"><label>입력 데이터 MB <input data-field="params.input_mb" type="number" step="100" min="1" value="${esc(p.input_mb)}"></label><label>결과 비율 <input data-field="params.output_ratio" type="number" step="0.05" min="0.01" max="1" value="${esc(p.output_ratio)}"></label></div>`;
  }
  if (kind === "relay") {
    return `<div class="msn-grid-2"><label>출발 <select data-field="params.source">${optionList(endpointOptions(), p.source, "고르세요")}</select></label><label>도착 <select data-field="params.destination">${optionList(endpointOptions(), p.destination, "고르세요")}</select></label></div>
      <div class="msn-grid-2"><label>전송량 MB <input data-field="params.volume_mb" type="number" step="10" min="0.1" value="${esc(p.volume_mb)}"></label><label>지연 한계 ms (0=없음) <input data-field="params.max_latency_ms" type="number" step="1" min="0" value="${esc(p.max_latency_ms)}"></label></div>`;
  }
  if (kind === "pickup") {
    const chosen = p.external_id ? `<div class="msn-external"><b>${esc(p.external_name || p.external_id)}</b><small>NORAD ${esc(p.external_id)}${p.external_item?.ORBIT_REGIME ? ` · ${esc(p.external_item.ORBIT_REGIME)}` : ""}${p.external_item?.EPOCH ? ` · GP ${esc(String(p.external_item.EPOCH).slice(0, 10))}` : ""}</small></div>` : `<div class="msn-empty small">대시보드 카탈로그(GP)에서 외부 위성을 검색해 고르세요.</div>`;
    const results = searchResults.length ? `<div class="msn-search-results">${searchResults.map(item => `<button type="button" data-external="${esc(item.NORAD_CAT_ID)}"><b>${esc(item.OBJECT_NAME)}</b><small>NORAD ${esc(item.NORAD_CAT_ID)} · ${esc(item.ORBIT_REGIME || "—")} · ${esc(displayNumber(item.PERIGEE_KM, 0))}~${esc(displayNumber(item.APOGEE_KM, 0))} km</small></button>`).join("")}</div>` : "";
    return `<label>외부 위성 검색 <input id="msn-external-search" type="search" placeholder="위성명 또는 NORAD 번호" autocomplete="off"></label>${results}${chosen}
      <div class="msn-grid-3"><label>수신량 MB <input data-field="params.volume_mb" type="number" step="50" min="0.1" value="${esc(p.volume_mb)}"></label><label>교차링크 Mbps <input data-field="params.crosslink_rate_mbps" type="number" step="5" min="0.1" value="${esc(p.crosslink_rate_mbps)}"></label><label>최대 거리 km <input data-field="params.max_range_km" type="number" step="100" min="10" value="${esc(p.max_range_km)}"></label></div>
      <label>인도 지상국 <select data-field="params.station">${optionList(stationOptions(), p.station, "가장 빠른 지상국")}</select></label>`;
  }
  return `<div class="msn-grid-3"><label>이미지 MB <input data-field="params.image_mb" type="number" step="10" min="0.1" value="${esc(p.image_mb)}"></label><label>적용 시간 s <input data-field="params.apply_s" type="number" step="30" min="1" value="${esc(p.apply_s)}"></label><label>동시 적용 수 <input data-field="params.max_concurrent" type="number" step="1" min="1" value="${esc(p.max_concurrent)}"></label></div>
    <label>대상 위성 <small>(비우면 전체)</small> <select data-field="params.satellites" multiple size="6">${satelliteOptions().map(([value, label]) => `<option value="${esc(value)}" ${(p.satellites || []).includes(value) ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></label>`;
}

function formMarkup(state) {
  const v = state.values;
  const kindTabs = Object.entries(MISSION_KINDS).map(([key, kind]) => `<button type="button" data-form-kind="${key}" aria-pressed="${state.kind === key}" title="${esc(kind.note)}">${esc(kind.short)}</button>`).join("");
  const deadlineHours = v.deadline_hours;
  return `<header class="msn-detail-head"><span class="msn-kicker">${state.mode === "edit" ? `임무 편집 · ${esc(state.id)}` : "새 임무 요청"}</span><h3>${esc(MISSION_KINDS[state.kind].label)}</h3><p class="msn-note">${esc(MISSION_KINDS[state.kind].note)}</p></header>
    <div class="msn-kind-tabs" role="group" aria-label="임무 종류">${kindTabs}</div>
    <form id="msn-form" class="msn-form" novalidate>
      <div class="msn-grid-2"><label>임무 이름 <input data-field="name" value="${esc(v.name)}" maxlength="60" placeholder="비우면 자동 이름"></label><label>요청 기관 <input data-field="requester" value="${esc(v.requester)}" maxlength="40"></label></div>
      <div class="msn-grid-3"><label>우선순위 <select data-field="priority">${optionList(Object.entries(PRIORITY_LABELS).map(([value, label]) => [value, `${value} · ${label}`]), v.priority)}</select></label><label>기한 <select data-field="deadline_hours">${optionList([...DEADLINE_PRESETS.map(([hours, label]) => [hours, label]), ["custom", "직접 입력"]], deadlineHours)}</select></label><label>기한 UTC <input data-field="deadline" type="datetime-local" step="60" value="${esc(v.deadline)}" ${deadlineHours === "custom" ? "" : "disabled"}></label></div>
      ${kindFields(state.kind, v)}
      <ul class="msn-errors" hidden></ul>
      <div class="msn-actions"><button type="button" data-form-cancel>취소</button><span class="msn-spacer"></span><button type="submit" class="msn-primary">${state.mode === "edit" ? "저장 후 다시 계획" : "등록하고 계획 만들기"}</button></div>
    </form>`;
}

function detailMarkup(mission) {
  const now = clock.now().getTime();
  const phase = missionPhase(mission, now);
  const kind = kindOf(mission);
  const plan = mission.plan;
  const summary = plan?.summary || {};
  const deadline = timeOf(mission.deadline);
  const reconfigure = needsReconfiguration(mission);
  const p = mission.params || {};
  const request = mission.kind === "observe" ? `${p.target_name} (${displayNumber(p.latitude, 3)}°, ${displayNumber(p.longitude, 3)}°) · 최대 관측각 ${p.max_off_nadir_deg}° · 산출물 ${displayNumber(p.product_mb, 0)} MB${p.processing !== false ? ` · 궤도상 처리 ${Math.round(p.processing_ratio * 100)}%` : ""}`
    : mission.kind === "compute" ? `${p.source_satellite ? nameOf(p.source_satellite) : "자동 배정"} · 입력 ${displayNumber(p.input_mb, 0)} MB · 결과 ${Math.round(p.output_ratio * 100)}%`
      : mission.kind === "relay" ? `${nameOf(p.source)} → ${nameOf(p.destination)} · ${displayNumber(p.volume_mb, 0)} MB${p.max_latency_ms ? ` · 지연 한계 ${p.max_latency_ms} ms` : ""}`
        : mission.kind === "pickup" ? `${p.external_name || p.external_id} (NORAD ${p.external_id}) · ${displayNumber(p.volume_mb, 0)} MB · 교차링크 ${p.crosslink_rate_mbps} Mbps · ${displayNumber(p.max_range_km, 0)} km 이내`
          : `이미지 ${displayNumber(p.image_mb, 0)} MB · 적용 ${p.apply_s} s · 동시 ${p.max_concurrent}기 · 대상 ${(p.satellites || []).length || "전체"}기`;
  const actions = [];
  if (phase.status === "draft" || phase.status === "planned") actions.push(`<button data-action="plan" class="msn-primary">${plan ? "다시 계획" : "계획 생성"}</button>`);
  if (phase.status === "planned" && plan?.feasible) actions.push(`<button data-action="commit" class="msn-commit">실행</button>`);
  if (phase.status === "planned" && plan && !plan.feasible) actions.push(`<button data-action="commit" title="검토를 통과하지 못한 계획을 그대로 실행합니다">그래도 실행</button>`);
  if (phase.status === "committed") actions.push(`<button data-action="plan">재계획</button>`, `<button data-action="abort" class="danger">중단</button>`);
  if (reconfigure.length) actions.push(`<button data-action="reconfigure" class="msn-primary">재구성 (${reconfigure.map(nameOf).join(", ")} 제외)</button>`);
  if (["draft", "planned"].includes(phase.status)) actions.push(`<button data-action="edit">편집</button>`);
  if (phase.status === "aborted" || phase.status === "completed" || phase.status === "failed") actions.push(`<button data-action="reopen">다시 계획으로</button>`);
  actions.push(`<button data-action="duplicate">복제</button>`, `<button data-action="remove" class="danger">삭제</button>`);
  const path = summary.path?.length && mission.kind !== "fleet_update" ? `<div class="msn-path">${summary.path.map((id, index) => `${index ? '<i>→</i>' : ""}<span>${esc(nameOf(id))}</span>`).join("")}</div>` : "";
  const finish = summary.finish_at ? timeOf(summary.finish_at) : null;
  return `<header class="msn-detail-head"><span class="msn-kicker">${esc(kind.label)} · ${esc(mission.id)} · ${esc(mission.requester)}</span><h3>${esc(mission.name)}</h3>
      <div class="msn-tags"><span class="msn-chip ${esc(phase.tone)}">${esc(phase.label)}</span><span class="msn-chip neutral">우선순위 ${esc(mission.priority)} · ${esc(PRIORITY_LABELS[mission.priority])}</span>${plan ? `<span class="msn-chip ${plan.feasible ? "ok" : "danger"}">${plan.feasible ? "검토 통과" : "실행 불가"}</span>` : ""}${reconfigure.length ? `<span class="msn-chip danger">재구성 필요</span>` : ""}</div>
      <div class="msn-actions wrap">${actions.join("")}</div></header>
    <section class="msn-section"><h4>요청</h4><p class="msn-request">${esc(request)}</p>
      <dl class="msn-values"><div><dt>계획 창</dt><dd>${esc(utcLabel(mission.window_start).slice(5, 16))} → ${esc(utcLabel(mission.deadline).slice(5, 16))} UTC</dd></div><div><dt>기한까지</dt><dd class="${deadline !== null && deadline < now ? "warn" : ""}">${deadline === null ? "—" : deadline >= now ? `${esc(displayNumber((deadline - now) / 3600_000, 2))} h` : "지남"}</dd></div></dl></section>
    <section class="msn-section"><h4>군집 운용 모듈 판정 <small>ICD-03</small></h4>${plan ? `<dl class="msn-values"><div><dt>완료 예정</dt><dd>${finish !== null ? `${esc(utcLabel(finish).slice(5, 16))} UTC` : "—"}</dd></div><div><dt>기한 여유</dt><dd class="${(summary.margin_s ?? 0) < 0 ? "warn" : ""}">${summary.margin_s != null ? `${esc(displayNumber(summary.margin_s / 60, 0))}분` : "—"}</dd></div><div><dt>작업 · 위성</dt><dd>${esc(summary.task_count ?? 0)}개 · ${esc(summary.satellites?.length ?? 0)}기</dd></div><div><dt>데이터량</dt><dd>${esc(displayNumber(summary.volume_mb, 0))} MB</dd></div>${summary.latency_ms != null ? `<div><dt>종단 지연</dt><dd>${esc(displayNumber(summary.latency_ms, 1))} ms</dd></div>` : ""}${summary.updated != null ? `<div><dt>갱신 위성</dt><dd>${esc(summary.updated)}/${esc(summary.requested)}기 · 동시 최대 ${esc(summary.max_parallel)}기</dd></div>` : ""}</dl>${path}${plan.reasons?.length ? `<ul class="msn-reasons">${plan.reasons.map(reason => `<li>${esc(reason)}</li>`).join("")}</ul>` : ""}` : `<div class="msn-empty small">계획이 없습니다.</div>`}</section>
    <section class="msn-section"><h4>진행 <small>${esc(Math.round(phase.progress * 100))}%</small></h4><i class="msn-progress"><b style="width:${Math.round(phase.progress * 100)}%"></b></i>
      ${plan?.tasks?.length ? `<div class="msn-chain">${plan.tasks.map(task => { const status = mission.status === "committed" ? taskStatusAt(task, now) : "planned"; return `<button class="msn-task ${esc(status)} ${selectedTaskId === task.id ? "selected" : ""}" data-detail-task="${esc(task.id)}" style="--mt-color:${esc(TASK_KINDS[task.kind]?.color || "#8ea4b8")}"><b>${esc(TASK_KINDS[task.kind]?.label || task.kind)}</b><small>${esc(nameOf(task.satellite))}${task.counterpart ? ` → ${esc(nameOf(task.counterpart))}` : ""} · ${esc(utcLabel(task.start).slice(11, 16))}</small></button>`; }).join("")}</div>` : ""}</section>
    <p class="msn-note">창과 위성 상태는 디지털 트윈의 Kepler+J2 기하와 노드 모델에서, 작업 배정과 판정은 군집 운용 모듈에서 옵니다. 실측이 아닙니다.</p>`;
}

function renderDetail() {
  const host = $("#msn-detail");
  const title = $("#msn-detail-title");
  if (formState) { title.textContent = formState.mode === "edit" ? "임무 편집" : "새 임무"; host.innerHTML = formMarkup(formState); bindForm(); return; }
  const mission = missionStore.selected;
  if (!mission) { title.textContent = "선택 임무"; host.innerHTML = `<div class="msn-empty tall">왼쪽 목록에서 임무를 고르거나 <b>＋ 새 임무</b>를 누르세요.</div>`; return; }
  title.textContent = "선택 임무";
  host.innerHTML = detailMarkup(mission);
  host.querySelectorAll("[data-action]").forEach(button => button.addEventListener("click", () => missionAction(mission.id, button.dataset.action)));
  host.querySelectorAll("[data-detail-task]").forEach(button => button.addEventListener("click", () => { selectedTaskId = button.dataset.detailTask; renderTimeline(); renderTaskTable(); renderDetail(); }));
}

/* ---------- form behaviour ---------- */

function localInput(value) {
  const time = timeOf(value);
  return time === null ? "" : new Date(time).toISOString().slice(0, 16);
}

function openForm(mode, mission = null) {
  const kind = mission?.kind || "observe";
  const now = clock.now();
  const values = mission
    ? { name: mission.name, requester: mission.requester, priority: mission.priority, deadline_hours: "custom", deadline: localInput(mission.deadline), params: { ...DEFAULT_PARAMS[kind], ...mission.params } }
    : { name: "", requester: "", priority: 3, deadline_hours: 6, deadline: localInput(now.getTime() + 6 * 3600_000), params: { ...DEFAULT_PARAMS[kind] } };
  if (!mission) values.requester = "";
  formState = { mode, id: mission?.id || null, kind, values };
  searchResults = [];
  renderDetail();
}

function closeForm() { formState = null; searchResults = []; renderDetail(); }

function readForm() {
  const form = $("#msn-form");
  const values = formState.values;
  form.querySelectorAll("[data-field]").forEach(input => {
    const path = input.dataset.field;
    let value;
    if (input.type === "checkbox") value = input.checked;
    else if (input.multiple) value = [...input.selectedOptions].map(option => option.value);
    else if (input.type === "number") value = input.value === "" ? "" : Number(input.value);
    else value = input.value;
    if (path.startsWith("params.")) values.params[path.slice(7)] = value; else values[path] = value;
  });
  if (values.deadline_hours !== "custom") values.deadline = localInput(clock.now().getTime() + Number(values.deadline_hours) * 3600_000);
}

function switchFormKind(kind) {
  readForm();
  formState.kind = kind;
  formState.values.params = { ...DEFAULT_PARAMS[kind], ...(formState.mode === "edit" && missionStore.find(formState.id)?.kind === kind ? missionStore.find(formState.id).params : {}) };
  searchResults = [];
  renderDetail();
}

async function searchExternal(query) {
  const text = String(query || "").trim();
  if (text.length < 2) { searchResults = []; return; }
  try {
    const payload = await api.satellites({ group: "active", query: text, limit: 8 });
    searchResults = (payload.items || []).filter(item => item.MEAN_MOTION && item.EPOCH);
  } catch (error) {
    searchResults = [];
    toast("error", "위성 검색 실패", error.message);
  }
  readForm();
  renderDetail();
  const input = $("#msn-external-search");
  if (input) { input.value = text; input.focus(); input.setSelectionRange(text.length, text.length); }
}

function bindForm() {
  const form = $("#msn-form");
  if (!form) return;
  $("#msn-detail").querySelectorAll("[data-form-kind]").forEach(button => button.addEventListener("click", () => switchFormKind(button.dataset.formKind)));
  form.querySelector("[data-form-cancel]").addEventListener("click", closeForm);
  form.querySelector('[data-field="deadline_hours"]').addEventListener("change", event => { readForm(); const input = form.querySelector('[data-field="deadline"]'); input.disabled = event.target.value !== "custom"; if (event.target.value !== "custom") input.value = formState.values.deadline; });
  form.querySelector('[data-field="params.target"]')?.addEventListener("change", event => {
    const preset = TARGET_PRESETS.find(item => item.key === event.target.value);
    if (!preset) return;
    form.querySelector('[data-field="params.target_name"]').value = preset.name;
    form.querySelector('[data-field="params.latitude"]').value = preset.latitude;
    form.querySelector('[data-field="params.longitude"]').value = preset.longitude;
  });
  const search = $("#msn-external-search");
  if (search) search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => searchExternal(search.value), 350); });
  $("#msn-detail").querySelectorAll("[data-external]").forEach(button => button.addEventListener("click", () => {
    const item = searchResults.find(result => String(result.NORAD_CAT_ID) === button.dataset.external);
    if (!item) return;
    readForm();
    formState.values.params.external_id = String(item.NORAD_CAT_ID);
    formState.values.params.external_name = item.OBJECT_NAME;
    formState.values.params.external_item = item;
    searchResults = [];
    renderDetail();
  }));
  form.addEventListener("submit", event => { event.preventDefault(); submitForm(); });
}

async function submitForm() {
  readForm();
  const v = formState.values;
  const context = { satellites: satellites(), stations: stations() };
  const deadlineIso = v.deadline ? new Date(`${v.deadline}:00Z`).toISOString() : null;
  const partial = { kind: formState.kind, name: v.name, requester: v.requester || undefined, priority: Number(v.priority), window_start: clock.now().toISOString(), deadline: deadlineIso, params: v.params };
  if (partial.kind === "observe" && partial.params.target) { const preset = TARGET_PRESETS.find(item => item.key === partial.params.target); if (preset && !partial.params.target_name) partial.params.target_name = preset.name; }
  if (!String(partial.name || "").trim()) partial.name = defaultName(partial.kind, partial.params);
  let id = formState.id;
  let errors = [];
  if (formState.mode === "edit") errors = missionStore.update(id, partial, context);
  else { const result = missionStore.add(partial, context); errors = result.errors; id = result.mission?.id || null; }
  const list = $("#msn-form .msn-errors");
  if (errors.length) { list.innerHTML = errors.map(error => `<li>${esc(error)}</li>`).join(""); list.hidden = false; return; }
  formState = null; searchResults = [];
  missionStore.select(id);
  renderAll();
  await planMission(id, { reason: formState?.mode === "edit" ? "재계획" : "계획 생성" });
}

// Default mission name with the operator's satellite and station names rather than ids.
function defaultName(kind, params) {
  const label = MISSION_KINDS[kind]?.label || kind;
  if (kind === "relay") return `${label} · ${nameOf(params.source)} → ${nameOf(params.destination)}`;
  if (kind === "compute") return `${label} · ${params.source_satellite ? nameOf(params.source_satellite) : "자동 배정"}`;
  if (kind === "fleet_update") return `${label} · ${(params.satellites || []).length || "전체"}기`;
  return missionLabel({ kind, params });
}

/* ---------- actions ---------- */

async function missionAction(id, action) {
  const mission = missionStore.find(id);
  if (!mission) return;
  if (action === "plan") await planMission(id, { reason: mission.plan ? "재계획" : "계획 생성" });
  if (action === "reconfigure") await planMission(id, { exclude: needsReconfiguration(mission).filter(item => !item.includes("|")), reason: "재구성" });
  if (action === "commit") {
    try {
      const ack = await missionPlanner.commit(mission, "commit");
      missionStore.setStatus(id, "committed", `${mission.name} 실행 승인 · 계획 v${mission.plan?.version || 1} · 모듈 점유 ${ack.held_tasks ?? 0}개 (OR-03)`);
      toast("success", "임무 실행", `${mission.name} · ${mission.plan?.tasks?.length || 0}개 작업`);
    } catch (error) { toast("error", "실행 확정 통보 실패", `군집 운용 모듈이 확정을 받지 못했습니다: ${error.message}`); }
  }
  if (action === "abort") {
    if (!confirm(`${mission.name} 임무를 중단할까요? 남은 작업은 취소됩니다.`)) return;
    try {
      await missionPlanner.commit(mission, "abort");
      missionStore.setStatus(id, "aborted", `${mission.name} 운용자 중단 (OR-03 통보)`); toast("warning", "임무 중단", mission.name);
    } catch (error) { toast("error", "중단 통보 실패", `군집 운용 모듈이 중단을 받지 못했습니다: ${error.message}`); }
  }
  if (action === "reopen") { missionStore.setStatus(id, mission.plan ? "planned" : "draft", `${mission.name} 계획 단계로 되돌림`); }
  if (action === "edit") openForm("edit", mission);
  if (action === "duplicate") { const copy = missionStore.duplicate(id); if (copy) toast("success", "임무 복제", copy.name); }
  if (action === "remove") { if (!confirm(`${mission.name} 임무를 삭제할까요?`)) return; missionStore.remove(id); toast("warning", "임무 삭제", mission.name); }
  renderAll();
}

/* ---------- render all and ticks ---------- */

function renderAll() {
  renderSummary(); renderList(); renderModuleChip(); renderPlanningState(); renderTimeline(); renderChecks(); renderTaskTable(); renderLog(); renderDetail();
}

function tick() {
  renderClock();
  if (!active) return;
  moveNowLine();
  const seconds = Math.floor(Date.now() / 1000);
  if (seconds % 5 === 0) { renderSummary(); renderList(); renderTaskTable(); if (!formState) renderDetail(); }
}

function changeTime(action) { action(); renderClock(); renderAll(); }

function bind() {
  $("#msn-new").addEventListener("click", () => openForm("new"));
  document.querySelectorAll("[data-msn-filter]").forEach(button => button.addEventListener("click", () => { listFilter = button.dataset.msnFilter; document.querySelectorAll("[data-msn-filter]").forEach(item => item.setAttribute("aria-pressed", String(item === button))); renderList(); }));
  $("#msn-list").addEventListener("click", event => { const row = event.target.closest("[data-msn-id]"); if (!row) return; formState = null; selectedTaskId = null; missionStore.select(row.dataset.msnId); });
  $("#msn-timeline").addEventListener("click", event => {
    const task = event.target.closest("[data-timeline-task]");
    if (!task) return;
    selectedTaskId = task.dataset.timelineTask;
    if (missionStore.selectedId !== task.dataset.timelineMission) { formState = null; missionStore.select(task.dataset.timelineMission); } else { renderTimeline(); renderTaskTable(); renderDetail(); }
  });
  $("#msn-tasks").addEventListener("click", event => { const row = event.target.closest("[data-msn-task]"); if (!row) return; selectedTaskId = row.dataset.msnTask; renderTimeline(); renderTaskTable(); renderDetail(); });
  $("#msn-hours").addEventListener("change", event => { timelineHours = Number(event.target.value) || 12; renderTimeline(); });
  document.querySelectorAll("[data-msn-rows]").forEach(button => button.addEventListener("click", () => { rowFilter = button.dataset.msnRows; document.querySelectorAll("[data-msn-rows]").forEach(item => item.setAttribute("aria-pressed", String(item === button))); renderTimeline(); }));
  $("#msn-windows").addEventListener("click", async () => {
    if (!satellites().length) { toast("warning", "접속창 계산", "배치된 위성이 없습니다."); return; }
    planning = { missionId: null, stage: "windows" }; renderPlanningState();
    try { missionPlanner.invalidateWindows(); const windows = await missionPlanner.ensureWindows(clock.now().getTime(), Math.max(timelineHours, 2)); toast("success", "접속창 계산", `${windows.contacts.length}개 접속창, 식 ${windows.eclipses.length}회`); }
    finally { planning = null; renderPlanningState(); renderTimeline(); }
  });
  $("#msn-clock-pause").addEventListener("click", () => changeTime(() => clock.running ? clock.pause() : clock.play()));
  $("#msn-clock-now").addEventListener("click", () => changeTime(() => clock.live()));
  $("#msn-clock-back").addEventListener("click", () => changeTime(() => clock.step(-600)));
  $("#msn-clock-forward").addEventListener("click", () => changeTime(() => clock.step(600)));
  $("#msn-clock-speed").addEventListener("change", event => changeTime(() => clock.setSpeed(Number(event.target.value))));
  window.addEventListener("spacetwin:themechange", () => renderTimeline());
  // Redraw when the schedule area changes size: the window resize event fires at once, the
  // ResizeObserver also covers layout changes that do not resize the window (panel toggles).
  const refit = () => {
    const host = $("#msn-timeline");
    const svg = host?.querySelector("svg");
    if (!svg) return;
    const rowCount = svg.querySelectorAll(".mt-row").length;
    if (Math.abs(timelineWidth(host) - lastTimelineWidth) > 2 || timelineRowHeight(host, rowCount) !== lastTimelineRowHeight) renderTimeline();
  };
  window.addEventListener("resize", refit);
  if (typeof ResizeObserver === "function") new ResizeObserver(refit).observe($("#msn-timeline"));
}

function onStoreChange(event) {
  if (event === "select") { selectedTaskId = null; renderAll(); return; }
  if (event === "add" || event === "update" || event === "remove" || event === "plan" || event === "status" || event === "log") renderAll();
}

function setActive(next) {
  active = next;
  clearInterval(tickTimer); tickTimer = null;
  clearInterval(statusTimer); statusTimer = null;
  if (!active) return;
  renderAll();
  pollStatus();
  tickTimer = setInterval(tick, 1000);
  statusTimer = setInterval(pollStatus, STATUS_POLL_MS);
}

export function initMission() {
  view = $("#view-mission");
  if (!view || !$("#msn-list")) return;
  clock = new OrbitClock();
  orchestration = missionPlanner.orchestration;
  missionPlanner.setTimeSource(() => clock.now());
  missionStore.load();
  missionStore.subscribe(onStoreChange);
  constellation.subscribe(event => { if (event === "deploy" || event === "load") { missionPlanner.invalidateWindows(); if (active) renderAll(); } });
  groundSegment.subscribe(event => { if (event !== "select") { missionPlanner.invalidateWindows(); if (active) renderAll(); } });
  bind();
  renderClock();
  new MutationObserver(() => { const isActive = view.classList.contains("active"); if (isActive !== active) setActive(isActive); }).observe(view, { attributes: true, attributeFilter: ["class"] });
  if (view.classList.contains("active")) setActive(true);
  window.addEventListener("pagehide", () => { clearInterval(tickTimer); clearInterval(statusTimer); clearTimeout(searchTimer); });
}

// The runtime's active faults are read when a plan is built; server telemetry has no other authority here.
export function updateMissionTelemetry() {}
