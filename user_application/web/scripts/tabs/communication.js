// 통신 탭. 노드 탭에서 배치 완료한 내 위성과 운용자가 둔 지상국으로 통신망을 구성해 보여 준다.
// 가운데는 같은 데이터를 두 가지로 보는 뷰다. 지구 3D는 위성·지상국의 실제 위치와 링크 선, 커버리지를,
// 연결도는 궤도면별로 정리한 논리 연결과 품질을 보여 준다. 위치와 링크 기하, OISL 단말 상태는 디지털
// 트윈이 계산하고(satellite_dynamics, oisl, ground_links), 링크 품질·경로·저장 전달 상태는 데이터 패브릭
// 모듈이 ICD-02 메시지로 돌려준다(communication/browser/data_fabric.js). 패브릭이 응답하지 않으면 그 값은
// 비어 있는 채로 표시하며 만들어 채우지 않는다. 모든 값은 모의 계산이며 실측 텔레메트리가 아니다.
import { GlobeController } from "/static/visualization/globe.js?v=20260908-oisl-flow1";
import { SatelliteModelLayer } from "/static/visualization/satellite_model.js?v=20260908-camera2";
import { NetworkScene } from "/static/visualization/network_scene.js?v=20260908-ground-flow1";
import { diagramMarkup, layoutNetwork } from "/static/visualization/network_diagram.js?v=20260908-ground-flow1";
import { drawSparkline, pushHistory } from "/static/visualization/charts.js";
import { nodePositionAt } from "/static/simulation/satellite_dynamics.js";
import { predictPasses } from "/static/simulation/orbit.js";
import { CUSTODY_LABELS, LINK_KIND_LABELS, REASON_LABELS } from "/static/simulation/network_snapshot.js";
import { phaseLabel } from "/static/simulation/oisl.js";
import { BUS_PRESETS, NODE_MODES, nodeCatalogItem } from "/static/model_library/satellite_nodes.js";
import { BANDS, BAND_LABELS, STATION_PRESETS, coverageRadiusKm } from "/static/model_library/ground_stations.js";
import { api } from "/static/communication/api.js";
import { emit, on, store } from "../state.js";
import { networkTwin } from "../communication/network_twin.js";
import { OrbitClock } from "../orbit/clock.js?v=20260908-scenario1";
import { bindLightingToggle } from "../orbit/globe_lighting.js";
import { bindZoomControls } from "../orbit/zoom_controls.js";
import { displayNumber, escapeMarkup as esc, utcLabel } from "../orbit/catalog.js";
import { createModelResolver, loadSatelliteModels } from "../orbit/satellite_models.js";
import { constellation } from "../nodes/constellation.js";
import { groundSegment } from "../communication/ground_segment.js";
import { openFaultDialog } from "./fault_dialog.js";

const $ = selector => document.querySelector(selector);
const PASS_HOURS = 3;
const PASS_STALE_MS = 60_000;
const STATUS_POLL_MS = 30_000;
const QUALITY_HISTORY = 48;

let view, globe, scene, modelLayer, clock, fabric, lighting;
let resolveModel = () => null;
let initialized = false, initializing = null, active = false, tickTimer = null, statusTimer = null, lastPathTime = null;
let lastStates = new Map();
let lastLinks = { terminals: [], pairs: [] };
let snapshot = null;          // last ICD-02 message sent to the fabric
let report = null;            // last fabric answer
let twinLinks = new Map();    // link id -> twin link record (geometry, terminal state)
let fabricLinks = new Map();  // link id -> fabric link report
let fabricNodes = new Map();  // node id -> fabric node report
let fabricState = { placement: null, endpoint: "", implementation: null, version: null, reachable: null, rtt: null, error: null, sequence: null };
let inFlight = false;
let selection = null;         // { type: 'satellite' | 'station' | 'link', id }
let listMode = "satellites";
let viewMode = "3d";
let routeRequest = null;      // { source, target, objective }
let route = null;
let routeInFlight = false;
let routeLinkIds = new Set();
let passes = { stationId: null, items: [], computedAt: null, satellites: 0 };
let layoutKey = null;
let detailKey = null;
let layout = null;
let listKey = null;
let editorOpen = false;
let suppressStationSelect = false;

const toast = (type, title, message) => emit("toast", { type, title, message });
const satellites = () => constellation.deployed;
const idOf = node => String(node.catalog_number);
const nodeById = id => satellites().find(node => node.id === id) || null;
const nodeOfCatalogId = id => satellites().find(node => idOf(node) === String(id)) || null;
const stationById = id => groundSegment.find(id);
const displayName = id => nodeById(id)?.name || stationById(id)?.name || id;
const linkRecord = id => ({ ...(twinLinks.get(id) || {}), ...(fabricLinks.get(id) || {}) });
const reachable = () => fabricState.reachable === true;

function modelMatchFor(node) {
  return node ? resolveModel({ NORAD_CAT_ID: node.catalog_number, OBJECT_NAME: node.name, model_key: node.model_key, ORBIT_REGIME: nodeCatalogItem(node).ORBIT_REGIME }) : null;
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
  const label = $("#comm-render-mode");
  if (label) label.textContent = tracking ? "위성 추적 / 실제 축척 (휠: 거리, Esc: 해제)" : globe?.viewer ? "지구 고정 좌표 / Cesium" : "2D 좌표도 / 바탕지도 미제공";
}

function coverageAltitudeKm() {
  const altitudes = satellites().map(node => Number(node.orbit?.altitude_km)).filter(Number.isFinite).sort((p, q) => p - q);
  return altitudes.length ? altitudes[Math.floor(altitudes.length / 2)] : 550;
}

function onGlobeSelect(item, position, id, context = {}) {
  const node = nodeOfCatalogId(id);
  if (!node) return;
  selection = { type: "satellite", id: node.id };
  scene?.select(id);
  showModel(node);
  if (context.focus) modelLayer?.focus(clock.now());
  else if (context.userInitiated) modelLayer?.focus(clock.now(), { keepRange: true });
  renderSelectionDependent();
}

function hoverSatellite(payload) {
  const card = $("#comm-hover-card");
  if (!card) return;
  const node = payload?.item ? nodeOfCatalogId(payload.id) : null;
  if (!node || !payload.screen) { card.hidden = true; return; }
  const fabricNode = fabricNodes.get(node.id);
  const path = fabricNode?.ground_path ? `${displayName(fabricNode.ground_station)}까지 ${fabricNode.ground_hops}홉 · ${displayNumber(fabricNode.ground_delay_ms, 1)} ms` : reachable() ? "지상 경로 없음" : "패브릭 미응답";
  card.innerHTML = `<b>${esc(node.name)}</b><small>${esc(displayNumber(payload.position?.altitude, 0))} km · ${esc(path)}</small>`;
  const parent = card.parentElement;
  card.hidden = false;
  card.style.left = `${Math.max(6, Math.min(parent.clientWidth - card.offsetWidth - 8, payload.screen.x + 12))}px`;
  card.style.top = `${Math.max(74, Math.min(parent.clientHeight - card.offsetHeight - 30, payload.screen.y + 48))}px`;
}

let syncing = Promise.resolve();
function syncScene() {
  if (!initialized) return syncing;
  syncing = syncing.then(async () => {
    const nodes = satellites();
    const selected = selection?.type === "satellite" ? nodeById(selection.id) : null;
    globe.selectedId = selected ? idOf(selected) : null;
    globe.currentDate = clock.now();
    await globe.setSatellites(constellation.deployedItems());
    await scene.setNodes(nodes.map(node => ({ id: idOf(node), model: modelMatchFor(node) })));
    scene.setStations(groundSegment.enabled);
    if (selected) { scene.select(idOf(selected)); showModel(selected); }
    else { modelLayer.clear(); scene.select(null); }
    lastPathTime = null;
    tick(true);
  }).catch(error => console.warn("communication scene sync failed", error));
  return syncing;
}

/* ---------- analysis tick and the ICD exchange ---------- */

function renderClock() {
  if (!clock) return;
  $("#comm-clock").textContent = utcLabel(clock.now());
  $("#comm-clock-mode").textContent = clock.isLive ? "현재 시각" : clock.running ? "시간 탐색" : "일시정지";
  $("#comm-clock-pause").textContent = clock.running ? "Ⅱ" : "▶";
  $("#comm-clock-speed").value = String(clock.speed);
  $("#comm-clock-now").setAttribute("aria-pressed", String(clock.isLive));
}

