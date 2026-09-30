// 노드 탭. 사용자가 위성 노드를 임시로 두고 궤도, 3D 모델, 임무 장비(OISL 단말)와 편대 배치를
// 조정해 보는 샌드박스다. 왼쪽은 내 위성만 보이는 궤도 뷰, 오른쪽은 선택 위성의 상태와 편집 폼,
// 아래는 편대 프리셋과 슬라이더다. "배치 완료"를 누르면 작업 세트가 대시보드(궤도 탭)에 반영된다.
// 위치는 Kepler+J2 모의 계산이고 OISL 상태는 기하학적 모델이다. 실측 텔레메트리가 아니다.
import { GlobeController } from "/static/visualization/globe.js?v=20260908-oisl-flow1";
import { SatelliteModelLayer } from "/static/visualization/satellite_model.js?v=20260908-camera2";
import { NodeScene } from "/static/visualization/node_scene.js?v=20260908-oisl-flow1";
import { nodeStateAt } from "/static/simulation/satellite_dynamics.js";
import { acquisitionProgress, blockedLabel, phaseLabel } from "/static/simulation/oisl.js";
import * as library from "/static/model_library/satellite_nodes.js";
import { emit, store } from "../state.js";
import { OrbitClock } from "../orbit/clock.js?v=20260908-scenario1";
import { displayNumber, escapeMarkup as esc, utcLabel } from "../orbit/catalog.js";
import { createModelResolver, describeMatch, loadSatelliteModels } from "../orbit/satellite_models.js";
import { bindLightingToggle } from "../orbit/globe_lighting.js";
import { bindZoomControls } from "../orbit/zoom_controls.js";
import { constellation } from "../nodes/constellation.js";
import { dataDeployment as sharedDeployment } from "../nodes/deployment_client.js";
import { createNodeEditor } from "../nodes/editor.js";
import { linkSummary, resolveLinks } from "../nodes/links.js?v=20260908-planes1";
import { escapeMarkup, faultLabel, openFaultDialog } from "./fault_dialog.js";

// The fault helpers moved to fault_dialog.js; they stay exported here for existing importers.
export { escapeMarkup, faultLabel, openFaultDialog };

const $ = selector => document.querySelector(selector);
const SLIDER_DEBOUNCE_MS = 120;
const { BUS_PRESETS, FORMATION_CONTROLS, FORMATION_DEFAULTS, FORMATION_PRESETS, LINK_POLICIES, NODE_MODES, OISL_ROLES } = library;

let view, globe, scene, modelLayer, clock, editor, lighting;
let manifestModels = [];
let resolveModel = () => null;
let initialized = false, initializing = null, active = false, tickTimer = null, lastPathTime = null;
let terminalHistories = new Map();
let lastStates = new Map();
let lastLinks = { terminals: [], pairs: [] };
let formationParams = { ...FORMATION_DEFAULTS };
let activeFormationId = null;
let sliderTimer = null;
let syncing = Promise.resolve();
let suppressSelect = false;
let dataDeployment;

function toast(type, title, message) {
  emit("toast", { type, title, message });
}

const idOf = node => String(node.catalog_number);
const nodeOfCatalogId = id => constellation.drafts.find(node => idOf(node) === String(id)) || null;

function modelMatchFor(node) {
  return node ? resolveModel({ NORAD_CAT_ID: node.catalog_number, OBJECT_NAME: node.name, model_key: node.model_key, ORBIT_REGIME: library.nodeCatalogItem(node).ORBIT_REGIME }) : null;
}

function modelDescriptionFor(key) {
  const match = key ? resolveModel({ NORAD_CAT_ID: 0, OBJECT_NAME: "", model_key: key, ORBIT_REGIME: "LEO" }) : null;
  const text = describeMatch(match);
  return match ? { thumbnail: match.thumbnail, alt: text.alt, note: `${match.label} · 대표 치수 ${displayNumber(match.sizeMeters, 1)} m · ${match.credit}` } : { thumbnail: null, note: text.note };
}

/* ---------- scene ---------- */

function showModel(node) {
  if (!modelLayer) return;
  if (!node) { modelLayer.clear(); return; }
  const id = idOf(node);
  const match = modelMatchFor(node);
  modelLayer.show(match ? { satelliteId: id, ...match } : { satelliteId: id }, date => globe.positionAt(id, date), clock.now());
}

function renderTrackingState(tracking) {
  const label = $("#node-render-mode");
  if (label) label.textContent = tracking ? "위성 추적 / 실제 축척 (휠: 거리, Esc: 해제)" : globe?.viewer ? "지구 고정 좌표 / Cesium" : "2D 좌표도 / 바탕지도 미제공";
}

function onGlobeSelect(item, position, id, context = {}) {
  const node = nodeOfCatalogId(id);
  if (!node) return;
  if (constellation.selectedId !== node.id) {
    suppressSelect = true;
    try { constellation.select(node.id); } finally { suppressSelect = false; }
  }
  scene?.select(id);
  showModel(node);
  if (context.focus) modelLayer?.focus(clock.now());
  else if (context.userInitiated) modelLayer?.focus(clock.now(), { keepRange: true });
  renderFleet(); renderStatus();
}

