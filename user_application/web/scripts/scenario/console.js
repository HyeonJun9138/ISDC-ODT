// The scenario console: the topbar button and dialog to pick and set up a PoC scenario, the dock
// that follows the playback (steps, narrative, module flows, checks, ICD message log, transport)
// and the guide card that opens on the tab a step points at. Rendering only; the player
// (runner.js) owns the playback state and the modules own every judgement shown here.
import { api } from "/static/communication/api.js?v=20260908-scenario1";
import { comparisonRows, PHASES } from "/static/verification/scenario_kpi.js?v=20260908-scenario3";
import { emit, on, store } from "../state.js";
import { constellation } from "../nodes/constellation.js";
import { dataDeployment } from "../nodes/deployment_client.js";
import { groundSegment } from "../communication/ground_segment.js";
import { networkTwin } from "../communication/network_twin.js";
import { missionStore } from "../missions/mission_store.js";
import { missionPlanner } from "../missions/planner_client.js";
import { escapeMarkup as esc, utcLabel } from "../orbit/catalog.js";
import { loadSatelliteModels } from "../orbit/satellite_models.js";
import { moduleById } from "../settings/topology.js?v=20260908-scenario1";
import { createScenarioClock } from "./clock.js?v=20260908-scenario3";
import { createScenarioRunner } from "./runner.js?v=20260908-scenario3";

// Display-model labels for the dialog facts; the key itself is shown until the manifest arrives.
let modelLabels = new Map();
loadSatelliteModels().then(manifest => {
  if (manifest) modelLabels = new Map(manifest.models.map(model => [model.key, `${model.label} (${model.provider === "nasa" ? "NASA 3D Resources" : model.provider || "대표 형상"})`]));
});
const modelLabel = key => modelLabels.get(key) || key;

const $ = selector => document.querySelector(selector);
const TAB_LABELS = { orbit: "대시보드", nodes: "노드", communication: "통신", data: "데이터", security: "보안", mission: "임무", status: "상태", settings: "설정" };
const PHASE_LABELS = { idle: "선택 안 함", selected: "선택됨", preparing: "세팅 중", ready: "준비 완료", playing: "재생 중", paused: "일시정지", finished: "판정 완료", stale: "이전 실행" };

let runner = null;
let clock = null;
let telemetryAt = null;
let catalogue = [];
let chosenId = null;
let guideDismissedFor = null;
let dockCollapsed = false;
let renderTimer = null;

const toast = (type, title, message) => emit("toast", { type, title, message });
const moduleName = id => moduleById(id)?.name || id;
const elapsedLabel = seconds => { const total = Math.max(0, Math.floor(Number(seconds) || 0)); return `T+${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`; };

/* ---------- dialog ---------- */

async function openDialog() {
  const dialog = $("#scenario-dialog");
  if (!dialog) return;
  try { catalogue = await runner.list(); }
  catch (error) { toast("error", "시나리오 목록", error.message); return; }
  chosenId = runner.state.scenarioId || catalogue[0]?.id || null;
  renderDialog();
  if (!dialog.open) dialog.showModal();
}