// The network state (terminal histories, pairs, the ICD-02 message) is owned by the shared network
// twin, so the scenario player and this tab advance one acquisition history and send one message
// per second between them. The tab keeps local mirrors of the twin's results for rendering.
function adoptTwinState() {
  const current = networkTwin.last;
  lastStates = current.states; lastLinks = current.links; snapshot = current.snapshot; twinLinks = current.twinLinks;
}

function adoptFabricState() {
  report = networkTwin.report; fabricLinks = networkTwin.fabricLinks; fabricNodes = networkTwin.fabricNodes;
  fabricState = { ...fabricState, ...networkTwin.fabricState };
}

function tick(force = false) {
  renderClock();
  if (!initialized || (!active && !force)) return;
  const date = clock.now();
  const nodes = satellites();
  networkTwin.tick(date, { nodes, stations: groundSegment.enabled, faults: store.runtime?.active_faults || [] });
  adoptTwinState();
  const rebuild = force || lastPathTime === null || Math.abs(date.getTime() - lastPathTime) > 30000;
  globe.update(date, rebuild);
  modelLayer.update(date);
  scene.setLinks(lastLinks.pairs.map(pair => ({ key: pair.key, a: idOf(nodeById(pair.a)), b: idOf(nodeById(pair.b)), state: pair.state })));
  applyGroundLinks();
  scene.update(date, rebuild);
  if (rebuild) lastPathTime = date.getTime();
  sendSnapshot();
  if (passes.stationId && (!passes.computedAt || Math.abs(date.getTime() - passes.computedAt) > PASS_STALE_MS)) computePasses();
  renderAll();
}

function changeTime(action) { action(); tick(true); }

async function sendSnapshot() {
  if (!snapshot || inFlight) return;
  inFlight = true;
  try {
    const answer = await networkTwin.exchange();
    adoptFabricState();
    if (answer) {
      for (const link of fabricLinks.values()) pushHistory(`comm-quality-${link.id}`, link.usable ? link.quality : 0, QUALITY_HISTORY);
      if (routeRequest) requestRoute();
    } else if (!reachable()) {
      route = null; routeLinkIds = new Set();
    }
  } finally {
    inFlight = false;
  }
  applyGroundLinks();
  scene?.setRoute(routeLinkIds);
  renderAll();
}

async function pollStatus() {
  await networkTwin.pollStatus();
  adoptFabricState();
  renderFabricChip();
}

function groundLinkState(link) {
  const verdict = fabricLinks.get(link.id);
  if (verdict?.usable) return "usable";
  if (link.faulted || verdict?.reason === "fault") return "fault";
  if (link.state === "visible") return "visible";
  return "unusable";
}

function applyGroundLinks() {
  if (!scene || !snapshot) return;
  scene.setGroundLinks(snapshot.links.filter(link => link.kind === "ground" && link.state !== "no_radio").map(link => {
    const node = nodeById(link.b);
    return { id: link.id, station: link.a, satellite: node ? idOf(node) : link.b, state: groundLinkState(link) };
  }));
}

/* ---------- route ---------- */

async function requestRoute() {
  if (!routeRequest || routeInFlight || !reachable()) return;
  routeInFlight = true;
  try {
    route = await networkTwin.route(routeRequest.source, routeRequest.target, routeRequest.objective);
    routeLinkIds = new Set((route.hop_list || []).map(hop => hop.link_id));
  } catch (error) {
    route = { status: "error", detail: error.message, source: routeRequest.source, target: routeRequest.target, objective: routeRequest.objective };
    routeLinkIds = new Set();
  } finally {
    routeInFlight = false;
  }
  scene?.setRoute(routeLinkIds);
  renderRoute(); renderDiagram();
}

function calculateRoute() {
  const source = $("#comm-route-source").value;
  const target = $("#comm-route-target").value;
  if (!source || !target) { toast("warning", "경로 계산", "출발지와 목적지를 고르세요."); return; }
  routeRequest = { source, target, objective: $("#comm-route-objective").value };
  if (!reachable()) { toast("warning", "경로 계산", "데이터 패브릭이 응답하지 않아 경로를 계산할 수 없습니다."); renderRoute(); return; }
  requestRoute();
}

function clearRoute() {
  routeRequest = null; route = null; routeLinkIds = new Set();
  scene?.setRoute(routeLinkIds);
  renderRoute(); renderDiagram();
}

/* ---------- passes ---------- */

function computePasses() {
  const station = stationById(passes.stationId) || groundSegment.enabled[0] || null;
  if (!station) { passes = { stationId: null, items: [], computedAt: null, satellites: 0 }; renderPasses(); return; }
  const now = clock.now();
  const items = [];
  for (const node of satellites()) {
    const item = nodeCatalogItem(node);
    let found = [];
    try { found = predictPasses(date => nodePositionAt(item, date), station, now, PASS_HOURS, { maskDegrees: Number(station.min_elevation_deg) || 0, maxPasses: 3 }); }
    catch { found = []; }
    for (const pass of found) items.push({ ...pass, nodeId: node.id, name: node.name });
  }
  items.sort((p, q) => p.aos - q.aos);
  passes = { stationId: station.id, items, computedAt: now.getTime(), satellites: satellites().length };
  renderPasses();
}

/* ---------- selection ---------- */

function select(next, { fly = false } = {}) {
  selection = next;
  if (next?.type === "satellite") {
    const node = nodeById(next.id);
    if (node && globe?.records.has(idOf(node))) { globe.select(idOf(node), false, { userInitiated: true, focus: fly }); return; }
  }
  if (next?.type === "station") {
    const station = stationById(next.id);
    if (station && groundSegment.selectedId !== station.id) { suppressStationSelect = true; try { groundSegment.select(station.id); } finally { suppressStationSelect = false; } }
    if (fly && station && globe?.viewer && window.Cesium) {
      modelLayer?.untrack();
      globe.flyTo({ destination: window.Cesium.Cartesian3.fromDegrees(station.longitude, station.latitude, 2_400_000), duration: 1.4 });
    }
  }
  renderSelectionDependent();
}

function renderSelectionDependent() {
  scene?.setSelectedLink(selection?.type === "link" ? selection.id : null);
  renderList(); renderDetail(); renderDiagram();
}

/* ---------- rendering: left column ---------- */

function toneOfSatellite(node) {
  const fabricNode = fabricNodes.get(node.id);
  if (!reachable()) return { tone: "neutral", title: "패브릭 미응답" };
  if (fabricNode?.ground_path) return { tone: "ok", title: `${displayName(fabricNode.ground_station)}까지 ${fabricNode.ground_hops}홉` };
  if (fabricNode?.custody === "full") return { tone: "danger", title: "저장 용량 초과" };
  return { tone: "warning", title: "지상 경로 없음 · 보관 중" };
}

function renderCounts() {
  const nodes = satellites();
  const stations = groundSegment.enabled;
  const usable = [...fabricLinks.values()].filter(link => link.usable).length;
  const total = twinLinks.size;
  const withPath = report?.summary?.satellites_with_ground_path;
  $("#comm-counts").innerHTML = [
    ["위성", nodes.length, ""], ["지상국", `${stations.length}`, groundSegment.stations.length > stations.length ? `/${groundSegment.stations.length}` : ""],
    ["사용 가능 링크", reachable() ? usable : "—", `/${total}`], ["지상 연결 위성", withPath ?? "—", nodes.length ? `/${nodes.length}` : ""],
  ].map(([label, value, suffix]) => `<span><b>${esc(value)}</b><i>${esc(suffix)}</i><small>${esc(label)}</small></span>`).join("");
  $("#comm-source").textContent = nodes.length ? `배치 위성 ${nodes.length}기 · ${utcLabel(constellation.deployedAt, false).slice(5)} UTC 반영` : "배치된 위성 없음";
  $("#comm-empty-note").hidden = nodes.length > 0;
}

// A row is described once and rendered either as new markup or as an in-place update of the three
// cells that change every tick, so the list keeps its scroll position and the pointer stays put.
function satelliteRow(node) {
  const state = lastStates.get(node.id);
  const fabricNode = fabricNodes.get(node.id);
  const tone = toneOfSatellite(node);
  const pairs = lastLinks.pairs.filter(pair => pair.a === node.id || pair.b === node.id);
  const locked = pairs.filter(pair => pair.state === "locked").length;
  const contacts = snapshot ? snapshot.links.filter(link => link.kind === "ground" && link.b === node.id && fabricLinks.get(link.id)?.usable).length : 0;
  const stored = fabricNode?.stored_mb > 0 ? ` · 보관 ${displayNumber(fabricNode.stored_mb, 0)} MB` : "";
  return { id: node.id, attribute: "data-comm-satellite", tone: tone.tone, title: tone.title, name: node.name,
    sub: `${NODE_MODES[node.mode]?.label || node.mode} · OISL ${locked}/${pairs.length} · 지상 ${contacts}${stored}`,
    aside: state ? `${displayNumber(state.geodetic.altitude, 0)} km` : "위치 없음", selected: selection?.type === "satellite" && selection.id === node.id };
}

