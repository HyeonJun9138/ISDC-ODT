import { api } from "/static/communication/api.js?v=20260907-1";
import { GlobeController } from "/static/visualization/globe.js?v=20260908-oisl-flow1";
import { GROUND_STATIONS, stationGroups } from "/static/model_library/ground_station_sites.js";
import { stationCardModel, stationOptionMarkup, visibleSatelliteCount } from "../orbit/station_card.js";
import { lookAnglesAt } from "/static/simulation/orbit.js?v=20260907-2";
import { emit, on, setState, store } from "../state.js";
import { constellation } from "../nodes/constellation.js";
import { bindLightingToggle } from "../orbit/globe_lighting.js";
import { bindZoomControls } from "../orbit/zoom_controls.js";
import { OrbitClock } from "../orbit/clock.js?v=20260908-scenario1";
import { displayNumber, utcLabel, escapeMarkup as esc, selectCatalog } from "../orbit/catalog.js";
import { createCatalogList } from "../orbit/catalog_view.js";
import { createInspector } from "../orbit/inspector.js";
import { SatelliteModelLayer } from "/static/visualization/satellite_model.js?v=20260908-camera2";
import { createModelResolver, describeMatch, loadSatelliteModels } from "../orbit/satellite_models.js";
import { loading } from "../loading.js";

const $ = selector => document.querySelector(selector);
const FAVORITES_KEY = "spacetwin-orbit-favorites-v1";
const SOURCE_LABELS = {
  "celestrak-live": "CelesTrak GP / 수집 완료", "celestrak-cache": "CelesTrak GP / 캐시",
  "celestrak-stale": "CelesTrak GP / 이전 스냅샷 (갱신 실패)",
  "demo-fallback": "DEMO / 원형 2체 모의", "upstream-unavailable": "GP 미제공 / 상류 연결 확인",
};
let globe, clock, list, inspector, modelLayer, lighting;
let resolveModel = () => null;
let catalog = {}, catalogItems = [], itemById = new Map(), visibleItems = [];
let requestToken = 0, searchTimer, tickTimer, lastPathTime = null, lastListPaint = 0;
let catalogRender = Promise.resolve(), renderState = "ready";
let passTimer, passRevision = 0, passBasis = null, lastPassWall = 0;
let ready = false, selectedId = null, sort = "name", direction = "asc", favoritesOnly = false, orbitRegime = "all";
// Ground-site card in the right column: the site being shown and the cached next pass for it.
let stationCardKey = null, stationPassCache = { key: null, pass: null };
let favorites = new Set();

function loadFavorites() {
  try {
    const data = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
    favorites = new Set(Array.isArray(data) ? data.filter(id => /^\d{1,9}$/.test(String(id))).map(String) : []);
  } catch { favorites = new Set(); }
}

function updateFavorites() {
  const saved = favorites.has(selectedId);
  const button = $("#selected-favorite");
  button.disabled = !selectedId;
  button.textContent = saved ? "★" : "☆";
  button.setAttribute("aria-pressed", String(saved));
  button.setAttribute("aria-label", saved ? "선택 위성 관심 해제" : "선택 위성 관심 등록");
}

// SDC is not an orbit class: it narrows the list to the satellites deployed from the node tab
// (Space Data Center nodes) before the usual query, favourite and sort policy applies.
function filterCatalog() {
  const sdcOnly = orbitRegime === "SDC";
  globe?.setSdcMode(sdcOnly);
  visibleItems = selectCatalog(sdcOnly ? catalogItems.filter(item => item.node === true) : catalogItems, {
    query: $("#satellite-search").value, orbit: sdcOnly ? "all" : orbitRegime,
    favoritesOnly, favorites, sort, direction,
  });
  list.setItems(visibleItems, favorites);
  list.select(selectedId);
  globe?.setVisibleSatellites(visibleItems.map(item => String(item.NORAD_CAT_ID)));
  $("#catalog-count").textContent = `${visibleItems.length.toLocaleString()} / ${catalogItems.length.toLocaleString()} 개`;
  $("#catalog-sort-label").textContent = `${{ name: "이름", id: "NORAD", orbit: "궤도군", age: "Epoch 경과" }[sort]} ${direction === "asc" ? "↑" : "↓"}`;
  document.querySelectorAll("[data-catalog-sort]").forEach(button => {
    const active = button.dataset.catalogSort === sort;
    button.querySelector("i").textContent = active ? direction === "asc" ? "↑" : "↓" : "";
    button.setAttribute("aria-label", `${button.dataset.catalogSort} 정렬${active ? direction === "asc" ? ", 오름차순" : ", 내림차순" : ""}`);
  });
}