function hoverNode(payload) {
  const card = $("#node-hover-card");
  if (!card) return;
  const node = payload?.item ? nodeOfCatalogId(payload.id) : null;
  if (!node || !payload.screen) { card.hidden = true; return; }
  const state = lastStates.get(node.id);
  card.innerHTML = `<b>${esc(node.name)}</b><small>${esc(BUS_PRESETS[node.bus]?.label || node.bus)} · ${esc(displayNumber(payload.position?.altitude, 0))} km · ${state ? (state.sunlit ? "일조" : "식") : "—"}</small>`;
  const parent = card.parentElement;
  card.hidden = false;
  card.style.left = `${Math.max(6, Math.min(parent.clientWidth - card.offsetWidth - 8, payload.screen.x + 12))}px`;
  card.style.top = `${Math.max(38, Math.min(parent.clientHeight - card.offsetHeight - 30, payload.screen.y + 48))}px`;
}

function syncScene() {
  if (!initialized) return syncing;
  syncing = syncing.then(async () => {
    const nodes = constellation.drafts;
    const selected = constellation.selected;
    globe.selectedId = selected ? idOf(selected) : null;
    globe.currentDate = clock.now();
    await globe.setSatellites(constellation.draftItems());
    await scene.setNodes(nodes.map(node => ({ id: idOf(node), model: modelMatchFor(node) })));
    if (selected) { scene.select(idOf(selected)); showModel(selected); }
    else { modelLayer.clear(); scene.select(null); }
    lastPathTime = null;
    tick(true);
  }).catch(error => console.warn("node scene sync failed", error));
  return syncing;
}

/* ---------- analysis tick ---------- */

function renderClock() {
  if (!clock) return;
  const date = clock.now();
  $("#node-clock").textContent = utcLabel(date);
  $("#node-clock-mode").textContent = clock.isLive ? "현재 시각" : clock.running ? "시간 탐색" : "일시정지";
  $("#node-clock-pause").textContent = clock.running ? "Ⅱ" : "▶";
  $("#node-clock-speed").value = String(clock.speed);
  $("#node-clock-now").setAttribute("aria-pressed", String(clock.isLive));
}

function tick(force = false) {
  renderClock();
  if (!initialized || (!active && !force)) return;
  const date = clock.now();
  const nodes = constellation.drafts;
  lastStates = new Map(nodes.map(node => [node.id, nodeStateAt(node.orbit, date)]));
  lastLinks = resolveLinks(nodes, lastStates, terminalHistories, date);
  terminalHistories = lastLinks.histories;
  const rebuild = force || lastPathTime === null || Math.abs(date.getTime() - lastPathTime) > 30000;
  globe.update(date, rebuild);
  modelLayer.update(date);
  scene.setLinks(lastLinks.pairs.map(pair => ({ key: pair.key, a: idOf(constellation.find(pair.a)), b: idOf(constellation.find(pair.b)), state: pair.state })));
  scene.update(date, rebuild);
  if (rebuild) lastPathTime = date.getTime();
  renderFleet(); renderStatus(); renderSceneFoot();
}

function changeTime(action) { action(); tick(true); }

/* ---------- fleet list and status ---------- */

function linkStateOf(nodeId) {
  const mine = lastLinks.pairs.filter(pair => pair.a === nodeId || pair.b === nodeId);
  if (!mine.length) return lastLinks.terminals.some(terminal => terminal.nodeId === nodeId && terminal.state.phase === "blocked") ? "danger" : "neutral";
  if (mine.some(pair => pair.state === "locked")) return "ok";
  if (mine.some(pair => pair.state === "acquiring" || pair.state === "slewing" || pair.state === "one_way")) return "warning";
  return "danger";
}

let fleetKey = null;
let statusKey = null;

// The list is rebuilt only when membership or definitions change; per tick only the link state dots
// and the selection are touched so rows stay stable under the pointer.
function renderFleet() {
  const list = $("#node-fleet");
  if (!list) return;
  const nodes = constellation.drafts;
  $("#node-count").textContent = String(nodes.length);
  const key = nodes.map(node => `${node.id}|${node.updated_at}|${node.name}|${node.mode}`).join(";");
  if (key !== fleetKey) {
    fleetKey = key;
    list.innerHTML = nodes.map(node => {
      const item = library.nodeCatalogItem(node);
      return `<button class="ns-fleet-row" role="option" aria-selected="false" data-node-id="${esc(node.id)}"><span class="status-dot neutral"></span><span class="ns-fleet-body"><b>${esc(node.name)}</b><small>${esc(item.ORBIT_REGIME || "—")} · ${esc(displayNumber(node.orbit.altitude_km, 0))} km · i ${esc(displayNumber(node.orbit.inclination, 1))}°${node.formation ? ` · ${esc(node.formation.id)}` : ""}</small></span><span class="ns-fleet-mode ${esc(node.mode)}">${esc(NODE_MODES[node.mode]?.label || node.mode)}</span></button>`;
    }).join("") || `<div class="ns-empty">위성이 없습니다. 아래 편대 배치에서 생성하거나 <b>＋ 위성 추가</b>를 누르세요.</div>`;
  }
  list.querySelectorAll("[data-node-id]").forEach(row => {
    row.setAttribute("aria-selected", String(row.dataset.nodeId === constellation.selectedId));
    const dot = row.querySelector(".status-dot");
    if (dot) dot.className = `status-dot ${linkStateOf(row.dataset.nodeId)}`;
  });
}