function renderDialog() {
  const list = $("#scenario-list");
  const detail = $("#scenario-detail");
  const actions = $("#scenario-dialog-actions");
  if (!list || !detail) return;
  const view = runner.view();
  list.innerHTML = catalogue.map(item => `<button type="button" class="sc-item" role="option" aria-selected="${item.id === chosenId}" data-scenario="${esc(item.id)}"><b>${esc(item.name)}</b><small>${esc(item.description)}</small><span>위성 ${esc(item.satellites)}기 · 지상국 ${esc(item.stations)} · 임무 ${esc(item.missions)} · ${esc(item.steps?.length || 0)}단계 · 약 ${esc(item.duration_minutes)}분</span></button>`).join("") || `<div class="sc-empty">재생할 수 있는 PoC 시나리오가 없습니다.</div>`;
  const item = catalogue.find(entry => entry.id === chosenId);
  if (!item) { detail.innerHTML = `<div class="sc-empty">시나리오를 고르세요.</div>`; actions.innerHTML = ""; return; }
  const definition = view.scenario?.id === item.id ? view.scenario : null;
  const loaded = view.scenarioId === item.id;
  detail.innerHTML = `
    <header><small>${esc(item.id)} · v${esc(item.version || "—")}</small><h3>${esc(item.name)}</h3><p>${esc(definition?.objective || item.description)}</p></header>
    <ol class="sc-flow">${(item.steps || []).map(step => `<li><b>${esc(step.order)}</b><span>${esc(step.title)}</span><small>${esc(step.summary || "")}</small></li>`).join("")}</ol>
    ${definition ? `<dl class="sc-facts">
      <div><dt>군집</dt><dd>${esc(definition.constellation.prefix)} · ${esc(definition.constellation.planes)}면 × ${esc(definition.constellation.per_plane)}기 · ${esc(definition.constellation.altitude_km)} km · ${esc(definition.constellation.inclination)}° · 승교점 폭 ${esc(definition.constellation.raan_spread)}°${definition.constellation.model_key ? ` · 표시 모델 ${esc(modelLabel(definition.constellation.model_key))}` : ""}</dd></div>
      <div><dt>역할</dt><dd>${Object.entries(definition.constellation.roles).slice(0, 4).map(([key, role]) => `${esc(role.label)} (면 ${role.plane + 1}, ${role.index + 1}번)`).join(" · ")}</dd></div>
      <div><dt>지상국</dt><dd>${esc(definition.stations.join(", "))}</dd></div>
      <div><dt>임무</dt><dd>${definition.missions.map(mission => `${esc(mission.name)}${mission.commit ? " (실행 확정)" : ""}`).join(" · ")}</dd></div>
      <div><dt>판정</dt><dd>${definition.criteria.map(group => `${esc(group.label)} ${group.rules.length}항목`).join(" · ")}</dd></div>
    </dl><p class="sc-note">${esc(definition.constellation.note || "")}</p>` : `<p class="sc-note">고르면 정의를 불러옵니다.</p>`}
    ${loaded ? `<p class="sc-state">현재 상태: <b>${esc(PHASE_LABELS[view.phase] || view.phase)}</b>${view.runId ? ` · 실행 ${esc(view.runId)}` : ""}</p>` : ""}`;
  const busy = view.phase === "preparing";
  actions.innerHTML = `
    <button type="button" class="button ghost" data-scenario-action="select" ${busy ? "disabled" : ""}>정의 불러오기</button>
    <button type="button" class="button primary" data-scenario-action="setup" ${busy ? "disabled" : ""}>${loaded && ["ready", "playing", "paused", "finished"].includes(view.phase) ? "다시 세팅" : "시나리오 세팅"}</button>
    <button type="button" class="button primary" data-scenario-action="play" ${loaded && ["ready", "paused"].includes(view.phase) ? "" : "disabled"}>재생</button>
    <button type="button" class="button ghost" value="cancel">닫기</button>`;
}

async function dialogAction(action) {
  if (!chosenId) return;
  try {
    if (action === "select") { await runner.select(chosenId); renderDialog(); return; }
    if (action === "setup") {
      if (runner.state.scenarioId !== chosenId || !runner.definition) await runner.select(chosenId);
      $("#scenario-dialog")?.close();
      showDock();
      await runner.setup();
      return;
    }
    if (action === "play") { $("#scenario-dialog")?.close(); showDock(); await runner.play(); }
  } catch (error) {
    console.warn("scenario action failed", error);
  }
}

/* ---------- dock ---------- */

function showDock() {
  const dock = $("#scenario-dock");
  if (!dock) return;
  dock.hidden = false;
  document.querySelector(".app-shell")?.classList.add("scenario-docked");
  renderDock();
}

function hideDock() {
  const dock = $("#scenario-dock");
  if (dock) dock.hidden = true;
  document.querySelector(".app-shell")?.classList.remove("scenario-docked");
  $("#scenario-guide").hidden = true;
}