function selectSatellite(item, position, id, context = {}) {
  const changed = selectedId !== String(id);
  // Clicking the already selected body again releases the selection.
  if (!changed && context.userInitiated && !context.focus) { clearSelection(); return; }
  selectedId = String(id);
  store.selectedSatellite = selectedId;
  if (changed) {
    inspector.select(item, catalog, clock.now());
    list.select(selectedId, context.userInitiated === true);
    updateFavorites();
    showModel(item, selectedId);
    schedulePasses();
    emit("satellite:selected", { item, position, id: selectedId });
  }
  if (context.focus) focusSelected();
  else if (context.userInitiated) centerSelected();
  inspector.update(position, clock.now(), { libraryAvailable: !!globe.satelliteLib });
  renderObservation(position);
}

// NASA 3D Resources shape: a display aid resolved from the manifest, never an identification source.
function renderShape(match) {
  const text = describeMatch(match);
  const state = $("#shape-state");
  if (!state) return;
  state.textContent = text.state;
  state.dataset.quality = match?.quality || "none";
  $("#shape-label").textContent = text.label;
  $("#shape-note").textContent = text.note;
  const credit = $("#shape-credit");
  if (credit) {
    credit.hidden = !text.credit;
    credit.textContent = text.creditUrl ? `${text.credit} ↗` : text.credit;
    if (text.creditUrl) credit.href = text.creditUrl; else credit.removeAttribute("href");
  }
  const image = $("#shape-image");
  if (match) { image.src = match.thumbnail; image.alt = text.alt; image.hidden = false; }
  else { image.removeAttribute("src"); image.alt = ""; image.hidden = true; }
}

function showModel(item, id) {
  const match = item ? resolveModel(item) : null;
  renderShape(match);
  if (!modelLayer) return;
  if (!item) { modelLayer.clear(); return; }
  // Objects without a model keep a follow target so the camera can still frame the point marker.
  modelLayer.show(match ? { satelliteId: id, ...match } : { satelliteId: id }, date => globe.positionAt(id, date), clock.now());
}

function focusSelected() {
  if (!selectedId || !modelLayer) return;
  if (!modelLayer.focus(clock.now())) renderTrackingState(modelLayer.tracking === true);
}

// No selected body: the globe, model layer, inspector, list, passes and observation all reset.
function clearSelection() {
  selectedId = null;
  store.selectedSatellite = null;
  globe?.clearSelection?.();
  inspector.clear();
  showModel(null, null);
  list.select(null);
  updateFavorites();
  invalidatePasses("위성을 선택하세요.");
  renderObservation(null);
  renderTrackingState(false);
}

// A user selection centres the body under a top-down camera at the current distance; only
// the explicit locate action (button, double click) moves in close.
function centerSelected() {
  if (!selectedId || !modelLayer) return;
  if (!modelLayer.focus(clock.now(), { keepRange: true })) renderTrackingState(modelLayer.tracking === true);
}

function renderTrackingState(tracking) {
  const label = $("#render-mode");
  if (!label) return;
  const is2D = globe?.viewer && window.Cesium?.SceneMode && globe.viewer.scene.mode === window.Cesium.SceneMode.SCENE2D;
  if (is2D) {
    label.textContent = tracking ? "2D 북쪽 위 / 선택 위성 중심 (휠: 지도 축척, Esc·뷰 초기화: 해제)" : "2D 북쪽 위 / 지도 좌표";
    return;
  }
  label.textContent = tracking
    ? "위성 추적 / 실제 축척 (휠: 거리, 멀리 축소하거나 Esc, 뷰 초기화: 해제)"
    : globe?.viewer ? "지구 고정 좌표 / Cesium" : "2D 좌표도 / 바탕지도 미제공";
}

