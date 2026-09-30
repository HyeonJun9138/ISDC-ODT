// 상태 탭. SIM 런타임 상태, 현재 텔레메트리, 활성 장애, 이벤트 이력, 데이터 출처를 한 화면에 모은다.
// 텔레메트리와 장애는 결정론적 SIM 값이고 이벤트는 현재 실행의 메모리 이력이다. 실측이 아니다.
import { store } from "../state.js";
import { escapeMarkup, faultLabel } from "./fault_dialog.js";

const $ = selector => document.querySelector(selector);
const TELEMETRY_FIELDS = [
  ["power", "전력", "%", 1], ["temperature", "온도", "°C", 1], ["attitude_error", "자세 오차", "°", 3], ["storage", "저장소", "%", 1],
  ["link_quality", "링크 품질", "%", 1], ["delay_ms", "지연", "ms", 1], ["loss_percent", "패킷 손실", "%", 2],
  ["throughput_mbps", "처리량", "Mbps", 1], ["ber", "BER", "", "exp"], ["auth_percent", "인증", "%", 2],
];
const SOURCE_LABELS = {
  "celestrak-live": "CelesTrak GP 수집", "celestrak-cache": "CelesTrak GP 캐시", "celestrak-stale": "CelesTrak GP 이전 스냅샷",
  "demo-fallback": "DEMO 대체", "upstream-unavailable": "GP 미제공",
};
const MAX_EVENTS = 40;

// Simulation clock as T+hh:mm:ss; negative or invalid input reads as T+00:00:00.
export function formatElapsed(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return `T+${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

// Known fields first with units and fixed digits, unknown numeric fields after them as they are.
export function telemetryRows(telemetry) {
  const source = telemetry && typeof telemetry === "object" ? telemetry : {};
  const rows = [];
  const seen = new Set();
  for (const [key, label, unit, digits] of TELEMETRY_FIELDS) {
    if (!(key in source)) continue;
    seen.add(key);
    const value = Number(source[key]);
    if (!Number.isFinite(value)) { rows.push([label, "—"]); continue; }
    const text = digits === "exp" ? value.toExponential(1) : value.toFixed(digits);
    rows.push([label, unit ? `${text} ${unit}` : text]);
  }
  for (const [key, raw] of Object.entries(source)) {
    if (seen.has(key)) continue;
    rows.push([key, typeof raw === "number" ? String(raw) : String(raw ?? "—")]);
  }
  return rows;
}

export function describeCatalog(catalog) {
  if (!catalog || typeof catalog !== "object" || !catalog.source) return { label: "카탈로그 미조회", detail: "—", tone: "neutral" };
  const label = SOURCE_LABELS[catalog.source] || catalog.source;
  const fetched = catalog.fetched_at ? String(catalog.fetched_at).replace("T", " ").slice(0, 16) : "—";
  const total = Number(catalog.total);
  const tone = catalog.source === "celestrak-live" || catalog.source === "celestrak-cache" ? "success" : "warning";
  return { label, detail: `${Number.isFinite(total) ? total.toLocaleString() : "—"}개 · 수집 UTC ${fetched}`, tone };
}

function renderRuntime() {
  const runtime = store.runtime || {};
  $("#status-run-mode").textContent = runtime.mode || "SIM";
  $("#status-runtime-cards").innerHTML = [
    ["Run", runtime.run_id || "—", ""],
    ["시나리오", `${runtime.scenario_id || "—"} · v${runtime.scenario_version || "—"}`, ""],
    ["상태", runtime.running ? "실행 중" : "일시정지", runtime.running ? "success" : "warning"],
    ["배속", `×${runtime.speed ?? 1}`, ""],
    ["경과", formatElapsed(runtime.elapsed_seconds), ""],
    ["데이터 품질", runtime.data_quality || "—", runtime.data_quality === "GOOD" ? "success" : "warning"],
    ["기록 플래그", runtime.recording ? "ON" : "OFF", ""],
    ["활성 장애", `${(runtime.active_faults || []).length}건`, (runtime.active_faults || []).length ? "danger" : "success"],
  ].map(([label, value, tone]) => `<article class="stat-card ${tone}"><small>${escapeMarkup(label)}</small><strong>${escapeMarkup(value)}</strong></article>`).join("");
}

function renderTelemetry() {
  const rows = telemetryRows(store.telemetry);
  $("#status-telemetry").innerHTML = rows.map(([label, value]) => `<div><dt>${escapeMarkup(label)}</dt><dd>${escapeMarkup(value)}</dd></div>`).join("") || `<div class="empty-state">텔레메트리 수신 전</div>`;
}

function renderFaults() {
  const faults = store.runtime?.active_faults || [];
  $("#status-faults").innerHTML = faults.map(fault => `<div class="list-item static"><span class="status-dot ${fault.severity === "high" ? "danger" : "warning"}"></span><span class="item-body"><b>${escapeMarkup(faultLabel(fault.kind))}</b><small>${escapeMarkup(fault.target)} · ${escapeMarkup(fault.severity)} · 남은 ${escapeMarkup(fault.remaining_seconds ?? fault.duration_seconds ?? "—")}s</small></span><span class="badge ${fault.severity === "high" ? "danger" : "warning"}">${escapeMarkup(fault.id || "FLT")}</span></div>`).join("") || `<div class="empty-state">활성 장애 없음</div>`;
}

function renderEvents() {
  const events = (store.events || []).slice(-MAX_EVENTS).reverse();
  $("#status-events").innerHTML = events.map(event => {
    const stamp = event.timestamp || event.time || "";
    const time = stamp ? String(stamp).replace("T", " ").slice(11, 19) : "—";
    const level = event.level || event.severity || "info";
    return `<tr><td>${escapeMarkup(time)}</td><td><span class="badge ${level === "warning" ? "warning" : level === "error" ? "danger" : "info"}">${escapeMarkup(level)}</span></td><td>${escapeMarkup(event.type)}</td><td>${escapeMarkup(event.message)}</td></tr>`;
  }).join("") || `<tr><td colspan="4" class="empty-state">이벤트 없음</td></tr>`;
}

function renderSources() {
  const catalog = describeCatalog(store.satelliteCatalog);
  $("#status-sources").innerHTML = [
    ["GP 카탈로그", catalog.label, catalog.detail, catalog.tone],
    ["텔레메트리", "결정론적 SIM", "WebSocket /ws/telemetry", "success"],
    ["3D 모델", "NASA 3D Resources, NOAA/NASA GOES-R, 자체 제작", "/static/assets/models/manifest.json", ""],
  ].map(([label, value, detail, tone]) => `<div class="list-item static"><span class="status-dot ${tone === "success" ? "ok" : tone === "warning" ? "warning" : "ok"}"></span><span class="item-body"><b>${escapeMarkup(label)} · ${escapeMarkup(value)}</b><small>${escapeMarkup(detail)}</small></span></div>`).join("");
}

function renderAll() {
  renderRuntime(); renderTelemetry(); renderFaults(); renderEvents(); renderSources();
}

export function initStatus() {
  renderAll();
}

export function updateStatusTelemetry(payload) {
  if (payload?.runtime) store.runtime = payload.runtime;
  if (payload?.telemetry) store.telemetry = payload.telemetry;
  if (Array.isArray(payload?.events)) store.events = payload.events;
  if (store.activeTab !== "status") return;
  renderAll();
}