function stationRow(station) {
  const visible = snapshot ? snapshot.links.filter(link => link.kind === "ground" && link.a === station.id && link.state === "visible").length : 0;
  const usable = snapshot ? snapshot.links.filter(link => link.kind === "ground" && link.a === station.id && fabricLinks.get(link.id)?.usable).length : 0;
  const serving = fabricNodes.get(station.id)?.serving?.length ?? null;
  const off = station.enabled === false;
  return { id: station.id, attribute: "data-comm-station", off, tone: off ? "neutral" : usable ? "ok" : visible ? "warning" : "neutral", title: "", name: station.name,
    sub: `${displayNumber(station.latitude, 2)}°, ${displayNumber(station.longitude, 2)}° · ${station.bands.join("/")} · 마스크 ${station.min_elevation_deg}°`,
    aside: off ? "사용 안 함" : `가시 ${visible}${serving != null ? ` · 담당 ${serving}` : ""}`, selected: selection?.type === "station" && selection.id === station.id };
}

function linkRow(link) {
  const verdict = fabricLinks.get(link.id);
  const tone = !reachable() ? "neutral" : verdict?.usable ? (link.kind === "ground" ? "info" : verdict.quality >= 75 ? "ok" : "warning") : verdict?.reason === "fault" ? "danger" : "neutral";
  const detail = verdict ? (verdict.usable ? `품질 ${verdict.quality}% · ${displayNumber(verdict.delay_ms, 1)} ms · ${displayNumber(verdict.capacity_mbps / 1000, 2)} Gbps` : REASON_LABELS[verdict.reason] || verdict.reason || "사용 불가")
    : (link.kind === "oisl" ? phaseLabel(link.state) : link.kind === "ground" ? (link.state === "visible" ? `고각 ${displayNumber(link.elevation_deg, 1)}°` : "마스크 아래") : "지상망");
  return { id: link.id, attribute: "data-comm-link", tone, title: "", name: `${displayName(link.a)} ↔ ${displayName(link.b)}`,
    sub: `${LINK_KIND_LABELS[link.kind] || link.kind}${link.band ? ` ${link.band}` : ""} · ${detail}`,
    aside: link.range_km != null ? `${displayNumber(link.range_km, 0)} km` : link.distance_km != null ? `${displayNumber(link.distance_km, 0)} km` : "",
    selected: selection?.type === "link" && selection.id === link.id };
}

function rowMarkup(row) {
  return `<button class="cm-row ${row.off ? "off" : ""}" role="option" aria-selected="${row.selected}" ${row.attribute}="${esc(row.id)}" title="${esc(row.title || "")}">
    <span class="status-dot ${esc(row.tone)}"></span>
    <span class="cm-row-body"><b>${esc(row.name)}</b><small>${esc(row.sub)}</small></span>
    <span class="cm-row-aside">${esc(row.aside)}</span>
  </button>`;
}

function currentRows() {
  if (listMode === "satellites") return satellites().map(satelliteRow);
  if (listMode === "stations") return groundSegment.stations.map(stationRow);
  const links = snapshot ? snapshot.links.filter(link => link.kind !== "ground" || link.state !== "no_radio") : [];
  const order = { oisl: 0, ground: 1, terrestrial: 2 };
  links.sort((p, q) => (order[p.kind] - order[q.kind]) || String(p.id).localeCompare(String(q.id)));
  return links.map(linkRow);
}

function renderList() {
  const list = $("#comm-list");
  if (!list) return;
  $("#comm-station-tools").hidden = listMode !== "stations";
  if (listMode !== "stations" && editorOpen) closeStationEditor();
  const rows = currentRows();
  const key = `${listMode}|${rows.map(row => row.id).join(",")}`;
  if (key !== listKey) {
    listKey = key;
    list.innerHTML = rows.map(rowMarkup).join("") || `<div class="cm-empty">${listMode === "stations" ? "지상국이 없습니다. 위에서 추가하세요." : listMode === "links" ? "링크가 없습니다." : "배치된 위성이 없습니다."}</div>`;
    return;
  }
  // Same membership: only the state cells move, so the row elements are kept.
  const elements = list.children;
  rows.forEach((row, index) => {
    const element = elements[index];
    if (!element || element.getAttribute(row.attribute) !== String(row.id)) return;
    element.setAttribute("aria-selected", String(row.selected));
    element.classList.toggle("off", !!row.off);
    element.title = row.title || "";
    const dot = element.querySelector(".status-dot");
    if (dot) dot.className = `status-dot ${row.tone}`;
    const sub = element.querySelector(".cm-row-body small");
    if (sub && sub.textContent !== row.sub) sub.textContent = row.sub;
    const aside = element.querySelector(".cm-row-aside");
    if (aside && aside.textContent !== row.aside) aside.textContent = row.aside;
  });
}

/* ---------- station editor ---------- */

function stationEditorMarkup(station) {
  const bandBoxes = BANDS.map(band => `<label class="cm-check"><input type="checkbox" name="bands" value="${band}" ${station.bands.includes(band) ? "checked" : ""}> ${esc(BAND_LABELS[band])}</label>`).join("");
  return `<header class="cm-editor-head"><b>지상국 편집</b><small>${esc(station.id)}${station.preset ? ` · 프리셋 ${esc(STATION_PRESETS[station.preset]?.name || station.preset)}` : " · 직접 입력"}</small></header>
    <label>이름 <input name="name" value="${esc(station.name)}" maxlength="40" required></label>
    <div class="cm-grid-2"><label>위도 ° <input name="latitude" type="number" step="0.0001" min="-90" max="90" value="${esc(station.latitude)}"></label><label>경도 ° <input name="longitude" type="number" step="0.0001" min="-180" max="180" value="${esc(station.longitude)}"></label></div>
    <div class="cm-grid-3"><label>고도 km <input name="altitude_km" type="number" step="0.01" min="-0.5" max="9" value="${esc(station.altitude_km)}"></label><label>안테나 m <input name="dish_m" type="number" step="0.1" min="0.5" max="70" value="${esc(station.dish_m)}"></label><label>최소 고각 ° <input name="min_elevation_deg" type="number" step="0.5" min="0" max="89" value="${esc(station.min_elevation_deg)}"></label></div>
    <div class="cm-bands">${bandBoxes}</div>
    <label class="cm-check"><input type="checkbox" name="enabled" ${station.enabled !== false ? "checked" : ""}> 통신망에 사용</label>
    <ul class="cm-errors" hidden></ul>
    <div class="cm-editor-actions"><button type="button" data-station-remove class="danger">삭제</button><span class="cm-spacer"></span><button type="button" data-station-cancel>닫기</button><button type="submit" class="cm-primary">저장</button></div>`;
}

function openStationEditor(station) {
  const form = $("#comm-station-editor");
  if (!form || !station) return;
  form.innerHTML = stationEditorMarkup(station);
  form.dataset.stationId = station.id;
  form.hidden = false;
  editorOpen = true;
  form.querySelector("[data-station-cancel]").addEventListener("click", closeStationEditor);
  form.querySelector("[data-station-remove]").addEventListener("click", () => {
    if (!confirm(`${station.name} 지상국을 삭제할까요?`)) return;
    groundSegment.remove(station.id);
    if (selection?.type === "station" && selection.id === station.id) selection = null;
    closeStationEditor();
    toast("warning", "지상국 삭제", station.name);
  });
}

function closeStationEditor() {
  const form = $("#comm-station-editor");
  if (!form) return;
  form.hidden = true; form.innerHTML = ""; delete form.dataset.stationId;
  editorOpen = false;
}

function saveStationEditor(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.dataset.stationId;
  const data = new FormData(form);
  const next = {
    name: data.get("name"), latitude: Number(data.get("latitude")), longitude: Number(data.get("longitude")), altitude_km: Number(data.get("altitude_km")),
    dish_m: Number(data.get("dish_m")), min_elevation_deg: Number(data.get("min_elevation_deg")), bands: data.getAll("bands"), enabled: data.get("enabled") === "on",
  };
  const errors = groundSegment.update(id, next);
  const list = form.querySelector(".cm-errors");
  if (errors.length) { list.innerHTML = errors.map(error => `<li>${esc(error)}</li>`).join(""); list.hidden = false; return; }
  list.hidden = true;
  closeStationEditor();
  toast("success", "지상국 저장", next.name);
}