function hoverSatellite(payload) {
  const card = $("#satellite-hover-card");
  if (!payload?.item || !payload.screen) { card.hidden = true; return; }
  card.innerHTML = `<b>${esc(payload.item.OBJECT_NAME)}</b><small>NORAD ${esc(payload.id)} / ${esc(payload.item.ORBIT_REGIME)} / ${displayNumber(payload.position?.altitude)} km</small>`;
  const scene = card.parentElement;
  card.hidden = false;
  card.style.left = `${Math.max(6, Math.min(scene.clientWidth - card.offsetWidth - 8, payload.screen.x + 12))}px`;
  card.style.top = `${Math.max(38, Math.min(scene.clientHeight - card.offsetHeight - 30, payload.screen.y + 48))}px`;
}

// Satellites deployed from the node tab join the GP snapshot as explicit Kepler + J2 nodes. They are
// listed after the catalog and never replace or mask a real GP object.
function withDeployedNodes(items) {
  return [...items, ...constellation.deployedItems()];
}

// Apply a catalog payload (GP snapshot plus deployed nodes) to the list, globe and inspector.
async function applyCatalog(payload, token) {
  ready = false;
  invalidatePasses("새 GP 스냅샷을 적용하고 있습니다…");
  catalog = payload;
  catalogItems = withDeployedNodes(payload.items || []);
  itemById = new Map(catalogItems.map(item => [String(item.NORAD_CAT_ID), item]));
  store.livePositions.clear();
  if (!itemById.has(selectedId)) { selectedId = null; store.selectedSatellite = null; inspector.clear(); showModel(null, null); }
  else inspector.select(itemById.get(selectedId), catalog, clock.now());
  setState({ satellites: catalogItems, satelliteSource: payload.source, satelliteCatalog: payload }, "satellites");
  filterCatalog();
  globe.currentDate = clock.now();
  globe.selectedId = selectedId || (itemById.has("25544") ? "25544" : String(visibleItems[0]?.NORAD_CAT_ID || ""));
  renderState = "loading";
  const rendering = globe.setSatellites(catalogItems);
  catalogRender = rendering;
  rendering.then(
    () => { if (catalogRender === rendering) renderState = "ready"; },
    () => { if (catalogRender === rendering) renderState = "failed"; },
  );
  await rendering;
  if (token !== requestToken) return;
  ready = true;
  list.select(selectedId, true);
  updateFavorites();
  renderCatalogStatus();
  if (!catalogItems.length) $("#satellite-list").innerHTML = '<div class="oc-empty">카탈로그를 사용할 수 없습니다.<br>그룹 변경 또는 다시 조회를 시도하세요.</div>';
  tick(true); schedulePasses();
}

export async function loadSatellites() {
  const token = ++requestToken;
  const group = $("#satellite-group").value;
  $("#satellite-list").setAttribute("aria-busy", "true");
  $("#catalog-source").textContent = `${group} 카탈로그 조회 중… 기존 화면은 마지막 스냅샷입니다.`;
  $("#satellite-refresh").disabled = true;
  try {
    const payload = await api.satellites({ group, limit: 0 });
    loading.report("catalog", 1);
    if (token !== requestToken) return;
    await applyCatalog(payload, token);
  } catch (error) {
    if (token !== requestToken) return;
    // A newer HTTP failure must not expose a partially assembled older
    // response. Wait for the renderer that actually owns the visible snapshot.
    await catalogRender.catch(() => {});
    if (token !== requestToken) return;
    ready = renderState === "ready" && catalogItems.length > 0;
    renderCatalogStatus(error);
    tick(true);
    schedulePasses();
  } finally {
    if (token === requestToken) {
      $("#satellite-refresh").disabled = false;
      $("#satellite-list").setAttribute("aria-busy", "false");
    }
  }
}

function renderCatalogStatus(error = null) {
  const source = SOURCE_LABELS[catalog.source] || "출처 미확인";
  $("#catalog-source").textContent = `${error ? "조회 실패 / 적용 스냅샷 유지: " : ""}${source} / ${catalogItems.length.toLocaleString()} 개 / 수집 UTC ${utcLabel(catalog.fetched_at, false)}`;
  $("#catalog-source").title = error?.message || catalog.warning || "GP 캐시 2시간. 조회 버튼은 상류 강제 갱신을 의미하지 않습니다.";
  const sourceChip = $("#source-chip");
  if (sourceChip) sourceChip.textContent = catalog.source === "demo-fallback" ? "DEMO / 모의 궤도" : catalogItems.length ? `${catalogItems.length.toLocaleString()} objects / GP snapshot` : "GP 카탈로그 미제공";
  renderTrackingState(modelLayer?.tracking === true);
}