function terminalRow(terminal, date) {
  const { spec, state, geometry, margin } = terminal;
  const target = terminal.targetId ? constellation.find(terminal.targetId)?.name || terminal.targetId : "—";
  const progress = acquisitionProgress(state, spec, date);
  const detail = state.phase === "blocked" ? blockedLabel(state.blockedBy)
    : state.phase === "idle" ? "가시 상대 없음"
      : `거리 ${displayNumber(geometry?.range_km, 0)} km · 여유 ${displayNumber(margin.margin_db, 1)} dB${terminal.dataRateMbps ? ` · ${displayNumber(terminal.dataRateMbps / 1000, 1)} Gbps` : ""}`;
  return `<div class="ns-terminal" data-phase="${esc(state.phase)}">
    <div class="ns-terminal-head"><b>${esc(spec.label)}</b><span class="ns-tag ${esc(state.phase)}">${esc(phaseLabel(state.phase))}</span></div>
    <div class="ns-terminal-grid"><span>방향 <b>${esc(OISL_ROLES[terminal.role] || terminal.role)}</b></span><span>상대 <b>${esc(target)}</b></span><span>짐벌 Az/El <b>${esc(displayNumber(state.azimuth, 1))}° / ${esc(displayNumber(state.elevation, 1))}°</b></span><span>지향 오차 <b>${state.pointingError == null ? "—" : esc(displayNumber(state.pointingError, 3))}°</b></span></div>
    <small>${esc(detail)}</small>${progress !== null ? `<i class="ns-progress"><b style="width:${Math.round(progress * 100)}%"></b></i>` : ""}
  </div>`;
}

// Static frame of the status panel: identity, actions, shape and the definition-derived orbit values.
function statusFrame(node) {
  const item = library.nodeCatalogItem(node);
  const match = modelMatchFor(node);
  const shape = describeMatch(match);
  return `
    <header class="ns-status-head">
      <span class="ns-kicker">${esc(BUS_PRESETS[node.bus]?.label || node.bus)} · ${esc(node.id)} · 참조 ${esc(node.catalog_number)}</span>
      <h3>${esc(node.name)}</h3>
      <div class="ns-status-tags"><span class="ns-tag ${esc(node.mode)}">${esc(NODE_MODES[node.mode]?.label || node.mode)}</span><span class="ns-tag">${esc(item.ORBIT_REGIME || "—")}</span>${node.formation ? `<span class="ns-tag">${esc(FORMATION_PRESETS[node.formation.preset]?.label || node.formation.preset)} ${esc(node.formation.id)}</span>` : `<span class="ns-tag">개별 배치</span>`}</div>
      <div class="ns-status-actions"><button id="node-edit">편집</button><button id="node-duplicate">복제</button><button id="node-locate">뷰 정렬</button><button id="node-remove" class="danger">삭제</button></div>
    </header>
    <section class="ns-section ns-shape"><figure>${match ? `<img src="${esc(match.thumbnail)}" alt="${esc(shape.alt)}" decoding="async">` : ""}<figcaption><b>${esc(shape.label)}</b><small>${esc(shape.state)}${match?.sizeMeters ? ` · 대표 치수 ${esc(displayNumber(match.sizeMeters, 1))} m` : ""}</small></figcaption></figure></section>
    <section class="ns-section"><h4>궤도 <small>Kepler + J2 · 정의 ${esc(utcLabel(node.orbit.epoch, false))} UTC</small></h4>
      <dl class="ns-values">
        <div><dt>평균 고도</dt><dd>${esc(displayNumber(node.orbit.altitude_km, 1))} km</dd></div><div><dt>이심률 / 경사각</dt><dd>${esc(displayNumber(node.orbit.eccentricity, 4))} / ${esc(displayNumber(node.orbit.inclination, 2))}°</dd></div>
        <div><dt>승교점 적경 (현재)</dt><dd data-live="raan">—</dd></div><div><dt>근지점 편각 (현재)</dt><dd data-live="argp">—</dd></div>
        <div><dt>평균 근점 이각 (현재)</dt><dd data-live="anomaly">—</dd></div><div><dt>주기</dt><dd>${esc(displayNumber(item.PERIOD_MINUTES, 2))} min</dd></div>
        <div><dt>승교점 이동률</dt><dd>${esc(displayNumber(item.RAAN_DRIFT_DEG_PER_DAY, 3))}°/일</dd></div><div><dt>근지점 / 원지점</dt><dd>${esc(displayNumber(item.PERIGEE_KM, 0))} / ${esc(displayNumber(item.APOGEE_KM, 0))} km</dd></div>
      </dl>
      <dl class="ns-values ns-live">
        <div><dt>위도 / 경도</dt><dd data-live="latlon">—</dd></div><div><dt>타원체 고도</dt><dd data-live="altitude">—</dd></div>
        <div><dt>속력 (관성계)</dt><dd data-live="speed">—</dd></div><div><dt>태양 조건</dt><dd data-live="sun">—</dd></div>
      </dl></section>
    <section class="ns-section"><h4>전력 <small>순간 수지 · 배터리 적분 아님</small></h4>
      <div class="ns-power"><span>발전 <b data-live="generation">—</b></span><span>소비 <b data-live="consumption">—</b></span><span data-live="margin-cell">여유 <b data-live="margin">—</b></span><span>배터리 <b>${esc(displayNumber(node.power?.battery_wh, 0))} Wh</b></span></div>
      <i class="ns-power-bar"><b data-live="power-bar" style="width:0%"></b></i></section>
    <section class="ns-section"><h4>임무 장비 <small data-live="equipment-summary">—</small></h4>
      <div class="ns-eq-status" data-live="equipment"></div></section>
    <section class="ns-section"><h4>OISL 단말 <small data-live="terminal-summary">—</small></h4>
      <div data-live="terminals"></div></section>
    <p class="ns-note">위치와 링크 상태는 Kepler+J2 모의 계산과 기하학적 가시선 판정입니다. 실측 텔레메트리나 링크 예산이 아닙니다.</p>`;
}