function addStation() {
  const preset = $("#comm-station-preset").value;
  try {
    const station = groundSegment.add(preset === "custom" ? { name: "", latitude: 37.5, longitude: 127 } : { preset });
    select({ type: "station", id: station.id });
    openStationEditor(station);
    toast("success", "지상국 추가", station.name);
  } catch (error) {
    toast("error", "지상국 추가 실패", error.message);
  }
}

function renderStationPresets() {
  const select = $("#comm-station-preset");
  if (!select) return;
  const current = select.value;
  select.innerHTML = groundSegment.availablePresets().map(preset => `<option value="${esc(preset.key)}">${esc(preset.name)} · ${esc(preset.region)}</option>`).join("") + `<option value="custom">직접 입력 (위도·경도)</option>`;
  if ([...select.options].some(option => option.value === current)) select.value = current;
}

/* ---------- rendering: centre ---------- */

function renderRouteControls() {
  const options = [...satellites().map(node => ({ id: node.id, name: node.name, kind: "위성" })), ...groundSegment.enabled.map(station => ({ id: station.id, name: station.name, kind: "지상국" }))];
  for (const [selector, fallbackIndex] of [["#comm-route-source", 0], ["#comm-route-target", options.length - 1]]) {
    const select = $(selector);
    const current = select.value;
    select.innerHTML = options.map(option => `<option value="${esc(option.id)}">${esc(option.name)} (${esc(option.kind)})</option>`).join("");
    select.value = options.some(option => option.id === current) ? current : options[Math.max(0, fallbackIndex)]?.id || "";
  }
}

function renderRoute() {
  const badge = $("#comm-route-badge");
  const detail = $("#comm-route-detail");
  const summary = $("#comm-route-summary");
  if (!routeRequest) { badge.textContent = "미계산"; summary.textContent = "경로 미계산"; detail.innerHTML = `<div class="cm-empty">출발지와 목적지를 고르고 <b>경로 계산</b>을 누르면 데이터 패브릭이 마지막 네트워크 상태에서 경로를 찾습니다. 경로는 매초 다시 계산됩니다.</div>`; return; }
  if (!reachable()) { badge.textContent = "패브릭 미응답"; summary.textContent = "패브릭 미응답"; detail.innerHTML = `<div class="cm-empty">데이터 패브릭이 응답하지 않습니다.</div>`; return; }
  if (!route) { badge.textContent = "계산 중"; summary.textContent = "계산 중…"; return; }
  if (route.status !== "available") {
    badge.textContent = route.status === "unavailable" ? "경로 없음" : "오류";
    summary.textContent = route.status === "unavailable" ? `${displayName(route.source)} → ${displayName(route.target)}: 사용 가능한 경로 없음` : route.detail || "경로 계산 오류";
    detail.innerHTML = `<div class="cm-empty">${esc(summary.textContent)}</div>`;
    return;
  }
  const objective = { latency: "최저 지연", reliability: "최대 신뢰도", balanced: "균형" }[route.objective] || route.objective;
  badge.textContent = `${route.hops}홉 · ${objective}`;
  summary.textContent = `${route.path.map(displayName).join(" → ")} · ${displayNumber(route.total_delay_ms, 1)} ms`;
  const hops = (route.hop_list || []).map((hop, index) => `<tr><td>${index + 1}</td><td>${esc(displayName(hop.from))} → ${esc(displayName(hop.to))}</td><td>${esc(LINK_KIND_LABELS[hop.kind] || hop.kind)}</td><td>${esc(displayNumber(hop.delay_ms, 1))}</td><td>${esc(displayNumber(hop.capacity_mbps / 1000, 2))}</td><td>${esc(hop.quality)}%</td></tr>`).join("");
  detail.innerHTML = `<div class="cm-route-totals"><span>편도 지연 <b>${esc(displayNumber(route.total_delay_ms, 1))} ms</b></span><span>병목 용량 <b>${esc(displayNumber(route.bottleneck_mbps / 1000, 2))} Gbps</b></span><span>경로 신뢰도 <b>${esc(displayNumber(route.reliability * 100, 1))}%</b></span></div>
    <div class="cm-table-wrap"><table><thead><tr><th>#</th><th>구간</th><th>종류</th><th>지연 ms</th><th>용량 Gbps</th><th>품질</th></tr></thead><tbody>${hops || `<tr><td colspan="6">같은 노드</td></tr>`}</tbody></table></div>`;
}

function renderPassStations() {
  const select = $("#comm-pass-station");
  if (!select) return;
  const stations = groundSegment.enabled;
  const current = passes.stationId || select.value;
  select.innerHTML = stations.map(station => `<option value="${esc(station.id)}">${esc(station.name)}</option>`).join("");
  if (stations.some(station => station.id === current)) select.value = current;
  const chosen = select.value || null;
  if (chosen !== passes.stationId) { passes = { stationId: chosen, items: [], computedAt: null, satellites: 0 }; }
}

function renderPasses() {
  const host = $("#comm-pass-list");
  if (!host) return;
  const station = stationById(passes.stationId);
  if (!station) { host.innerHTML = `<div class="cm-empty">사용 중인 지상국이 없습니다.</div>`; return; }
  if (!passes.computedAt) { host.innerHTML = `<div class="cm-empty">계산 중…</div>`; return; }
  const now = clock.now().getTime();
  const rows = passes.items.slice(0, 12).map(pass => {
    const live = pass.aos.getTime() <= now && now <= pass.los.getTime();
    return `<tr class="${live ? "live" : ""}"><td>${esc(pass.name)}</td><td>${esc(utcLabel(pass.aos).slice(11, 16))}</td><td>${esc(utcLabel(pass.los).slice(11, 16))}</td><td>${esc(displayNumber(pass.maxElevation, 0))}°</td><td>${esc(Math.round(pass.durationSeconds / 60))} min</td></tr>`;
  }).join("");
  host.innerHTML = rows
    ? `<div class="cm-table-wrap"><table><thead><tr><th>위성</th><th>AOS</th><th>LOS</th><th>최대 고각</th><th>지속</th></tr></thead><tbody>${rows}</tbody></table></div><small class="cm-foot">${esc(station.name)} · 마스크 ${esc(station.min_elevation_deg)}° · ${esc(utcLabel(new Date(passes.computedAt)).slice(11, 16))} UTC부터 ${PASS_HOURS} h · 위성 ${passes.satellites}기 · Kepler+J2 기하</small>`
    : `<div class="cm-empty">${esc(station.name)}에서 ${PASS_HOURS}시간 안에 마스크 위로 올라오는 위성이 없습니다.</div>`;
}

function renderDtn() {
  const host = $("#comm-dtn-list");
  const badge = $("#comm-dtn-badge");
  if (!host) return;
  if (!reachable()) { badge.textContent = "패브릭 미응답"; host.innerHTML = `<div class="cm-empty">데이터 패브릭이 응답하지 않아 저장 전달 상태를 알 수 없습니다.</div>`; return; }
  const summary = report?.summary || {};
  badge.textContent = `보관 ${displayNumber(summary.stored_mb, 0)} MB · 전달 ${displayNumber(summary.delivered_mb, 0)} MB${summary.dropped_mb ? ` · 폐기 ${displayNumber(summary.dropped_mb, 0)} MB` : ""}`;
  const rows = [...fabricNodes.values()].filter(node => node.kind === "satellite").sort((p, q) => (q.stored_mb || 0) - (p.stored_mb || 0) || String(displayName(p.id)).localeCompare(String(displayName(q.id))));
  const storing = rows.filter(node => node.custody === "storing" || node.custody === "full" || node.custody === "forwarding");
  const shown = (storing.length ? storing : rows).slice(0, 8);
  host.innerHTML = shown.length ? `<div class="cm-table-wrap"><table><thead><tr><th>위성</th><th>상태</th><th>보관 MB</th><th>생성 Mbps</th><th>다음 홉</th></tr></thead><tbody>${shown.map(node => `<tr class="${esc(node.custody)}"><td>${esc(displayName(node.id))}</td><td>${esc(CUSTODY_LABELS[node.custody] || node.custody)}</td><td>${esc(displayNumber(node.stored_mb, 1))}</td><td>${esc(displayNumber(node.generation_mbps, 1))}</td><td>${esc(node.next_hop ? displayName(node.next_hop) : "—")}</td></tr>`).join("")}</tbody></table></div><small class="cm-foot">${storing.length ? `보관 중 ${storing.length}기` : "모든 위성이 실시간 전달 중"} · 지상 연결 ${summary.satellites_with_ground_path ?? 0}/${summary.satellites ?? 0}기 · 평균 지상 지연 ${displayNumber(summary.mean_ground_delay_ms, 1)} ms</small>` : `<div class="cm-empty">위성이 없습니다.</div>`;
}