function renderClock() {
  const date = clock.now();
  $("#orbit-clock").textContent = utcLabel(date);
  $("#orbit-clock").dateTime = date.toISOString();
  $("#orbit-clock-mode").textContent = clock.isLive ? "현재 시각" : clock.running ? "시간 탐색" : "일시정지";
  $("#orbit-pause").textContent = clock.running ? "Ⅱ" : "▶";
  $("#orbit-pause").setAttribute("aria-label", clock.running ? "분석 시계 일시정지" : "분석 시계 재생");
  $("#orbit-speed").value = String(clock.speed);
  $("#orbit-now").setAttribute("aria-pressed", String(clock.isLive));
}

function renderObservation(position) {
  const station = GROUND_STATIONS[$("#ground-station").value];
  const look = position ? lookAnglesAt(position, station) : null;
  const mask = Number($("#elevation-mask").value);
  $("#observer-azimuth").textContent = displayNumber(look?.azimuth);
  $("#observer-elevation").textContent = displayNumber(look?.elevation);
  $("#observer-range").textContent = displayNumber(look?.rangeKm);
  $("#station-coordinates").textContent = `${station.latitude.toFixed(4)}°, ${station.longitude.toFixed(4)}° / h = 0 km 가정`;
  const visible = look !== null && look.elevation >= mask;
  $("#observer-visibility").textContent = !selectedId ? "위성 미선택" : !look ? "전파값 미제공" : visible ? "마스크 이상" : "마스크 미만";
  $("#observer-visibility").classList.toggle("visible", visible);
  $("#observer-visibility").title = "지형, 대기 굴절, 날씨, 안테나와 링크 예산을 고려하지 않은 기하학적 판정입니다.";
}

// Ground-site card: site facts from the reference list plus live geometry of the selected body.
function showStation(key) {
  if (!GROUND_STATIONS[key]) return;
  stationCardKey = key;
  $("#station-card").hidden = false;
  renderStationCard();
  $("#station-card").scrollIntoView?.({ block: "nearest" });
}

function hideStation() {
  stationCardKey = null;
  $("#station-card").hidden = true;
}

function stationNextPass(site, mask) {
  const cacheKey = selectedId ? `${selectedId}|${site.key}|${mask}|${passBasis}` : null;
  if (stationPassCache.key === cacheKey) return stationPassCache.pass;
  const pass = selectedId ? globe.predictPasses(selectedId, site.key, 24, { maskDegrees: mask, maxPasses: 1 })[0] || null : null;
  stationPassCache = { key: cacheKey, pass };
  return pass;
}

function renderStationCard() {
  if (!stationCardKey) return;
  const site = GROUND_STATIONS[stationCardKey];
  if (!site) { hideStation(); return; }
  const date = clock.now();
  const mask = Number($("#elevation-mask").value);
  const position = selectedId ? globe.positionAt(selectedId, date) : null;
  const look = position ? lookAnglesAt(position, site) : null;
  const model = stationCardModel(site, {
    selectedName: selectedId ? itemById.get(selectedId)?.OBJECT_NAME || `NORAD ${selectedId}` : null,
    look, maskDegrees: mask,
    visibleCount: visibleSatelliteCount(globe.positions.values(), site, mask, (p, s) => globe.elevationAt(p, s)),
    catalogCount: globe.positions.size,
    nextPass: stationNextPass(site, mask),
    isObserver: $("#ground-station").value === site.key,
  });
  $("#station-card-kicker").textContent = model.kicker;
  $("#station-card-title").textContent = model.title;
  $("#station-card-subtitle").textContent = model.subtitle;
  $("#station-card-facts").innerHTML = model.facts.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("");
  $("#station-card-live").innerHTML = model.live.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("");
  $("#station-card-state").dataset.state = model.state;
  $("#station-card-state").textContent = { none: "위성 미선택", unknown: "전파값 미제공", visible: "가시", hidden: "비가시" }[model.state];
  $("#station-card-note").textContent = model.note;
  $("#station-card-observe").disabled = model.isObserver;
  $("#station-card-observe").textContent = model.isObserver ? "현재 관측 기준" : "관측 기준으로 설정";
}

function populateStationSelect() {
  const select = $("#ground-station");
  const current = GROUND_STATIONS[select.value] ? select.value : "SEOUL";
  select.innerHTML = stationOptionMarkup(stationGroups(GROUND_STATIONS), current);
  select.value = current;
}