function bindStatusActions(node) {
  $("#node-edit")?.addEventListener("click", () => openEditor(node));
  $("#node-duplicate")?.addEventListener("click", () => { const copy = constellation.duplicate(node.id); if (copy) toast("success", "위성 복제", copy.name); });
  $("#node-locate")?.addEventListener("click", () => globe?.select(idOf(node), false, { userInitiated: true, focus: true }));
  $("#node-remove")?.addEventListener("click", () => { if (confirm(`${node.name} 위성을 작업 세트에서 삭제할까요?`)) { constellation.remove(node.id); toast("warning", "위성 삭제", node.name); } });
}

function renderStatus() {
  const panel = $("#node-status");
  if (!panel || !clock) return;
  const node = constellation.selected;
  if (editor?.isOpen()) { panel.hidden = true; statusKey = null; return; }
  panel.hidden = false;
  if (!node) {
    if (statusKey !== "empty") { panel.innerHTML = `<div class="ns-empty tall">위성을 선택하면 궤도, 전력, 장비와 OISL 단말 상태를 표시합니다.</div>`; statusKey = "empty"; }
    return;
  }
  const key = `${node.id}|${node.updated_at}|${manifestModels.length}`;
  if (key !== statusKey) {
    statusKey = key;
    panel.innerHTML = statusFrame(node);
    bindStatusActions(node);
  }
  const live = name => panel.querySelector(`[data-live="${name}"]`);
  const set = (name, text) => { const element = live(name); if (element) element.textContent = text; };
  const date = clock.now();
  const state = lastStates.get(node.id) || null;
  const position = state?.geodetic;
  set("raan", `${displayNumber(state?.raan, 2)}°`);
  set("argp", `${displayNumber(state?.argp, 2)}°`);
  set("anomaly", `${displayNumber(state?.meanAnomaly, 2)}°`);
  set("latlon", `${displayNumber(position?.latitude, 3)}° / ${displayNumber(position?.longitude, 3)}°`);
  set("altitude", `${displayNumber(position?.altitude, 1)} km`);
  set("speed", `${displayNumber(position?.velocity, 3)} km/s`);
  const sun = live("sun");
  if (sun) { sun.textContent = state ? (state.sunlit ? "일조" : "지구 그림자 (식)") : "위치 미제공"; sun.className = state ? (state.sunlit ? "sunlit" : "eclipse") : ""; }
  const terminals = lastLinks.terminals.filter(terminal => terminal.nodeId === node.id);
  const activeTerminals = new Set(terminals.filter(terminal => terminal.targetId).map(terminal => terminal.equipmentId));
  const power = library.powerBudget(node, { sunlit: state ? state.sunlit : true, activeTerminals });
  set("generation", `${displayNumber(power.generation_w, 0)} W`);
  set("consumption", `${displayNumber(power.consumption_w, 0)} W`);
  set("margin", `${displayNumber(power.margin_w, 0)} W`);
  const marginCell = live("margin-cell");
  if (marginCell) marginCell.className = power.margin_w >= 0 ? "ok" : "bad";
  const bar = live("power-bar");
  if (bar) { bar.style.width = `${Math.max(0, Math.min(100, power.generation_w ? power.consumption_w / power.generation_w * 100 : 100))}%`; bar.className = power.margin_w >= 0 ? "" : "bad"; }
  set("equipment-summary", `${power.items.filter(entry => entry.active).length} / ${power.items.length} 사용 중 · 총 질량 ${displayNumber(library.nodeMass(node), 0)} kg`);
  const equipment = live("equipment");
  if (equipment) equipment.innerHTML = power.items.map(entry => `<span class="${entry.active ? "on" : "off"}"><b>${esc(entry.label)}</b><small>${entry.active ? `${esc(entry.power_w)} W` : "꺼짐"}</small></span>`).join("") || "장비 없음";
  set("terminal-summary", `${terminals.length}기 · 짐벌 지향과 포착 순서는 기하 모델`);
  const terminalHost = live("terminals");
  if (terminalHost) terminalHost.innerHTML = terminals.map(terminal => terminalRow(terminal, date)).join("") || `<div class="ns-empty">활성 OISL 단말이 없습니다. 운용 모드와 장비를 확인하세요.</div>`;
  const locate = $("#node-locate");
  if (locate) locate.disabled = !position;
}