function diagramNodeStates() {
  const states = new Map();
  for (const node of satellites()) {
    const fabricNode = fabricNodes.get(node.id);
    const tone = toneOfSatellite(node);
    states.set(node.id, { tone: tone.tone, title: tone.title, badge: fabricNode?.stored_mb > 0 ? `${displayNumber(fabricNode.stored_mb, 0)} MB` : "" });
  }
  for (const station of groundSegment.enabled) {
    const fabricNode = fabricNodes.get(station.id);
    states.set(station.id, { tone: fabricNode?.serving?.length ? "ok" : "neutral", title: fabricNode ? `담당 위성 ${fabricNode.serving.length}기` : "", badge: fabricNode?.serving?.length ? `담당 ${fabricNode.serving.length}` : "" });
  }
  return states;
}

function renderDiagram() {
  const host = $("#comm-diagram");
  if (!host || viewMode !== "diagram") return;
  const nodes = satellites();
  const stations = groundSegment.enabled;
  const key = `${nodes.map(node => `${node.id}|${node.formation?.id}|${node.formation?.plane}|${Math.round(node.orbit.raan)}|${Math.round(node.orbit.mean_anomaly)}`).join(";")}#${stations.map(station => `${station.id}|${station.longitude}`).join(";")}`;
  if (key !== layoutKey) {
    layoutKey = key;
    layout = layoutNetwork({ satellites: nodes.map(node => ({ id: node.id, name: node.name, raan: node.orbit.raan, meanAnomaly: node.orbit.mean_anomaly, formation: node.formation })), stations });
  }
  const links = snapshot ? snapshot.links.filter(link => link.kind !== "ground" || link.state !== "no_radio").map(link => ({ ...link, ...(fabricLinks.get(link.id) || { usable: null, quality: null }) })) : [];
  host.innerHTML = nodes.length ? diagramMarkup(layout, links, { selected: selection, routeLinkIds, nodeStates: diagramNodeStates(), hideUnusable: true, flowTimeSeconds: performance.now() / 1000 }) : `<div class="cm-empty tall">배치된 위성이 없어 연결도를 그릴 수 없습니다.</div>`;
}

function renderSceneFoot() {
  const nodes = satellites();
  const usable = [...fabricLinks.values()].filter(link => link.usable);
  $("#comm-scene-summary").textContent = `위성 ${nodes.length}기 · 지상국 ${groundSegment.enabled.length} · OISL ${lastLinks.pairs.filter(pair => pair.state === "locked").length}/${lastLinks.pairs.length} 양방향 · 사용 가능 링크 ${reachable() ? usable.length : "—"}/${twinLinks.size}`;
}

function renderFabricChip() {
  const chip = $("#comm-fabric-chip");
  if (!chip) return;
  const endpoint = fabric?.endpoint();
  const where = endpoint?.placement === "remote" ? `외부 ${endpoint.base}` : fabricState.placement === "remote" ? `외부 ${fabricState.endpoint || ""} (서버 전달)` : "내장 임시 구현";
  const state = fabricState.reachable === null ? "확인 중" : fabricState.reachable ? `응답 ${fabricState.rtt ?? "—"} ms · #${fabricState.sequence ?? "—"}` : `미응답`;
  chip.className = `cm-fabric ${fabricState.reachable === false ? "down" : fabricState.reachable ? "up" : ""}`;
  chip.innerHTML = `<i></i><b>데이터 패브릭</b><span>${esc(where)}${fabricState.version ? ` v${esc(fabricState.version)}` : ""}</span><span class="cm-fabric-state">${esc(state)}</span>${fabricState.error && fabricState.reachable === false ? `<small>${esc(fabricState.error)}</small>` : ""}`;
}

/* ---------- rendering: right column ---------- */

function valueList(pairs) {
  return `<dl class="cm-values">${pairs.map(([label, value, cls]) => `<div><dt>${esc(label)}</dt><dd class="${esc(cls || "")}">${value}</dd></div>`).join("")}</dl>`;
}

// Wrap a block whose values move every tick; renderDetail swaps only these on a repeat render.
function live(markup) {
  return `<div data-live-block>${markup}</div>`;
}

function satelliteDetail(node) {
  const state = lastStates.get(node.id);
  const fabricNode = fabricNodes.get(node.id);
  const terminals = lastLinks.terminals.filter(terminal => terminal.nodeId === node.id);
  const pairs = lastLinks.pairs.filter(pair => pair.a === node.id || pair.b === node.id);
  const contacts = snapshot ? snapshot.links.filter(link => link.kind === "ground" && link.b === node.id && link.state === "visible") : [];
  const pathText = fabricNode?.ground_path ? fabricNode.ground_path.map(displayName).join(" → ") : reachable() ? "지상 경로 없음" : "패브릭 미응답";
  return `<header class="cm-detail-head"><span class="cm-kicker">${esc(BUS_PRESETS[node.bus]?.label || node.bus)} · ${esc(node.id)}</span><h3>${esc(node.name)}</h3><div class="cm-tags"><span class="cm-tag ${esc(node.mode)}">${esc(NODE_MODES[node.mode]?.label || node.mode)}</span><span class="cm-tag">${esc(nodeCatalogItem(node).ORBIT_REGIME || "—")}</span></div>
    <div class="cm-actions"><button data-detail-action="focus">뷰 정렬</button><button data-detail-action="route-from">여기서 출발</button><button data-detail-action="route-to">여기로 도착</button></div></header>
    <section class="cm-section"><h4>현재 위치 <small>Kepler + J2</small></h4>${live(valueList([
      ["위도 / 경도", `${esc(displayNumber(state?.geodetic.latitude, 2))}° / ${esc(displayNumber(state?.geodetic.longitude, 2))}°`],
      ["고도", `${esc(displayNumber(state?.geodetic.altitude, 1))} km`], ["속력", `${esc(displayNumber(state?.geodetic.velocity, 2))} km/s`], ["태양", state ? (state.sunlit ? "일조" : "식") : "—"]]))}</section>
    <section class="cm-section"><h4>데이터 패브릭 판정 <small>ICD-02</small></h4>${live(valueList([
      ["지상 경로", esc(pathText)], ["다음 홉", esc(fabricNode?.next_hop ? displayName(fabricNode.next_hop) : "—")],
      ["지상까지 지연", fabricNode?.ground_delay_ms != null ? `${esc(displayNumber(fabricNode.ground_delay_ms, 1))} ms · ${esc(fabricNode.ground_hops)}홉` : "—"],
      ["병목 용량", fabricNode?.ground_bottleneck_mbps != null ? `${esc(displayNumber(fabricNode.ground_bottleneck_mbps / 1000, 2))} Gbps` : "—"],
      ["저장 전달", fabricNode ? `${esc(CUSTODY_LABELS[fabricNode.custody] || fabricNode.custody)} · ${esc(displayNumber(fabricNode.stored_mb, 1))} / ${esc(displayNumber(fabricNode.capacity_mb, 0))} MB` : "—", fabricNode?.custody === "storing" || fabricNode?.custody === "full" ? "warn" : ""],
      ["데이터 생성", fabricNode ? `${esc(displayNumber(fabricNode.generation_mbps, 1))} Mbps` : "—"]]))}</section>
    <section class="cm-section" data-live-block><h4>OISL 링크 <small>${pairs.filter(pair => pair.state === "locked").length}/${pairs.length} 양방향</small></h4>${pairs.length ? `<div class="cm-chips">${pairs.map(pair => { const other = pair.a === node.id ? pair.b : pair.a; const verdict = fabricLinks.get(pair.key); return `<button class="cm-chip ${esc(pair.state)}" data-detail-link="${esc(pair.key)}"><b>${esc(displayName(other))}</b><small>${esc(phaseLabel(pair.state))}${verdict?.usable ? ` · ${esc(verdict.quality)}%` : ""}</small></button>`; }).join("")}</div>` : `<div class="cm-empty">활성 단말 ${terminals.length}기 · 잡은 상대 없음</div>`}</section>
    <section class="cm-section" data-live-block><h4>지상국 가시 <small>${contacts.length}곳</small></h4>${contacts.length ? `<div class="cm-chips">${contacts.map(link => { const verdict = fabricLinks.get(link.id); return `<button class="cm-chip ${verdict?.usable ? "locked" : "idle"}" data-detail-link="${esc(link.id)}"><b>${esc(displayName(link.a))}</b><small>${esc(link.band)} · 고각 ${esc(displayNumber(link.elevation_deg, 0))}°${verdict?.usable ? ` · ${esc(verdict.quality)}%` : verdict ? ` · ${esc(REASON_LABELS[verdict.reason] || "")}` : ""}</small></button>`; }).join("")}</div>` : `<div class="cm-empty">지금 마스크 위에 있는 지상국이 없습니다.</div>`}</section>
    <p class="cm-note">위치와 링크 기하는 디지털 트윈의 모의 계산, 경로·품질·저장 전달은 데이터 패브릭 모듈의 판정입니다. 실측이 아닙니다.</p>`;
}