function flowChips(flows) {
  return (flows || []).map(flow => `<span class="sd-flow"><b>${esc(moduleName(flow.from))}</b><i>→</i><b>${esc(moduleName(flow.to))}</b><em>${esc(flow.icd)}</em><small>${esc(flow.message)}</small></span>`).join("");
}

function checkRows(results) {
  return (results || []).map(check => `<li class="${check.pending ? "pending" : check.ok ? "ok" : "bad"}"><i></i><span>${esc(check.label)}</span><b>${esc(check.display)}</b><small>${esc(check.rule)}</small></li>`).join("");
}

function renderDock() {
  const dock = $("#scenario-dock");
  if (!dock || dock.hidden) return;
  const view = runner.view();
  dock.classList.toggle("collapsed", dockCollapsed);
  dock.dataset.phase = view.phase;
  $("#sd-name").textContent = view.scenario?.name || "시나리오";
  $("#sd-phase").textContent = PHASE_LABELS[view.phase] || view.phase;
  $("#sd-phase").dataset.phase = view.phase;
  $("#sd-elapsed").textContent = elapsedLabel(view.elapsed);
  $("#sd-utc").textContent = `${utcLabel(new Date(view.now))} UTC`;
  const playing = view.phase === "playing";
  $("#sd-play").textContent = playing ? "Ⅱ" : "▶";
  $("#sd-play").disabled = !["ready", "paused", "playing"].includes(view.phase);
  $("#sd-play").setAttribute("aria-label", playing ? "일시정지" : "재생");
  $("#sd-skip").disabled = view.phase !== "playing";
  const speed = $("#sd-speed");
  const speeds = view.scenario?.playback?.speeds || [1, 2, 5, 10, 30, 60];
  if (speed.options.length !== speeds.length) speed.innerHTML = speeds.map(value => `<option value="${value}">×${value}</option>`).join("");
  if (document.activeElement !== speed) speed.value = String(speeds.includes(view.speed) ? view.speed : speeds[0]);
  speed.disabled = !["ready", "paused", "playing"].includes(view.phase);
  $("#sd-follow").setAttribute("aria-pressed", String(view.autoFollow));
  $("#sd-result").disabled = !view.verdict;
  const steps = $("#sd-steps");
  steps.innerHTML = view.steps.map(step => `<li class="${esc(step.status)}" data-step="${esc(step.id)}" title="${esc(step.summary || "")}"><b>${esc(step.order)}</b><span>${esc(step.title)}</span><small>${step.firedAt != null ? elapsedLabel(step.firedAt) : step.due != null ? `예정 ${elapsedLabel(step.due)}` : "대기"}</small></li>`).join("");
  const body = $("#sd-body");
  if (view.phase === "preparing" || (view.phase === "selected" && view.setup.stage)) {
    body.innerHTML = `<div class="sd-setup"><h4>시나리오 세팅</h4><ol>${view.setup.stages.map(([key, label]) => `<li class="${view.setup.done.includes(key) ? "done" : view.setup.stage === key ? "active" : ""}"><i></i>${esc(label)}</li>`).join("")}</ol>${view.setup.error ? `<p class="sd-error">${esc(view.setup.error)}</p>` : ""}</div>`;
  } else if (view.phase === "stale") {
    body.innerHTML = `<div class="sd-setup"><h4>이전 실행의 시나리오</h4><p class="sd-note">서버 실행이 바뀌어 저장된 재생 상태를 이어갈 수 없습니다. 다시 세팅하세요.</p></div>`;
  } else {
    const step = view.steps.find(item => item.id === view.currentStep) || view.steps[0];
    const verdict = view.verdict;
    body.innerHTML = step ? `
      <div class="sd-current">
        <header><span class="sd-kicker">${esc(step.order)}단계 · ${esc(TAB_LABELS[step.tab] || step.tab)} 탭</span><h4>${esc(step.title)}</h4></header>
        <p class="sd-narrative">${esc(step.narrativeText)}</p>
        <div class="sd-flows">${flowChips(step.flows)}</div>
        ${step.checkResults?.length ? `<ul class="sd-checks">${checkRows(step.checkResults)}</ul>` : ""}
        <div class="sd-tabs">${(step.tabs || [step.tab]).map(tab => `<button type="button" data-goto-tab="${esc(tab)}">${esc(TAB_LABELS[tab] || tab)} 보기</button>`).join("")}</div>
      </div>
      <div class="sd-log"><h4>ICD 메시지 <small>최근</small></h4><ol>${[...view.log].filter(entry => !entry.quiet).slice(-7).reverse().map(entry => `<li class="${entry.error ? "error" : ""}"><b>${esc(elapsedLabel(entry.t))}</b><em>${esc(entry.icd)}</em><span>${esc(entry.direction)} · ${esc(entry.message)}</span><small>${esc(entry.summary)}</small></li>`).join("") || "<li><small>아직 메시지가 없습니다.</small></li>"}</ol></div>
      ${verdict ? `<div class="sd-verdict ${verdict.ok ? "ok" : "bad"}"><h4>복구 판정 <b>${verdict.passed}/${verdict.total}</b></h4>${verdict.groups.map(group => `<span class="${group.ok ? "ok" : "bad"}">${esc(group.label)} ${group.ok ? "통과" : "미달"}</span>`).join("")}</div>` : ""}` : `<div class="sd-setup"><p class="sd-note">재생을 누르면 1단계부터 진행합니다.</p></div>`;
  }
}