function renderSceneFoot() {
  const nodes = constellation.drafts;
  const summary = linkSummary(lastLinks.pairs);
  const models = scene ? scene.models.size : 0;
  $("#node-scene-summary").textContent = `내 위성 ${nodes.length}기 · 3D 모델 ${models}개 · 위치 ${[...lastStates.values()].filter(Boolean).length}기`;
  $("#node-link-summary").textContent = summary.total
    ? `OISL 링크 ${summary.total}: 양방향 유지 ${summary.locked} · 단방향 ${summary.one_way} · 포착/구동 ${summary.acquiring + summary.slewing} · 차단 ${summary.blocked}`
    : "OISL 링크 없음";
  renderDeployState();
}

function renderDeployState() {
  const label = $("#deploy-state");
  if (!label) return;
  const deployed = constellation.deployed.length;
  const dirty = constellation.isDirty();
  const state = dataDeployment?.state;
  const serverCount = state?.server?.nodes.length || 0;
  if (state?.busy) label.textContent = "서버 배치 동기화 중입니다. 수락 전에는 기존 배치를 유지합니다.";
  else if (state?.error) label.textContent = `동기화 실패: ${state.error} 기존 배치와 초안은 유지됩니다.`;
  else if (state?.syncRequired) label.textContent = `동기화 필요: 서버 구성 ${serverCount}기와 브라우저 배치가 다릅니다. 배치 또는 회수 시 서버 구성을 변경합니다.`;
  else if (!state?.server) label.textContent = "서버 배치 확인 대기";
  else label.textContent = deployed
    ? `서버 수락 ${deployed}기 / 구성 버전 ${state.server.revision}${dirty ? " / 미반영 변경 있음" : " / 최신"}`
    : constellation.drafts.length ? "초안만 존재합니다. 배치 완료 후 데이터 관리에 반영됩니다." : "서버에 배치된 위성이 없습니다.";
  label.title = state?.server ? `현재 서버 구성: ${state.server.nodes.map(node => `${node.name} (${node.id})`).join(", ") || "없음"}` : "";
  label.classList.toggle("dirty", !!state?.error || !!state?.syncRequired || (dirty && deployed > 0));
  $("#nodes-deploy").disabled = !!state?.busy || (!constellation.drafts.length && !deployed && !serverCount && !state?.error);
  $("#nodes-recall").disabled = !!state?.busy || (!deployed && !serverCount);
}

async function submitDeployment(kind) {
  if (!dataDeployment || dataDeployment.state.busy) return;
  if (dataDeployment.state.syncRequired && !confirm("서버의 현재 배치 구성을 이 브라우저의 요청으로 변경할까요? 서버 구성은 배치 상태 안내에 표시됩니다.")) return;
  if (kind === "recall" && !confirm("서버 데이터 배치와 대시보드에서 내 위성을 모두 회수할까요? 작업 세트는 유지됩니다.")) return;
  try {
    if (!dataDeployment.state.server && !constellation.drafts.length && !constellation.deployed.length) {
      await dataDeployment.initialize();
      return;
    }
    await dataDeployment[kind]();
    if (kind === "deploy") toast("success", "배치 완료", `서버가 수락한 ${constellation.deployed.length}기를 데이터 관리와 대시보드에 반영했습니다.`);
    else toast("success", "배치 회수", "서버가 배치 해제를 수락했습니다. 작업 세트는 유지됩니다.");
  } catch (error) {
    toast("error", "배치 동기화 실패", `${error.message} 초안과 기존 브라우저 배치는 유지됩니다.`);
  }
  renderDeployState();
}

/* ---------- editor ---------- */

function openEditor(node) {
  editor.open(node);
  $("#node-status").hidden = true;
}

function saveNode(draft) {
  const original = constellation.find(draft.id);
  if (!original) return ["노드를 찾을 수 없습니다."];
  const next = { ...draft, formation: null };
  const errors = constellation.update(draft.id, next);
  if (!errors.length) {
    for (const key of [...terminalHistories.keys()]) if (key.startsWith(`${draft.id}/`)) terminalHistories.delete(key);
    toast("success", "위성 저장", `${next.name}${original.formation ? " · 편대에서 분리됨" : ""}`);
  }
  return errors;
}

/* ---------- formation panel ---------- */

function controlEnabled(control) {
  return !control.presets || control.presets.includes(formationParams.preset);
}

// Every slider is always present so the panel keeps one height; controls a preset does not use
// are disabled and dimmed rather than removed.
function renderFormationControls() {
  const host = $("#formation-controls");
  host.innerHTML = FORMATION_CONTROLS.map(control => {
    const enabled = controlEnabled(control);
    return `<label class="ns-slider" data-control="${esc(control.key)}" aria-disabled="${!enabled}" data-tip="${esc(control.help || control.label)}${enabled ? "" : " 현재 프리셋에서는 사용하지 않습니다."}">
    <span>${esc(control.label)}</span>
    <input type="range" min="${control.min}" max="${control.max}" step="${control.step}" value="${esc(formationParams[control.key])}" aria-label="${esc(control.label)}" ${enabled ? "" : "disabled"}>
    <input type="number" min="${control.min}" max="${control.inputMax ?? control.max}" step="${control.step}" value="${esc(formationParams[control.key])}" aria-label="${esc(control.label)} 입력" ${enabled ? "" : "disabled"}>
    <em>${esc(control.unit)}</em></label>`;
  }).join("");
  host.querySelectorAll(".ns-slider").forEach(label => {
    const key = label.dataset.control;
    const [range, number] = label.querySelectorAll("input");
    const apply = value => {
      formationParams[key] = Number(value);
      formationParams = library.normalizeFormationParams(formationParams);
      range.value = String(Math.min(Number(range.max), formationParams[key]));
      number.value = String(formationParams[key]);
      if (key === "planes") { const phasing = host.querySelector('[data-control="phasing"] input[type="range"]'); if (phasing) phasing.max = String(Math.max(0, formationParams.planes - 1)); }
      renderFormationHints();
      scheduleLiveFormation();
    };
    range.addEventListener("input", () => apply(range.value));
    number.addEventListener("change", () => apply(number.value));
  });
  document.querySelectorAll("[data-formation-preset]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.formationPreset === formationParams.preset));
    button.dataset.tip = FORMATION_PRESETS[button.dataset.formationPreset]?.note || "";
  });
  $("#formation-prefix").value = formationParams.prefix;
  $("#formation-bus").value = formationParams.bus;
  $("#formation-links").value = formationParams.link_policy;
  const phasing = host.querySelector('[data-control="phasing"] input[type="range"]');
  if (phasing) phasing.max = String(Math.max(0, formationParams.planes - 1));
  renderFormationHints();
}