function stationDetail(station) {
  const fabricNode = fabricNodes.get(station.id);
  const visible = snapshot ? snapshot.links.filter(link => link.kind === "ground" && link.a === station.id && link.state === "visible").sort((p, q) => q.elevation_deg - p.elevation_deg) : [];
  const altitude = coverageAltitudeKm();
  return `<header class="cm-detail-head"><span class="cm-kicker">지상국 · ${esc(station.id)}${station.region ? ` · ${esc(station.region)}` : ""}</span><h3>${esc(station.name)}</h3><div class="cm-tags">${station.bands.map(band => `<span class="cm-tag">${esc(band)}</span>`).join("")}<span class="cm-tag ${station.enabled === false ? "safe" : "nominal"}">${station.enabled === false ? "사용 안 함" : "사용 중"}</span></div>
    <div class="cm-actions"><button data-detail-action="focus">뷰 정렬</button><button data-detail-action="edit">편집</button><button data-detail-action="route-to">여기로 도착</button></div></header>
    <section class="cm-section"><h4>시설</h4>${valueList([
      ["위치", `${esc(displayNumber(station.latitude, 4))}°, ${esc(displayNumber(station.longitude, 4))}° · ${esc(displayNumber(station.altitude_km, 2))} km`],
      ["안테나", `${esc(displayNumber(station.dish_m, 1))} m · ${esc(station.bands.map(band => BAND_LABELS[band]).join(", "))}`],
      ["최소 고각", `${esc(station.min_elevation_deg)}°`],
      ["커버리지 반경", `${esc(displayNumber(coverageRadiusKm(altitude, station.min_elevation_deg), 0))} km (고도 ${esc(displayNumber(altitude, 0))} km 기준)`]])}</section>
    <section class="cm-section"><h4>데이터 패브릭 판정 <small>ICD-02</small></h4>${live(valueList([["담당 위성", fabricNode ? `${esc(fabricNode.serving.length)}기` : reachable() ? "—" : "패브릭 미응답"], ["사용 가능 링크", fabricNode ? `${esc(fabricNode.direct_links)}` : "—"]]))}</section>
    <section class="cm-section" data-live-block><h4>지금 가시 위성 <small>${visible.length}기</small></h4>${visible.length ? `<div class="cm-chips">${visible.map(link => { const verdict = fabricLinks.get(link.id); return `<button class="cm-chip ${verdict?.usable ? "locked" : "idle"}" data-detail-link="${esc(link.id)}"><b>${esc(displayName(link.b))}</b><small>${esc(link.band)} · 고각 ${esc(displayNumber(link.elevation_deg, 0))}° · ${esc(displayNumber(link.range_km, 0))} km${verdict?.usable ? ` · ${esc(verdict.quality)}%` : ""}</small></button>`; }).join("")}</div>` : `<div class="cm-empty">마스크 위에 있는 위성이 없습니다. 아래 접속창에서 다음 통과를 확인하세요.</div>`}</section>
    <p class="cm-note">가시 판정은 WGS84 기하와 최소 고각만 쓰며 지형과 굴절은 없습니다. 안테나 값은 대표 공학값입니다.</p>`;
}

function linkDetail(id) {
  const link = linkRecord(id);
  if (!link.kind) return `<div class="cm-empty tall">선택한 링크가 현재 네트워크 상태에 없습니다.</div>`;
  const verdict = fabricLinks.get(id) || null;
  const kindLabel = LINK_KIND_LABELS[link.kind] || link.kind;
  const twinState = link.kind === "oisl" ? phaseLabel(link.state) : link.kind === "ground" ? (link.state === "visible" ? `가시 · 고각 ${displayNumber(link.elevation_deg, 1)}° · 방위 ${displayNumber(link.azimuth_deg, 0)}°` : link.state === "no_radio" ? "지원 대역 없음" : "마스크 아래") : "지상망 연결";
  const verdictText = !reachable() ? "패브릭 미응답" : !verdict ? "—" : verdict.usable ? "사용 가능" : `사용 불가 · ${REASON_LABELS[verdict.reason] || verdict.reason || ""}`;
  const budget = link.kind === "ground" && link.frequency_ghz ? `<section class="cm-section"><h4>RF 링크 버짓 <small>Friis · 서버 계산</small></h4>
      <div class="cm-grid-3"><label>주파수 GHz <input id="comm-budget-frequency" type="number" step="0.1" value="${esc(link.frequency_ghz)}"></label><label>거리 km <input id="comm-budget-distance" type="number" step="1" value="${esc(Math.round(link.range_km || 0))}"></label><label>송신 W <input id="comm-budget-power" type="number" step="1" value="${esc(Math.round(10 ** (((link.eirp_dbw || 0) - ({ S: 3, X: 15, Ka: 20 }[link.band] || 0)) / 10)))}"></label>
      <label>Tx 이득 dBi <input id="comm-budget-tx-gain" type="number" step="1" value="${esc({ S: 3, X: 15, Ka: 20 }[link.band] || 0)}"></label><label>Rx 이득 dBi <input id="comm-budget-rx-gain" type="number" step="1" value="${esc(Math.round((link.gt_dbk || 0) + 10 * Math.log10({ S: 150, X: 200, Ka: 300 }[link.band] || 200)))}"></label><label>전송률 Mbps <input id="comm-budget-rate" type="number" step="1" value="${esc(link.data_rate_mbps || 1)}"></label></div>
      <div class="cm-actions"><button id="comm-budget-calculate" class="cm-primary">계산</button></div><div id="comm-budget-result" class="cm-budget"></div></section>` : link.kind === "oisl" ? `<p class="cm-note">OISL 여유는 단말 정격 거리 기준 자유공간 기하 여유(20 log10(정격 / 거리))이며 광 링크 예산이 아닙니다.</p>` : "";
  return `<header class="cm-detail-head"><span class="cm-kicker">${esc(kindLabel)}${link.band ? ` · ${esc(link.band)} 대역` : ""} · ${esc(id)}</span><h3>${esc(displayName(link.a))} ↔ ${esc(displayName(link.b))}</h3>
    <div class="cm-tags" data-live-block><span class="cm-tag ${verdict?.usable ? "nominal" : verdict ? "safe" : ""}">${esc(verdictText)}</span>${routeLinkIds.has(id) ? `<span class="cm-tag route">계산 경로 포함</span>` : ""}</div>
    <div class="cm-actions"><button data-detail-action="select-a">${esc(displayName(link.a))}</button><button data-detail-action="select-b">${esc(displayName(link.b))}</button></div></header>
    <section class="cm-section"><h4>디지털 트윈 기하</h4>${live(valueList([["상태", esc(twinState)], ["거리", `${esc(displayNumber(link.range_km ?? link.distance_km, 0))} km`],
      ...(link.kind === "oisl" ? [["기하 여유", `${esc(displayNumber(link.margin_db, 1))} dB`], ["정격 전송률", `${esc(displayNumber(link.data_rate_mbps / 1000, 1))} Gbps`]] : []),
      ...(link.kind === "ground" ? [["위성 EIRP", `${esc(displayNumber(link.eirp_dbw, 1))} dBW`], ["지상국 G/T", `${esc(displayNumber(link.gt_dbk, 1))} dB/K`], ["정격 전송률", `${esc(displayNumber(link.data_rate_mbps, 0))} Mbps`]] : []),
      ["장애 주입", link.faulted ? "링크 손실 적용 중" : "없음", link.faulted ? "warn" : ""]]))}</section>
    <section class="cm-section"><h4>데이터 패브릭 판정 <small>ICD-02</small></h4>${live(valueList([["편도 지연", verdict ? `${esc(displayNumber(verdict.delay_ms, 2))} ms` : "—"], ["용량", verdict ? `${esc(displayNumber(verdict.capacity_mbps / 1000, 2))} Gbps` : "—"],
      ["품질", verdict ? `${esc(verdict.quality)}%` : "—"], ["Eb/N0 여유", verdict?.margin_db != null ? `${esc(displayNumber(verdict.margin_db, 1))} dB` : "—"], ["BER", verdict?.ber != null ? esc(Number(verdict.ber).toExponential(1)) : "—"]]))}
      <canvas id="comm-quality-chart" class="cm-spark" width="280" height="44" aria-label="품질 이력"></canvas></section>${budget}`;
}