/* ---------- guide card ---------- */

function renderGuide(step, context) {
  const guide = $("#scenario-guide");
  if (!guide || !step) return;
  if (guideDismissedFor === step.id) return;
  const view = runner.view();
  const stepView = view.steps.find(item => item.id === step.id) || step;
  guide.hidden = false;
  guide.dataset.tab = step.tab;
  guide.innerHTML = `
    <header><span class="sg-kicker">${esc(step.order)}단계 / ${esc(view.steps.length)}</span><h3>${esc(step.title)}</h3><button type="button" class="sg-close" aria-label="안내 닫기" data-guide-close>×</button></header>
    <p>${esc(stepView.narrativeText || step.narrative)}</p>
    <div class="sg-flows">${flowChips(step.flows)}</div>
    <footer>
      <span class="sg-tab">지금 볼 화면: <b>${esc(TAB_LABELS[step.tab] || step.tab)}</b>${(step.tabs || []).length > 1 ? ` · 함께 볼 화면: ${step.tabs.filter(tab => tab !== step.tab).map(tab => TAB_LABELS[tab] || tab).join(", ")}` : ""}</span>
      <div>${(step.tabs || [step.tab]).map(tab => `<button type="button" data-goto-tab="${esc(tab)}" class="${tab === store.activeTab ? "current" : ""}">${esc(TAB_LABELS[tab] || tab)}</button>`).join("")}<button type="button" class="sg-primary" data-guide-close>확인</button></div>
    </footer>`;
  highlightTabs(step.tabs || [step.tab]);
}

function highlightTabs(tabs) {
  document.querySelectorAll(".nav-tab").forEach(button => button.classList.toggle("scenario-target", tabs.includes(button.dataset.tabTarget)));
}

/* ---------- result dialog ---------- */