// The computed layout is not printed in the panel; it becomes the guide of the generate button.
function formationSummaryText() {
  const summary = library.formationSummary(formationParams);
  const parts = [`${FORMATION_PRESETS[summary.preset]?.label || summary.preset} · 총 ${summary.total}기`];
  if (summary.planes > 1) parts.push(`${summary.planes}면 × ${summary.perPlane}기 · 면 간 승교점 ${displayNumber(summary.raanStep, 1)}°`);
  if (summary.anomalyStep) parts.push(`위성 간 위상 ${displayNumber(summary.anomalyStep, 1)}° (직선 거리 ${displayNumber(summary.intraPlaneRangeKm, 0)} km)`);
  if (summary.phaseOffset) parts.push(`면 간 위상차 ${displayNumber(summary.phaseOffset, 1)}°`);
  parts.push(summary.valid ? `${summary.regime} · 주기 ${displayNumber(summary.periodMinutes, 1)} min` : "궤도 범위 밖");
  return parts.join(" · ");
}

function renderFormationHints() {
  const bus = BUS_PRESETS[formationParams.bus];
  const policy = LINK_POLICIES[formationParams.link_policy];
  $("#formation-generate").dataset.tip = `이 설정으로 새 편대를 작업 세트에 추가합니다. ${formationSummaryText()}`;
  $("#formation-bus").dataset.tip = bus ? `${bus.label}: 3D 모델 ${bus.model_key}, 발전 ${bus.generation_w} W, 질량 ${bus.mass_kg} kg, 기본 장비 ${bus.equipment.length}종이 함께 정해집니다.` : "위성 버스 프리셋";
  $("#formation-links").dataset.tip = policy?.help || "OISL 링크 정책";
  const hasFormation = !!activeFormationId && constellation.drafts.some(node => node.formation?.id === activeFormationId);
  const remove = $("#formation-remove");
  remove.disabled = !hasFormation;
  remove.dataset.tip = hasFormation ? `현재 편대 ${activeFormationId}의 위성만 작업 세트에서 지웁니다. 개별 수정으로 분리된 위성은 남습니다.` : "목록에서 편대 소속 위성을 고르거나 편대를 생성하면 그 편대를 지울 수 있습니다.";
}

function readFormationInputs() {
  formationParams = library.normalizeFormationParams({
    ...formationParams, prefix: $("#formation-prefix").value, bus: $("#formation-bus").value, link_policy: $("#formation-links").value,
  });
}

function generateFormation(formationId = null) {
  readFormationInputs();
  const existing = formationId ? constellation.drafts.filter(node => node.formation?.id === formationId).sort((a, b) => (a.formation.plane - b.formation.plane) || (a.formation.index - b.formation.index)) : [];
  const pool = existing.map(node => ({ id: node.id, catalogNumber: node.catalog_number }));
  const idFactory = () => pool.shift() || constellation.nextIds();
  const id = formationId || `FRM-${(constellation.drafts.length + Date.now() % 100000).toString(36).toUpperCase()}`;
  try {
    const nodes = library.generateFormation(formationParams, { epoch: clock.now().getTime(), idFactory, formationId: id });
    if (formationId) constellation.replaceFormation(formationId, nodes); else constellation.addMany(nodes);
    activeFormationId = id;
    return nodes;
  } catch (error) {
    toast("error", "편대 생성 실패", error.message);
    return [];
  }
}

function scheduleLiveFormation() {
  if (!$("#formation-live").checked || !activeFormationId) return;
  if (!constellation.drafts.some(node => node.formation?.id === activeFormationId)) return;
  clearTimeout(sliderTimer);
  sliderTimer = setTimeout(() => generateFormation(activeFormationId), SLIDER_DEBOUNCE_MS);
}

function adoptFormationOf(node) {
  if (!node?.formation?.params) return;
  if (node.formation.id === activeFormationId) return;
  activeFormationId = node.formation.id;
  formationParams = library.normalizeFormationParams(node.formation.params);
  renderFormationControls();
}