// The panel is rebuilt only when the selection changes. On every other tick the blocks marked
// data-live-block are swapped in place, so typed budget inputs and a computed budget survive.
function renderDetail() {
  const host = $("#comm-detail");
  const title = $("#comm-detail-title");
  if (!host) return;
  if (!selection) {
    if (detailKey !== "empty") {
      detailKey = "empty";
      title.textContent = "선택 항목";
      host.innerHTML = `<div class="cm-empty tall">왼쪽 목록이나 뷰에서 위성, 지상국, 링크를 고르면 트윈이 계산한 기하와 데이터 패브릭의 판정을 함께 보여 줍니다.</div>`;
    }
    return;
  }
  let markup;
  if (selection.type === "satellite") {
    const node = nodeById(selection.id);
    if (!node) { selection = null; renderDetail(); return; }
    title.textContent = "선택 위성"; markup = satelliteDetail(node);
  } else if (selection.type === "station") {
    const station = stationById(selection.id);
    if (!station) { selection = null; renderDetail(); return; }
    title.textContent = "선택 지상국"; markup = stationDetail(station);
  } else {
    title.textContent = "선택 링크"; markup = linkDetail(selection.id);
  }
  const key = `${selection.type}|${selection.id}`;
  if (key === detailKey) {
    const next = document.createElement("div");
    next.innerHTML = markup;
    const sources = next.querySelectorAll("[data-live-block]");
    host.querySelectorAll("[data-live-block]").forEach((block, index) => {
      const source = sources[index];
      if (source && source.innerHTML !== block.innerHTML) block.innerHTML = source.innerHTML;
    });
  } else {
    detailKey = key;
    host.innerHTML = markup;
    $("#comm-budget-calculate")?.addEventListener("click", calculateBudget);
  }
  if (selection.type === "link") {
    const canvas = $("#comm-quality-chart");
    const history = pushHistory(`comm-quality-${selection.id}`, fabricLinks.get(selection.id)?.usable ? fabricLinks.get(selection.id).quality : 0, QUALITY_HISTORY);
    if (canvas) drawSparkline(canvas, history, "#4ac4ee");
  }
  bindDetailActions();
}

function bindDetailActions() {
  const host = $("#comm-detail");
  host.querySelectorAll("[data-detail-link]").forEach(button => button.addEventListener("click", () => select({ type: "link", id: button.dataset.detailLink })));
  host.querySelectorAll("[data-detail-action]").forEach(button => button.addEventListener("click", () => {
    const action = button.dataset.detailAction;
    if (action === "focus") select(selection, { fly: true });
    if (action === "edit" && selection?.type === "station") { listMode = "stations"; syncListButtons(); renderList(); openStationEditor(stationById(selection.id)); }
    if (action === "route-from") { $("#comm-route-source").value = selection.id; calculateRoute(); }
    if (action === "route-to") { $("#comm-route-target").value = selection.id; calculateRoute(); }
    if (action === "select-a" || action === "select-b") {
      const link = linkRecord(selection.id);
      const id = action === "select-a" ? link.a : link.b;
      select(nodeById(id) ? { type: "satellite", id } : { type: "station", id });
    }
  }));
}

async function calculateBudget() {
  const link = linkRecord(selection?.id);
  const value = selector => Number($(selector)?.value);
  const payload = { link_id: String(selection.id).slice(0, 40), frequency_ghz: value("#comm-budget-frequency"), distance_km: value("#comm-budget-distance"), tx_power_w: Math.max(0.01, value("#comm-budget-power")),
    tx_gain_dbi: value("#comm-budget-tx-gain"), rx_gain_dbi: value("#comm-budget-rx-gain"), misc_losses_db: 6, bandwidth_mhz: Math.max(0.01, value("#comm-budget-rate") * 1.2), data_rate_mbps: Math.max(0.001, value("#comm-budget-rate")),
    system_temp_k: { S: 150, X: 200, Ka: 300 }[link.band] || 290, required_ebno_db: 9.6 };
  const host = $("#comm-budget-result");
  try {
    const result = await api.linkBudget(payload);
    host.innerHTML = [["자유공간 손실", `${result.fspl_db} dB`], ["수신 전력", `${result.received_power_dbw} dBW`], ["Eb/N0", `${result.ebno_db} dB`], ["여유", `${result.margin_db} dB`, result.margin_db >= 3 ? "ok" : result.margin_db >= 0 ? "warn" : "bad"], ["Shannon 용량", `${displayNumber(result.capacity_mbps, 0)} Mbps`]]
      .map(([label, text, cls]) => `<span class="${esc(cls || "")}"><small>${esc(label)}</small><b>${esc(text)}</b></span>`).join("");
  } catch (error) {
    host.innerHTML = `<span class="bad"><small>계산 실패</small><b>${esc(error.message)}</b></span>`;
  }
}

function renderAll() {
  renderCounts(); renderList(); renderRouteControls(); renderRoute(); renderPassStations(); renderPasses(); renderDtn(); renderDiagram(); renderSceneFoot(); renderFabricChip(); renderDetail();
}

/* ---------- membership ---------- */

function syncMembership() {
  const nodes = satellites();
  const stations = groundSegment.enabled;
  store.communication = {
    nodes: [...nodes.map(node => ({ id: node.name, type: "satellite", status: "online" })), ...stations.map(station => ({ id: station.name, type: "ground", status: "online" }))],
    links: snapshot ? snapshot.links.filter(link => link.kind !== "terrestrial").map(link => ({ id: link.id })) : [],
    queue: [],
  };
  if (selection?.type === "satellite" && !nodeById(selection.id)) selection = null;
  if (selection?.type === "station" && !stationById(selection.id)) selection = null;
  networkTwin.pruneHistories(nodes.map(node => node.id));
  passes = { ...passes, computedAt: null };
  renderStationPresets(); renderRouteControls(); renderPassStations();
  syncScene();
}

/* ---------- bindings ---------- */