function invalidatePasses(message) {
  clearTimeout(passTimer);
  passRevision++;
  passBasis = null;
  $("#pass-list").innerHTML = `<tr><td colspan="5">${esc(message)}</td></tr>`;
  $("#pass-timeline").replaceChildren();
  $("#pass-reference").textContent = "—";
}

function schedulePasses() {
  invalidatePasses("관측창 계산 중…");
  const revision = passRevision;
  passTimer = setTimeout(() => {
    if (revision !== passRevision) return;
    if (!ready || !selectedId || !globe.positionAt(selectedId, clock.now())) {
      $("#pass-list").innerHTML = '<tr><td colspan="5">유효한 위성 전파값이 있어야 관측창을 계산할 수 있습니다.</td></tr>';
      $("#pass-reference").textContent = "—";
      return;
    }
    const station = $("#ground-station").value;
    const mask = Number($("#elevation-mask").value);
    const start = clock.now();
    globe.currentDate = start;
    let missingSamples = 0;
    const passes = globe.predictPasses(selectedId, station, 24, {
      maskDegrees: mask, maxPasses: 100,
      onSample: position => { if (!position) missingSamples++; },
    });
    passBasis = start.getTime(); lastPassWall = Date.now();
    $("#pass-reference").textContent = `${missingSamples ? "부분 계산 / " : ""}기준 ${utcLabel(start).slice(5)} UTC`;
    $("#pass-reference").title = missingSamples ? `전파 결측 ${missingSamples}개. 전체 24시간의 관측창 가용성을 보장하지 않습니다.` : "지형과 굴절을 제외한 좌표 기반 예측입니다.";
    $("#pass-list").innerHTML = passes.length ? passes.map(pass => {
      const boundary = pass.inProgress ? "진행 중*" : pass.truncated ? "부분 구간*" : "완전";
      const aos = utcLabel(pass.aos).slice(5), los = utcLabel(pass.los).slice(5);
      return `<tr><td><button data-pass-time="${pass.aos.getTime()}" title="${esc(aos)} UTC로 이동">${esc(aos)}</button></td><td>${esc(los)}</td><td>${displayNumber(pass.maxElevation)}°</td><td>${Math.floor(pass.durationSeconds / 60)}m ${Math.round(pass.durationSeconds % 60)}s</td><td title="* 검색창 경계 또는 전파 결측으로 실제 AOS/LOS가 확인되지 않은 구간">${boundary}</td></tr>`;
    }).join("") : `<tr><td colspan="5">${missingSamples ? "전파 결측으로 24시간 관측창 여부를 판정할 수 없습니다." : `24시간 내 ${mask}° 이상 관측창 없음`}</td></tr>`;
    $("#pass-timeline").innerHTML = passes.map(pass => `<button data-pass-time="${pass.aos.getTime()}" style="left:${Math.max(0, (pass.aos - start) / 86400000 * 100)}%;width:${Math.min(100, pass.durationSeconds / 86400 * 100)}%" title="${esc(utcLabel(pass.aos))} UTC / 최대 고각 ${displayNumber(pass.maxElevation)}°" aria-label="${esc(utcLabel(pass.aos))} 관측창으로 이동"></button>`).join("");
  }, 100);
}

function tick(force = false) {
  if (!clock) return;
  renderClock();
  if (!ready || (store.activeTab !== "orbit" && !force)) return;
  const date = clock.now();
  // The trajectory is sampled densely only around its reference time, so rebuild inside that window.
  const rebuild = force || lastPathTime === null || Math.abs(date.getTime() - lastPathTime) > 30000;
  globe.update(date, rebuild);
  modelLayer?.update(date);
  if (rebuild) lastPathTime = date.getTime();
  const position = selectedId ? globe.positionAt(selectedId, date) : null;
  inspector.update(position, date, { libraryAvailable: !!globe.satelliteLib });
  renderObservation(position);
  renderStationCard();
  $("#orbit-locate").disabled = !position || !globe.viewer;
  const failed = catalogItems.length - globe.positions.size;
  $("#orbit-status").textContent = failed > 0 ? `전파 미제공 ${failed.toLocaleString()} / 실측 아님` : "기하학적 예측 / 실측 텔레메트리 아님";
  if (passBasis !== null && Math.abs(date.getTime() - passBasis) >= 300000 && Date.now() - lastPassWall > 5000) schedulePasses();
  if (Date.now() - lastListPaint >= 60000) { list.paint(); lastListPaint = Date.now(); }
}

