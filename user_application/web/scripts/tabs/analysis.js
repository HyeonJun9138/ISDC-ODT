import { drawMultiLine } from "/static/visualization/charts.js";
import { emit, store } from "../state.js";

const $ = (selector) => document.querySelector(selector);
let replaying = false;
let replayTimer;
let selectedKpiId = "KPI-01";
let history = [];

const resultClass = (result) => result === "PASS" ? "success" : result === "FAIL" ? "danger" : "warning";

function activeFilters() {
  return new Set([...document.querySelectorAll("[data-result-filter]:checked")].map((input) => input.dataset.resultFilter));
}

function renderRequirements() {
  const filters = activeFilters();
  const items = (store.analytics.requirements || []).filter((item) => filters.has(item.result));
  $("#requirement-list").innerHTML = items.map((item, index) => `<article class="requirement-item ${index === 0 ? "active" : ""}" data-requirement-id="${item.id}" data-kpi-id="${item.kpi_id || ""}"><b>${item.id} · ${item.name}</b><small>${item.test} · ${item.evidence}</small><span class="badge ${resultClass(item.result)}">${item.result}</span></article>`).join("") || `<div class="empty-state">조건에 맞는 요구사항 없음</div>`;
  $("#requirement-list").querySelectorAll("[data-requirement-id]").forEach((item) => item.addEventListener("click", () => {
    $("#requirement-list").querySelectorAll(".requirement-item").forEach((el) => el.classList.toggle("active", el === item));
    if (item.dataset.kpiId) showKpiDetail(item.dataset.kpiId);
  }));
}

function renderKpis() {
  $("#kpi-grid").innerHTML = (store.analytics.kpis || []).map((item) => {
    const ratio = item.inverse ? Math.min(100, item.target / Math.max(.001, item.value) * 100) : Math.min(100, item.value / Math.max(.001, item.target) * 100);
    const color = item.status === "pass" ? "var(--green)" : item.status === "fail" ? "var(--red)" : "var(--orange)";
    return `<button class="kpi-card ${selectedKpiId === item.id ? "active" : ""}" data-kpi-id="${item.id}"><small>${item.id} · ${item.name}</small><strong>${item.value}<small>${item.unit}</small></strong><span class="target">기준 ${item.inverse ? "≤" : "≥"} ${item.target}${item.unit} · Δ ${item.delta > 0 ? "+" : ""}${item.delta}</span><div class="kpi-meter"><i style="width:${ratio}%;background:${color}"></i></div><span class="badge ${resultClass(item.status.toUpperCase())}">${item.status.toUpperCase()}</span></button>`;
  }).join("");
  $("#kpi-grid").querySelectorAll("[data-kpi-id]").forEach((button) => button.addEventListener("click", () => showKpiDetail(button.dataset.kpiId)));
  const verdict = store.analytics.verdict || "PENDING";
  const score = Number(store.analytics.overall || 0);
  $("#overall-score").textContent = score.toFixed(1);
  $("#overall-verdict").textContent = verdict;
  $("#overall-verdict").className = `verdict ${verdict.toLowerCase()}`;
  $(".score-bar i").style.width = `${score}%`;
  $("#verdict-run-id").textContent = store.analytics.run_id || "RUN-—";
  const provenance = store.analytics.provenance || {};
  $("#analysis-provenance").textContent = `${provenance.mode || "SIM"} · ${provenance.rule_set || "RULE—"} · ${provenance.data_quality || "UNKNOWN"}`;
}

function showKpiDetail(id) {
  selectedKpiId = id;
  const item = (store.analytics.kpis || []).find((kpi) => kpi.id === id);
  if (!item) return;
  $("#kpi-detail").innerHTML = `<h3>${item.id} · ${item.name}</h3><dl><div><dt>공식</dt><dd>${item.formula || "—"}</dd></div><div><dt>원천</dt><dd>${item.source || "—"}</dd></div><div><dt>표본</dt><dd>${item.samples ?? "—"}</dd></div><div><dt>결측률</dt><dd>${item.missing_percent ?? "—"}%</dd></div><div><dt>현재/기준</dt><dd>${item.value}${item.unit} / ${item.target}${item.unit}</dd></div><div><dt>판정</dt><dd><span class="badge ${resultClass(item.status.toUpperCase())}">${item.status.toUpperCase()}</span></dd></div></dl>`;
  renderKpis();
}