function syncListButtons() {
  document.querySelectorAll("[data-comm-list]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.commList === listMode)));
}

function setViewMode(mode) {
  viewMode = mode === "diagram" ? "diagram" : "3d";
  document.querySelectorAll("[data-comm-view]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.commView === viewMode)));
  const diagram = $("#comm-diagram");
  const container = $("#comm-cesium");
  diagram.hidden = viewMode !== "diagram";
  container.style.visibility = viewMode === "3d" ? "visible" : "hidden";
  $("#view-communication .map-controls").hidden = viewMode !== "3d";
  $("#comm-lighting").disabled = viewMode !== "3d" || !globe?.viewer;
  document.querySelectorAll("[data-comm-scene]").forEach(button => { button.disabled = viewMode !== "3d" || !globe?.viewer; });
  if (viewMode === "diagram") renderDiagram();
}

function bind() {
  document.querySelectorAll("[data-comm-list]").forEach(button => button.addEventListener("click", () => { listMode = button.dataset.commList; syncListButtons(); renderList(); }));
  document.querySelectorAll("[data-comm-view]").forEach(button => button.addEventListener("click", () => setViewMode(button.dataset.commView)));
  $("#comm-list").addEventListener("click", event => {
    const satellite = event.target.closest("[data-comm-satellite]");
    const station = event.target.closest("[data-comm-station]");
    const link = event.target.closest("[data-comm-link]");
    if (satellite) select({ type: "satellite", id: satellite.dataset.commSatellite });
    else if (station) { select({ type: "station", id: station.dataset.commStation }); openStationEditor(stationById(station.dataset.commStation)); }
    else if (link) select({ type: "link", id: link.dataset.commLink });
  });
  $("#comm-list").addEventListener("dblclick", event => {
    const satellite = event.target.closest("[data-comm-satellite]");
    const station = event.target.closest("[data-comm-station]");
    if (satellite) select({ type: "satellite", id: satellite.dataset.commSatellite }, { fly: true });
    if (station) select({ type: "station", id: station.dataset.commStation }, { fly: true });
  });
  $("#comm-station-add").addEventListener("click", addStation);
  $("#comm-station-editor").addEventListener("submit", saveStationEditor);
  $("#comm-diagram").addEventListener("click", event => {
    const node = event.target.closest("[data-diagram-node]");
    const link = event.target.closest("[data-diagram-link]");
    if (node) { const id = node.dataset.diagramNode; select(nodeById(id) ? { type: "satellite", id } : { type: "station", id }); }
    else if (link) select({ type: "link", id: link.dataset.diagramLink });
  });
  document.querySelectorAll("[data-comm-scene]").forEach(button => button.addEventListener("click", () => {
    const mode = button.dataset.commScene;
    if (mode === "home") { modelLayer?.untrack(); globe?.home(); }
    if (mode === "focus" && selection) select(selection, { fly: true });
    if (mode === "tracks") { button.setAttribute("aria-pressed", String(globe.toggleTracks())); scene.update(clock.now(), true); }
    if (mode === "links") button.setAttribute("aria-pressed", String(scene.setLinksVisible(button.getAttribute("aria-pressed") !== "true")));
    if (mode === "ground") button.setAttribute("aria-pressed", String(scene.setGroundLinksVisible(button.getAttribute("aria-pressed") !== "true")));
    if (mode === "coverage") button.setAttribute("aria-pressed", String(scene.setCoverageVisible(button.getAttribute("aria-pressed") !== "true")));
    if (mode === "models") button.setAttribute("aria-pressed", String(scene.setModelsVisible(button.getAttribute("aria-pressed") !== "true")));
  }));
  $("#comm-route-calculate").addEventListener("click", calculateRoute);
  $("#comm-route-clear").addEventListener("click", clearRoute);
  $("#comm-route-objective").addEventListener("change", () => { if (routeRequest) calculateRoute(); });
  $("#comm-pass-station").addEventListener("change", event => { passes = { stationId: event.target.value, items: [], computedAt: null, satellites: 0 }; computePasses(); });
  $("#comm-pass-refresh").addEventListener("click", computePasses);
  $("#comm-fault-button").addEventListener("click", () => {
    const preferred = selection?.type === "satellite" ? nodeById(selection.id)?.name : selection?.type === "station" ? stationById(selection.id)?.name : selection?.id || null;
    openFaultDialog(preferred);
  });
  $("#comm-clock-pause").addEventListener("click", () => changeTime(() => clock.running ? clock.pause() : clock.play()));
  $("#comm-clock-now").addEventListener("click", () => changeTime(() => clock.live()));
  $("#comm-clock-back").addEventListener("click", () => changeTime(() => clock.step(-60)));
  $("#comm-clock-forward").addEventListener("click", () => changeTime(() => clock.step(60)));
  $("#comm-clock-speed").addEventListener("change", event => changeTime(() => clock.setSpeed(Number(event.target.value))));
  window.addEventListener("spacetwin:themechange", event => { globe?.setTheme(event.detail?.theme); lighting?.apply(); scene?.setTheme(event.detail?.theme); renderDiagram(); });
  document.addEventListener("keydown", event => { if (event.key === "Escape" && store.activeTab === "communication") modelLayer?.untrack({ aimAtEarth: true }); });
}

function onGroundSegmentChange(event) {
  if (event === "select") {
    if (!suppressStationSelect && groundSegment.selectedId && (selection?.type !== "station" || selection.id !== groundSegment.selectedId)) select({ type: "station", id: groundSegment.selectedId });
    return;
  }
  if (event === "add" || event === "update" || event === "remove" || event === "reset") syncMembership();
}

async function initialize() {
  if (initializing) return initializing;
  initializing = (async () => {
    globe = new GlobeController($("#comm-cesium"), $("#comm-globe-fallback"), { onSelect: onGlobeSelect, onHover: hoverSatellite, sunElement: $("#comm-space-sun") });
    // Stations and ground links are drawn by the network scene from the operator's station set,
    // not from the dashboard's fixed observer sites.
    globe.placeStationLink = () => {};
    globe.addGroundStations = () => {};
    modelLayer = new SatelliteModelLayer({
      viewer: () => globe.viewer, timeSource: () => clock.now(), onTrackingChange: renderTrackingState,
      isTransitioning: () => globe.sceneTransitioning, onFrame: date => { globe.syncSelected(date); scene?.syncFrame(date); },
    });
    globe.wheelOverride = delta => modelLayer.zoomBy(delta);
    modelLayer.onCameraInput = () => globe.cancelCameraMotion();
    globe.onCameraInput = () => modelLayer.interruptCamera();
    globe.onCameraMove = () => modelLayer.untrack();
    scene = new NetworkScene({ globe, timeSource: () => clock.now(), coverageRadiusKm: station => coverageRadiusKm(coverageAltitudeKm(), station.min_elevation_deg) });
    const result = await globe.init();
    const zoomControls = bindZoomControls({
      slider: $("#comm-zoom"), zoomIn: $("#comm-zoom-in"), zoomOut: $("#comm-zoom-out"), focus: $("#comm-map-locate"),
      canFocus: () => viewMode === "3d" && (selection?.type === "station" ? !!stationById(selection.id)
        : selection?.type === "satellite" && !!nodeById(selection.id) && globe.positions.has(idOf(nodeById(selection.id)))),
    }, globe, modelLayer);
    const removeZoomSync = globe.viewer?.scene.postRender.addEventListener(zoomControls.sync);
    window.addEventListener("pagehide", () => removeZoomSync?.(), { once: true });
    globe.setTheme(document.documentElement?.dataset?.theme);
    lighting = bindLightingToggle($("#comm-lighting"), () => globe);
    lighting.apply();
    scene.setTheme(document.documentElement?.dataset?.theme);
    $("#comm-globe-loading").classList.add("hidden");
    if (result.mode === "cesium" && window.Cesium) {
      const handler = new window.Cesium.ScreenSpaceEventHandler(globe.viewer.scene.canvas);
      handler.setInputAction(movement => { const id = scene.stationAt(movement.position); if (id) select({ type: "station", id }); }, window.Cesium.ScreenSpaceEventType.LEFT_CLICK);
      handler.setInputAction(movement => { const id = scene.stationAt(movement.position); if (id) select({ type: "station", id }, { fly: true }); }, window.Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    } else {
      setViewMode("diagram");
      document.querySelectorAll("[data-comm-view='3d']").forEach(button => { button.disabled = true; });
    }
    renderTrackingState(false);
    // A trail per satellite hides the links on a constellation of this size, so the communication
    // view starts with trails off; the toolbar turns them back on.
    if (globe.tracksVisible) globe.toggleTracks();
    document.querySelectorAll('[data-comm-scene="tracks"]').forEach(button => button.setAttribute("aria-pressed", "false"));
    initialized = true;
    setViewMode(viewMode);
    await syncScene();
    pollStatus();
  })();
  return initializing;
}

function setActive(next) {
  active = next;
  clearInterval(tickTimer); tickTimer = null;
  clearInterval(statusTimer); statusTimer = null;
  if (!active) return;
  initialize().then(() => {
    tick(true);
    tickTimer = setInterval(() => tick(), 1000);
    statusTimer = setInterval(pollStatus, STATUS_POLL_MS);
  });
}

export function initCommunication() {
  view = $("#view-communication");
  if (!view || !$("#comm-list")) return;
  clock = new OrbitClock();
  fabric = networkTwin.fabric;
  groundSegment.load();
  // The scenario player asks this tab to show the route it judges (source → gateway).
  on("scenario:route", spec => {
    if (!spec?.source || !spec?.target) return;
    routeRequest = { source: spec.source, target: spec.target, objective: spec.objective || "latency" };
    const source = $("#comm-route-source"); const target = $("#comm-route-target"); const objective = $("#comm-route-objective");
    if (source && [...source.options].some(option => option.value === spec.source)) source.value = spec.source;
    if (target && [...target.options].some(option => option.value === spec.target)) target.value = spec.target;
    if (objective) objective.value = routeRequest.objective;
    if (reachable()) requestRoute(); else renderRoute();
  });
  groundSegment.subscribe(onGroundSegmentChange);
  constellation.subscribe(event => { if (event === "deploy" || event === "load") syncMembership(); });
  bind();
  loadSatelliteModels().then(manifest => {
    if (!manifest) return;
    resolveModel = createModelResolver(manifest);
    if (initialized) syncScene();
  });
  renderStationPresets(); renderCounts(); renderList(); renderRouteControls(); renderRoute(); renderPassStations(); renderPasses(); renderDtn(); renderFabricChip(); renderDetail(); renderClock();
  syncListButtons();
  new MutationObserver(() => {
    const isActive = view.classList.contains("active");
    if (isActive !== active) setActive(isActive);
  }).observe(view, { attributes: true, attributeFilter: ["class"] });
  if (view.classList.contains("active")) setActive(true);
  window.addEventListener("pagehide", () => { clearInterval(tickTimer); clearInterval(statusTimer); });
}

// The runtime's active faults are read on every tick; server telemetry has no other authority here.
export function updateCommunicationTelemetry() {}