function changeTime(action) { action(); tick(true); schedulePasses(); }

function bindControls() {
  $("#satellite-search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(filterCatalog, 100); });
  $("#satellite-group").addEventListener("change", loadSatellites);
  document.querySelectorAll("[data-orbit-regime]").forEach(button => button.addEventListener("click", () => {
    orbitRegime = button.dataset.orbitRegime || "all";
    document.querySelectorAll("[data-orbit-regime]").forEach(other => other.setAttribute("aria-pressed", String(other === button)));
    filterCatalog();
  }));
  // A theme change resets the globe's lighting flags, so the day/night preference is re-applied after it.
  window.addEventListener("spacetwin:themechange", event => { globe?.setTheme(event.detail?.theme); lighting?.apply(); });
  $("#satellite-refresh").addEventListener("click", loadSatellites);
  $("#favorites-only").addEventListener("click", event => {
    favoritesOnly = !favoritesOnly;
    event.currentTarget.setAttribute("aria-pressed", String(favoritesOnly)); filterCatalog();
  });
  $("#selected-favorite").addEventListener("click", () => {
    if (!selectedId) return;
    if (favorites.has(selectedId)) favorites.delete(selectedId); else favorites.add(selectedId);
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites])); } catch { /* Session-only favorites when storage is unavailable. */ }
    updateFavorites(); filterCatalog();
  });
  document.querySelectorAll("[data-catalog-sort]").forEach(button => button.addEventListener("click", () => {
    if (sort === button.dataset.catalogSort) direction = direction === "asc" ? "desc" : "asc";
    else { sort = button.dataset.catalogSort; direction = "asc"; }
    filterCatalog();
  }));
  $("#orbit-pause").addEventListener("click", () => changeTime(() => clock.running ? clock.pause() : clock.play()));
  $("#orbit-now").addEventListener("click", () => changeTime(() => clock.live()));
  $("#orbit-back").addEventListener("click", () => changeTime(() => clock.step(-60)));
  $("#orbit-forward").addEventListener("click", () => changeTime(() => clock.step(60)));
  $("#orbit-speed").addEventListener("change", event => changeTime(() => clock.setSpeed(Number(event.target.value))));
  $("#orbit-seek-open").addEventListener("click", () => {
    $("#orbit-seek-form").hidden = false;
    $("#orbit-seek-input").value = clock.now().toISOString().slice(0, 19);
    $("#orbit-seek-input").focus();
  });
  $("#orbit-seek-cancel").addEventListener("click", () => { $("#orbit-seek-form").hidden = true; });
  $("#orbit-seek-form").addEventListener("submit", event => {
    event.preventDefault();
    const date = new Date(`${$("#orbit-seek-input").value}Z`);
    if (!Number.isFinite(date.getTime())) return;
    changeTime(() => clock.seek(date)); $("#orbit-seek-form").hidden = true;
  });
  for (const id of ["#ground-station", "#elevation-mask"]) $(id).addEventListener("change", () => {
    globe.setObserver($("#ground-station").value, Number($("#elevation-mask").value));
    tick(true); schedulePasses();
  });
  $("#station-card-close").addEventListener("click", hideStation);
  $("#station-card-fly").addEventListener("click", () => { if (stationCardKey) globe.flyToStation(stationCardKey); });
  $("#station-card-observe").addEventListener("click", () => {
    if (!stationCardKey) return;
    $("#ground-station").value = stationCardKey;
    $("#ground-station").dispatchEvent(new Event("change"));
  });
  $("#pass-refresh").addEventListener("click", schedulePasses);
  $("#view-orbit").addEventListener("click", event => {
    const button = event.target.closest("[data-pass-time]");
    if (button) changeTime(() => clock.seek(new Date(Number(button.dataset.passTime))));
  });
  $("#imagery-layer").addEventListener("change", async event => { event.target.value = await globe.setImagery(event.target.value); });
  document.querySelectorAll("[data-globe-mode]").forEach(button => button.addEventListener("click", () => {
    const mode = button.dataset.globeMode;
    if (mode === "home") { clearSelection(); globe.home(); }
    if (mode === "selected" && selectedId) globe.select(selectedId, false, { userInitiated: true, focus: true });
    if (mode === "tracks") button.setAttribute("aria-pressed", String(globe.toggleTracks()));
    if (mode === "labels") button.setAttribute("aria-pressed", String(globe.toggleLabels()));
  }));
  document.querySelectorAll("[data-scene-mode]").forEach(button => button.addEventListener("click", async () => {
    document.querySelectorAll("[data-scene-mode]").forEach(other => other.setAttribute("aria-pressed", String(other === button)));
    modelLayer?.untrack();
    await globe.setSceneMode(button.dataset.sceneMode);
    renderTrackingState(modelLayer?.tracking === true);
  }));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && store.activeTab === "orbit") modelLayer?.untrack({ aimAtEarth: true });
  });
  // A deployment from the node tab re-applies the current snapshot with the new node set.
  on("nodes:deployed", () => {
    if (!catalog.items) return;
    const token = ++requestToken;
    $("#satellite-list").setAttribute("aria-busy", "true");
    applyCatalog(catalog, token).catch(error => console.warn("deployed nodes could not be applied", error))
      .finally(() => { if (token === requestToken) $("#satellite-list").setAttribute("aria-busy", "false"); });
  });
}