function renderTrace() {
  const reqs = store.analytics.requirements || [];
  $("#trace-body").innerHTML = reqs.map((item) => `<tr><td><b>${item.id}</b></td><td>${item.name}</td><td>${item.test}</td><td><span class="badge ${resultClass(item.result)}">${item.result}</span></td><td><button class="button tiny ghost" data-evidence="${item.evidence}">${String(item.evidence).slice(0, 16)}</button></td></tr>`).join("");
  const passCount = reqs.filter((item) => item.result === "PASS").length;
  $("#trace-summary").textContent = `${passCount} / ${reqs.length} PASS`;
  $("#trace-summary").className = `badge ${passCount === reqs.length ? "success" : "warning"}`;
  $("#trace-body").querySelectorAll("[data-evidence]").forEach((button) => button.addEventListener("click", () => emit("toast", { type: "success", title: "Run 증적", message: button.dataset.evidence })));
}

function renderEvents() {
  const events = (store.events || []).slice(0, 12);
  $("#analysis-event-list").innerHTML = events.map((item) => `<article class="event-item ${item.severity || "info"}"><b>${item.message}</b><small>seq ${item.sequence ?? "—"} · ${item.wall_time?.slice(11, 19) || "—"} UTC<br>${item.type}</small></article>`).join("") || `<div class="empty-state">기록 이벤트 없음</div>`;
}

function drawHistory(index = history.length - 1) {
  const visible = history.slice(0, Math.max(1, index + 1));
  const actual = visible.map((item) => item.telemetry.delay_ms || 0);
  const target = Array(actual.length).fill(50);
  const limit = Array(actual.length).fill(60);
  drawMultiLine($("#analysis-chart"), [actual, target, limit]);
  const selected = visible.at(-1);
  if (selected) {
    const seconds = selected.runtime.elapsed_seconds || 0;
    $("#replay-time").textContent = `T+${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  }
}

function setReplay(value) {
  const index = Math.max(0, Math.min(history.length - 1, Number(value)));
  $("#replay-range").value = String(index);
  drawHistory(index);
}

function toggleReplay() {
  replaying = !replaying;
  $("#replay-button").textContent = replaying ? "Ⅱ Pause" : "▶ History";
  clearInterval(replayTimer);
  if (replaying) replayTimer = setInterval(() => {
    let value = Number($("#replay-range").value) + 1;
    if (value >= history.length) value = 0;
    setReplay(value);
  }, 220);
}

function bind() {
  $("#replay-range").addEventListener("input", (event) => setReplay(event.target.value));
  $("#replay-button").addEventListener("click", toggleReplay);
  document.querySelectorAll("[data-result-filter]").forEach((input) => input.addEventListener("change", renderRequirements));
  window.addEventListener("resize", () => drawHistory(Number($("#replay-range").value)));
}

export function initAnalysis() {
  renderRequirements(); renderKpis(); renderTrace(); renderEvents(); drawHistory(); bind(); showKpiDetail(selectedKpiId);
}

export function updateAnalysisTelemetry(payload) {
  store.telemetry = payload.telemetry || store.telemetry;
  if (payload.events) store.events = payload.events;
  if (payload.analytics) store.analytics = payload.analytics;
  history.push({ wall_time: payload.wall_time, runtime: payload.runtime || {}, telemetry: payload.telemetry || {}, analytics: payload.analytics || {} });
  if (history.length > 300) history.shift();
  $("#replay-range").max = String(Math.max(0, history.length - 1));
  if (!replaying) $("#replay-range").value = $("#replay-range").max;
  renderKpis(); renderRequirements(); renderTrace(); renderEvents(); showKpiDetail(selectedKpiId);
  if (!replaying) drawHistory(history.length - 1);
}