// Small guide bubble for any element carrying data-tip, shown after a short hover or on focus.
function bindTooltips(root) {
  const tip = $("#node-tip");
  if (!tip || !root) return;
  let timer = null;
  let current = null;
  const place = target => {
    const rect = target.getBoundingClientRect();
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2));
    const above = rect.top - height - 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${above >= 8 ? above : rect.bottom + 8}px`;
    tip.dataset.placement = above >= 8 ? "above" : "below";
  };
  const show = target => {
    const text = target?.dataset.tip;
    if (!text) return;
    current = target;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (current !== target || !document.contains(target)) return;
      tip.textContent = text;
      tip.hidden = false;
      place(target);
    }, 220);
  };
  const hide = () => { clearTimeout(timer); current = null; tip.hidden = true; };
  root.addEventListener("mouseover", event => { const target = event.target.closest("[data-tip]"); if (target && target !== current) show(target); });
  root.addEventListener("mouseout", event => { const target = event.target.closest("[data-tip]"); if (target && !target.contains(event.relatedTarget)) hide(); });
  root.addEventListener("focusin", event => { const target = event.target.closest("[data-tip]"); if (target) show(target); });
  root.addEventListener("focusout", hide);
  root.addEventListener("mousedown", hide);
  window.addEventListener("scroll", hide, true);
}

function bindFormationPanel() {
  document.querySelectorAll("[data-formation-preset]").forEach(button => button.addEventListener("click", () => {
    formationParams = library.normalizeFormationParams({ ...formationParams, preset: button.dataset.formationPreset, raan_spread: button.dataset.formationPreset === "walker_star" ? 180 : formationParams.raan_spread });
    renderFormationControls();
    scheduleLiveFormation();
  }));
  $("#formation-bus").innerHTML = Object.entries(BUS_PRESETS).map(([key, bus]) => `<option value="${key}">${esc(bus.label)}</option>`).join("");
  $("#formation-links").innerHTML = Object.entries(LINK_POLICIES).map(([key, policy]) => `<option value="${key}">${esc(policy.label)}</option>`).join("");
  for (const id of ["#formation-prefix", "#formation-bus", "#formation-links"]) $(id).addEventListener("change", () => { readFormationInputs(); renderFormationHints(); scheduleLiveFormation(); });
  $("#formation-generate").addEventListener("click", () => {
    const nodes = generateFormation(null);
    if (nodes.length) toast("success", "편대 생성", `${nodes.length}기 · ${activeFormationId}`);
  });
  $("#formation-remove").addEventListener("click", () => {
    if (!activeFormationId) return;
    const removed = constellation.removeFormation(activeFormationId);
    toast("warning", "편대 제거", `${removed.length}기 제거`);
    activeFormationId = null; renderFormationHints();
  });
  $("#nodes-clear").addEventListener("click", () => {
    if (!constellation.drafts.length || !confirm("작업 세트의 위성을 모두 비울까요? 대시보드에 반영된 위성은 유지됩니다.")) return;
    constellation.clear(); activeFormationId = null; terminalHistories.clear(); renderFormationHints();
  });
  $("#node-add").addEventListener("click", () => {
    readFormationInputs();
    const node = constellation.add({ bus: formationParams.bus, orbit: library.defaultOrbit(clock.now().getTime(), { altitude_km: formationParams.altitude_km, inclination: formationParams.inclination, raan: formationParams.raan_start, mean_anomaly: formationParams.anomaly_start }) }, { linkPolicy: formationParams.link_policy });
    toast("success", "위성 추가", node.name);
    openEditor(node);
  });
  $("#nodes-deploy").addEventListener("click", () => submitDeployment("deploy"));
  $("#nodes-recall").addEventListener("click", () => submitDeployment("recall"));
  bindTooltips($("#view-nodes"));
}

/* ---------- bindings ---------- */

function bindScene() {
  $("#node-fleet").addEventListener("click", event => {
    const row = event.target.closest("[data-node-id]");
    if (!row) return;
    const node = constellation.find(row.dataset.nodeId);
    if (!node) return;
    if (editor.isOpen()) editor.close();
    constellation.select(node.id);
    globe?.select(idOf(node), false, { userInitiated: true });
  });
  $("#node-fleet").addEventListener("dblclick", event => {
    const row = event.target.closest("[data-node-id]");
    const node = row ? constellation.find(row.dataset.nodeId) : null;
    if (node) globe?.select(idOf(node), false, { userInitiated: true, focus: true });
  });
  document.querySelectorAll("[data-node-scene]").forEach(button => button.addEventListener("click", () => {
    const mode = button.dataset.nodeScene;
    if (mode === "home") { modelLayer?.untrack(); globe?.home(); }
    if (mode === "focus" && constellation.selected) globe?.select(idOf(constellation.selected), false, { userInitiated: true, focus: true });
    if (mode === "tracks") { button.setAttribute("aria-pressed", String(globe.toggleTracks())); scene.update(clock.now(), true); }
    if (mode === "links") button.setAttribute("aria-pressed", String(scene.setLinksVisible(button.getAttribute("aria-pressed") !== "true")));
    if (mode === "models") button.setAttribute("aria-pressed", String(scene.setModelsVisible(button.getAttribute("aria-pressed") !== "true")));
  }));
  $("#node-clock-pause").addEventListener("click", () => changeTime(() => clock.running ? clock.pause() : clock.play()));
  $("#node-clock-now").addEventListener("click", () => changeTime(() => clock.live()));
  $("#node-clock-back").addEventListener("click", () => changeTime(() => clock.step(-60)));
  $("#node-clock-forward").addEventListener("click", () => changeTime(() => clock.step(60)));
  $("#node-clock-speed").addEventListener("change", event => changeTime(() => clock.setSpeed(Number(event.target.value))));
  window.addEventListener("spacetwin:themechange", event => { globe?.setTheme(event.detail?.theme); lighting?.apply(); scene?.setTheme(event.detail?.theme); });
  document.addEventListener("keydown", event => { if (event.key === "Escape" && store.activeTab === "nodes") modelLayer?.untrack({ aimAtEarth: true }); });
}

function onStoreChange(event) {
  if (event === "select") {
    const node = constellation.selected;
    adoptFormationOf(node);
    if (node && globe && !suppressSelect && globe.records.has(idOf(node))) globe.select(idOf(node), false);
    renderFleet(); renderStatus();
    return;
  }
  if (event === "deploy") { renderDeployState(); return; }
  if (event === "add" || event === "update" || event === "remove") {
    if (editor.isOpen() && !constellation.find(editor.draft?.id)) editor.close();
    for (const key of [...terminalHistories.keys()]) if (!constellation.find(key.split("/")[0])) terminalHistories.delete(key);
    adoptFormationOf(constellation.selected);
    renderFleet(); renderStatus(); renderFormationHints();
    syncScene();
  }
}

async function initialize() {
  if (initializing) return initializing;
  initializing = (async () => {
    globe = new GlobeController($("#node-cesium"), $("#node-globe-fallback"), { onSelect: onGlobeSelect, onHover: hoverNode, sunElement: $("#node-space-sun") });
    // The sandbox shows links between nodes, not the ground observer line of the dashboard.
    globe.placeStationLink = () => {};
    modelLayer = new SatelliteModelLayer({
      viewer: () => globe.viewer, timeSource: () => clock.now(), onTrackingChange: renderTrackingState,
      isTransitioning: () => globe.sceneTransitioning, onFrame: date => { globe.syncSelected(date); scene?.syncFrame(date); },
      onCameraInput: () => globe.cancelCameraMotion(),
    });
    globe.wheelOverride = delta => modelLayer.zoomBy(delta);
    globe.onCameraInput = () => modelLayer.interruptCamera();
    globe.onCameraMove = () => modelLayer.untrack();
    scene = new NodeScene({ globe, timeSource: () => clock.now() });
    bindScene();
    renderClock();
    const result = await globe.init();
    const zoomControls = bindZoomControls({
      slider: $("#node-zoom"), zoomIn: $("#node-zoom-in"), zoomOut: $("#node-zoom-out"), focus: $("#node-map-locate"),
      canFocus: () => !!constellation.selected && globe.positions.has(idOf(constellation.selected)),
    }, globe, modelLayer);
    const removeZoomSync = globe.viewer?.scene.postRender.addEventListener(zoomControls.sync);
    window.addEventListener("pagehide", () => removeZoomSync?.(), { once: true });
    globe.setTheme(document.documentElement?.dataset?.theme);
    lighting = bindLightingToggle($("#node-lighting"), () => globe);
    lighting.apply();
    scene.setTheme(document.documentElement?.dataset?.theme);
    $("#node-globe-loading").classList.add("hidden");
    if (result.mode === "fallback") document.querySelectorAll('[data-node-scene="home"], [data-node-scene="links"], [data-node-scene="models"]').forEach(button => { button.disabled = true; });
    renderTrackingState(false);
    initialized = true;
    await syncScene();
  })();
  return initializing;
}

function setActive(next) {
  active = next;
  clearInterval(tickTimer); tickTimer = null;
  if (!active) return;
  initialize().then(() => { tick(true); tickTimer = setInterval(() => tick(), 1000); });
}

export function initNodes() {
  view = $("#view-nodes");
  if (!view || !$("#node-fleet")) return;
  // The analysis clock exists before any panel renders; the Cesium scene is created lazily on first activation.
  clock = new OrbitClock();
  constellation.load();
  // One deployment client serves this tab and the scenario player; both see every state change.
  dataDeployment = sharedDeployment;
  dataDeployment.subscribe(renderDeployState);
  editor = createNodeEditor({
    form: $("#node-editor"), models: () => manifestModels, otherNodes: () => constellation.drafts,
    onSave: draft => saveNode(draft), onCancel: () => renderStatus(), onModelChange: key => modelDescriptionFor(key),
  });
  constellation.subscribe(onStoreChange);
  bindFormationPanel();
  renderFormationControls();
  loadSatelliteModels().then(manifest => {
    if (!manifest) return;
    manifestModels = manifest.models;
    resolveModel = createModelResolver(manifest);
    if (initialized) syncScene();
    renderStatus();
  });
  adoptFormationOf(constellation.selected);
  renderFleet(); renderStatus(); renderDeployState(); renderFormationHints();
  dataDeployment.initialize().catch(error => toast("error", "배치 동기화 실패", error.message));
  new MutationObserver(() => {
    const isActive = view.classList.contains("active");
    if (isActive !== active) setActive(isActive);
  }).observe(view, { attributes: true, attributeFilter: ["class"] });
  if (view.classList.contains("active")) setActive(true);
  window.addEventListener("pagehide", () => { clearInterval(tickTimer); clearTimeout(sliderTimer); });
}

// Server telemetry has no authority over the sandbox; the store already keeps the runtime copy.
export function updateNodesTelemetry() {}