function openResult() {
  const dialog = $("#scenario-result-dialog");
  const view = runner.view();
  if (!dialog || !view.verdict) return;
  const rows = comparisonRows(view.phases);
  const events = view.events;
  $("#scenario-result-body").innerHTML = `
    <div class="sr-summary ${view.verdict.ok ? "ok" : "bad"}"><strong>${view.verdict.ok ? "복구 판정 통과" : "복구 판정 미달"}</strong><span>${view.verdict.passed}/${view.verdict.total} 항목 · 실행 ${esc(view.runId)} · ${esc(view.scenario?.name)}</span></div>
    <div class="sr-groups">${view.verdict.groups.map(group => `<section class="${group.ok ? "ok" : "bad"}"><h4>${esc(group.label)} <b>${group.ok ? "통과" : "미달"}</b></h4><ul class="sd-checks">${checkRows(group.rules)}</ul></section>`).join("")}</div>
    <h4 class="detail-title">구간별 KPI 비교</h4>
    <div class="table-wrap sr-table"><table><thead><tr><th>지표</th>${PHASES.map(([, label]) => `<th>${esc(label)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr><td>${esc(row.label)}</td>${row.cells.map(cell => `<td>${esc(cell.display)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    <h4 class="detail-title">사건</h4>
    <dl class="detail-list compact"><div><dt>장애 주입</dt><dd>${events.fault_at_s != null ? `${elapsedLabel(events.fault_at_s)} · ${esc(events.fault_link || "")}` : "—"}</dd></div><div><dt>대체 경로 확인</dt><dd>${events.detour_available_at_s != null ? `${elapsedLabel(events.detour_available_at_s)} (재수렴 ${Math.round(events.detour_available_at_s - events.fault_at_s)} s)` : "—"}</dd></div><div><dt>재구성 요청</dt><dd>${events.reroute_at_s != null ? elapsedLabel(events.reroute_at_s) : "—"}</dd></div><div><dt>장애 해제</dt><dd>${events.fault_end_s != null ? elapsedLabel(events.fault_end_s) : "—"}</dd></div><div><dt>주 경로 복귀</dt><dd>${events.primary_restored_at_s != null ? elapsedLabel(events.primary_restored_at_s) : "—"}</dd></div></dl>
    <h4 class="detail-title">ICD 메시지 이력 <span class="badge neutral">${view.log.filter(entry => !entry.quiet).length}</span></h4>
    <div class="table-wrap sr-log"><table><thead><tr><th>시각</th><th>ICD</th><th>방향 · 메시지</th><th>내용</th></tr></thead><tbody>${view.log.filter(entry => !entry.quiet).map(entry => `<tr class="${entry.error ? "bad" : ""}"><td>${esc(elapsedLabel(entry.t))}</td><td>${esc(entry.icd)}</td><td>${esc(entry.direction)} · ${esc(entry.message)}</td><td class="wrap">${esc(entry.summary)}</td></tr>`).join("")}</tbody></table></div>
    <p class="sc-note">모든 값은 각 모듈이 ICD로 보고한 모의 계산이며 실측이 아닙니다. VF-03 결과 기록은 아래 버튼으로 JSON으로 저장할 수 있습니다.</p>`;
  if (!dialog.open) dialog.showModal();
}

function downloadRecord() {
  const record = runner.record();
  const blob = new Blob([JSON.stringify(record, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = `${record.scenario_id || "scenario"}-${(record.run_id || "run").replace(/[^A-Z0-9-]/gi, "")}.json`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- bindings ---------- */

function bind() {
  $("#scenario-button")?.addEventListener("click", openDialog);
  $("#run-chip")?.addEventListener("click", openDialog);
  $("#scenario-list")?.addEventListener("click", event => { const item = event.target.closest("[data-scenario]"); if (!item) return; chosenId = item.dataset.scenario; runner.select(chosenId).then(renderDialog).catch(error => toast("error", "시나리오 정의", error.message)); });
  $("#scenario-dialog-actions")?.addEventListener("click", event => { const button = event.target.closest("[data-scenario-action]"); if (button) dialogAction(button.dataset.scenarioAction); });
  $("#scenario-dialog")?.addEventListener("click", event => { if (event.target === event.currentTarget) event.currentTarget.close(); });
  $("#sd-play")?.addEventListener("click", () => (runner.state.phase === "playing" ? runner.pause() : runner.play()).catch(error => toast("error", "재생", error.message)));
  $("#sd-skip")?.addEventListener("click", () => runner.skipToNextStep().catch(error => toast("error", "다음 단계", error.message)));
  $("#sd-speed")?.addEventListener("change", event => runner.setSpeed(Number(event.target.value)).catch(error => toast("error", "배속", error.message)));
  $("#sd-follow")?.addEventListener("click", event => { runner.setAutoFollow(event.currentTarget.getAttribute("aria-pressed") !== "true"); });
  $("#sd-result")?.addEventListener("click", openResult);
  $("#sd-collapse")?.addEventListener("click", () => { dockCollapsed = !dockCollapsed; renderDock(); });
  $("#sd-open")?.addEventListener("click", openDialog);
  $("#sd-close")?.addEventListener("click", () => { if (runner.state.phase === "playing" && !confirm("재생 중인 시나리오를 중지할까요? 배치된 위성과 임무는 남습니다.")) return; runner.stop(); hideDock(); highlightTabs([]); renderChip(); });
  $("#scenario-dock")?.addEventListener("click", event => { const button = event.target.closest("[data-goto-tab]"); if (button) emit("tab:switch", button.dataset.gotoTab); });
  $("#scenario-guide")?.addEventListener("click", event => {
    const goto = event.target.closest("[data-goto-tab]");
    if (goto) { emit("tab:switch", goto.dataset.gotoTab); return; }
    if (event.target.closest("[data-guide-close]")) { guideDismissedFor = runner.state.currentStep; $("#scenario-guide").hidden = true; }
  });
  $("#scenario-result-dialog")?.addEventListener("click", event => { if (event.target === event.currentTarget) event.currentTarget.close(); if (event.target.closest("[data-result-download]")) downloadRecord(); });
  on("scenario:step", ({ step, context }) => { guideDismissedFor = null; renderGuide(step, context); renderDock(); });
  on("tab:switched", () => { const guide = $("#scenario-guide"); if (guide && !guide.hidden) renderGuide(runner.view().steps.find(item => item.id === runner.state.currentStep), runner.context()); });
}

function renderChip() {
  const chip = $("#scenario-chip-state");
  if (!chip) return;
  const view = runner.view();
  chip.textContent = view.phase === "idle" ? "선택 안 함" : `${PHASE_LABELS[view.phase] || view.phase}${["playing", "paused", "ready", "finished"].includes(view.phase) ? ` · ${elapsedLabel(view.elapsed)}` : ""}`;
  $("#scenario-button")?.classList.toggle("active", ["playing", "paused", "ready", "preparing", "finished"].includes(view.phase));
}

export function initScenario() {
  if (!$("#scenario-dock")) return;
  clock = createScenarioClock({
    runtime: () => store.runtime, receivedAt: () => telemetryAt,
    control: {
      pause: () => runner.pause().catch(() => {}), play: () => runner.play().catch(() => {}), setSpeed: speed => runner.setSpeed(speed).catch(() => {}),
      advance: seconds => runner.advance(seconds).catch(error => toast("error", "시계 전진", error.message)), refuse: message => toast("warning", "시나리오 시계", message),
    },
  });
  runner = createScenarioRunner({
    api, constellation, groundSegment, missionStore, dataDeployment, planner: missionPlanner, networkTwin, clock, storage: globalThis.localStorage || null, emit,
    switchTab: tab => emit("tab:switch", tab), runtime: () => store.runtime, pressSdcFilter: () => document.querySelector('[data-orbit-regime="SDC"]')?.click(),
    // Runtime answers to control requests refresh the console copy at once; telemetry frames follow.
    applyRuntime: status => { if (status?.run_id) { store.runtime = { ...store.runtime, ...status }; telemetryAt = Date.now(); } },
  });
  runner.setHostTab(() => store.activeTab);
  runner.subscribe(() => { clearTimeout(renderTimer); renderTimer = setTimeout(() => { renderDock(); renderChip(); }, 40); });
  bind();
  renderChip();
  runner.restore().then(restored => { if (restored && runner.state.phase !== "idle") { showDock(); renderChip(); } }).catch(error => console.warn("scenario restore failed", error));
  window.addEventListener("pagehide", () => runner.suspend());
}

export function updateScenarioTelemetry(payload) {
  if (payload?.runtime) telemetryAt = Date.now();
  runner?.onTelemetry?.();
  if (runner && !$("#scenario-dock")?.hidden) { $("#sd-elapsed").textContent = elapsedLabel(runner.view().elapsed); renderChip(); }
}

export function setScenarioActiveTab(tab) {
  emit("tab:switched", tab);
}