export async function initOrbit() {
  loadFavorites(); clock = new OrbitClock();
  inspector = createInspector({ root: $("#orbit-inspector"), loadProfile: id => api.satelliteProfile(id) });
  inspector.clear();
  list = createCatalogList({ element: $("#satellite-list"), onSelect: (id, fly) => globe?.select(id, false, { userInitiated: true, focus: fly }) });
  globe = new GlobeController($("#cesium-container"), $("#globe-fallback"), {
    onSelect: selectSatellite, onHover: hoverSatellite,
    onPosition: (id, position) => position ? store.livePositions.set(id, position) : store.livePositions.delete(id),
    sunElement: $("#space-sun"),
    onProgress: (phase, fraction, detail) => loading.report(phase, fraction, detail),
    stations: GROUND_STATIONS,
    onStationSelect: showStation,
  });
  modelLayer = new SatelliteModelLayer({
    viewer: () => globe.viewer, timeSource: () => clock.now(), onTrackingChange: renderTrackingState,
    isTransitioning: () => globe.sceneTransitioning,
    onCameraInput: () => globe.cancelCameraMotion(),
    // Keep the marker, label and observer line on the model between the once-per-second ticks.
    onFrame: date => globe.syncSelected(date),
  });
  globe.wheelOverride = delta => modelLayer.zoomBy(delta);
  globe.onCameraInput = () => modelLayer.interruptCamera();
  globe.onCameraMove = () => modelLayer.untrack();
  loadSatelliteModels().then(manifest => {
    loading.report("models", 1);
    if (!manifest) return;
    resolveModel = createModelResolver(manifest);
    if (selectedId && itemById.has(selectedId)) showModel(itemById.get(selectedId), selectedId);
  });
  populateStationSelect(); bindControls(); renderClock(); renderObservation(null); renderShape(null);
  const result = await globe.init();
  const zoomControls = bindZoomControls({ slider: $("#orbit-zoom"), zoomIn: $("#orbit-zoom-in"), zoomOut: $("#orbit-zoom-out") }, globe, modelLayer);
  const removeZoomSync = globe.viewer?.scene.postRender.addEventListener(zoomControls.sync);
  window.addEventListener("pagehide", () => removeZoomSync?.(), { once: true });
  globe.setTheme(document.documentElement?.dataset?.theme);
  lighting = bindLightingToggle($("#orbit-lighting"), () => globe);
  lighting.apply();
  $("#globe-loading").classList.add("hidden");
  if (result.mode === "fallback") {
    $("#render-mode").textContent = "2D 좌표도 / 바탕지도 미제공";
    $("#imagery-layer").disabled = true;
    document.querySelectorAll('[data-scene-mode], [data-globe-mode="home"], [data-globe-mode="tracks"]').forEach(button => { button.disabled = true; });
  }
  await loadSatellites();
  tickTimer = setInterval(() => tick(), 1000);
  window.addEventListener("pagehide", () => { clearInterval(tickTimer); clearTimeout(passTimer); clearTimeout(searchTimer); });
}

// Server telemetry intentionally has no authority over the orbit analysis cursor.
export function updateOrbitTelemetry() {}
