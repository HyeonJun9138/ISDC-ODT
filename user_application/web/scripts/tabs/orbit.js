import { api } from "/static/communication/api.js?v=20260907-1";
import { drawSparkline, pushHistory } from "/static/visualization/charts.js";
import { GlobeController } from "/static/visualization/globe.js?v=20260907-1";
import { emit, setState, store } from "../state.js";

let globe;
let pathRefreshCounter = 0;
let searchTimer;
let lastPassKey = "";
let satelliteListFrame = 0;
let lastHoverSatelliteId = null;
let profileRequestToken = 0;
const satelliteProfileCache = new Map();
const SATELLITE_VIRTUAL_THRESHOLD = 400;
const SATELLITE_ROW_HEIGHT = 51;
const SATELLITE_ROW_BUFFER = 8;

const OWNER_LABELS = {
  US: "미국", CIS: "러시아/CIS", PRC: "중국", UK: "영국", JPN: "일본",
  ESA: "유럽우주국", EUME: "EUMETSAT", IND: "인도", FR: "프랑스", GER: "독일",
  IT: "이탈리아", CAN: "캐나다", KOR: "대한민국", NKOR: "북한", ISS: "국제우주정거장",
  NATO: "NATO", TBD: "확인 중",
};
const OPS_STATUS = {
  "+": ["운용 중", "success"], "-": ["비운용", "danger"], P: ["부분 운용", "warning"],
  B: ["백업/예비", "warning"], S: ["대기/예비", "neutral"], X: ["연장 임무", "success"],
  D: ["궤도 이탈/소멸", "danger"], "?": ["상태 미확인", "neutral"],
};
const OBJECT_TYPE_LABELS = { PAY: "탑재체", "R/B": "로켓 본체", DEB: "파편", UNK: "미확인 객체", TBA: "분류 대기" };
const CLASSIFICATION_LABELS = { U: "공개 (U)", C: "기밀 (C)", S: "비밀 (S)" };
const ORBIT_ACCENTS = { LEO: "#ff9f43", MEO: "#e6ed55", GEO: "#5ee277", HEO: "#53c8ff" };

const $ = (selector) => document.querySelector(selector);

function escapeMarkup(value) {
  return String(value ?? "—").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function setProfileText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value == null || value === "" ? "—" : String(value);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function orbitRegime(item = {}) {
  const orbit = String(item.ORBIT_REGIME || "").toUpperCase();
  return ORBIT_ACCENTS[orbit] ? orbit : "LEO";
}

function objectVisualKind(item = {}, catalog = {}) {
  const name = String(catalog.OBJECT_NAME || item.OBJECT_NAME || "");
  const type = String(catalog.OBJECT_TYPE || "").toUpperCase();
  if (/ISS|TIANGONG|SPACE STATION|CSS \(TIANHE\)/i.test(name)) return "station";
  if (type.includes("R/B") || /\bR\/B\b|ROCKET BODY/i.test(name)) return "rocket";
  if (type.includes("DEB") || /\bDEB\b|DEBRIS|FRAGMENT/i.test(name)) return "debris";
  return "payload";
}

function objectTypeLabel(catalog = {}, item = {}) {
  const raw = String(catalog.OBJECT_TYPE || "").toUpperCase();
  if (OBJECT_TYPE_LABELS[raw]) return `${OBJECT_TYPE_LABELS[raw]} (${raw})`;
  const kind = objectVisualKind(item, catalog);
  return kind === "station" ? "우주정거장" : kind === "rocket" ? "로켓 본체" : kind === "debris" ? "파편" : "탑재체";
}

function ownerLabel(code) {
  const raw = String(code || "").trim().toUpperCase();
  if (!raw) return "—";
  return OWNER_LABELS[raw] ? `${OWNER_LABELS[raw]} (${raw})` : raw;
}

function coordinateLabel(value, positive, negative) {
  const number = finiteNumber(value);
  if (number == null) return "—";
  return `${Math.abs(number).toFixed(2)}°${number >= 0 ? positive : negative}`;
}

function updateSatelliteInspectorLive(position, id = store.selectedSatellite) {
  const inspector = $("#satellite-inspector");
  if (!inspector || inspector.dataset.satelliteId !== String(id) || !position) return;
  setProfileText("#profile-altitude", `${Number(position.altitude).toLocaleString("ko-KR", { maximumFractionDigits: 1 })} km`);
  setProfileText("#profile-speed", finiteNumber(position.velocity) == null ? "—" : `${Number(position.velocity).toFixed(2)} km/s`);
  setProfileText("#profile-latitude", coordinateLabel(position.latitude, "N", "S"));
  setProfileText("#profile-longitude", coordinateLabel(position.longitude, "E", "W"));
}

function renderSatelliteInspectorBase(item, position, id) {
  const inspector = $("#satellite-inspector");
  const visual = $("#satellite-profile-visual");
  if (!inspector || !visual) return;
  const orbit = orbitRegime(item);
  const kind = objectVisualKind(item);
  inspector.dataset.satelliteId = String(id);
  inspector.dataset.orbit = orbit;
  inspector.style.setProperty("--profile-accent", ORBIT_ACCENTS[orbit]);
  inspector.classList.add("loading");
  visual.dataset.orbit = orbit;
  visual.dataset.kind = kind;
  setProfileText("#profile-name", item.OBJECT_NAME || `NORAD ${id}`);
  setProfileText("#profile-norad", `NORAD ${id}`);
  setProfileText("#profile-cospar", `COSPAR ${item.OBJECT_ID || "—"}`);
  setProfileText("#profile-status", "SATCAT 조회 중");
  const dot = $("#profile-status-dot");
  if (dot) dot.className = "warning";
  setProfileText("#profile-owner", "조회 중");
  setProfileText("#profile-ops-status", "조회 중");
  setProfileText("#profile-object-type", objectTypeLabel({}, item));
  setProfileText("#profile-object-id", item.OBJECT_ID || "—");
  setProfileText("#profile-launch-date", "—");
  setProfileText("#profile-launch-site", "—");
  setProfileText("#profile-rcs", "—");
  setProfileText("#profile-classification", CLASSIFICATION_LABELS[String(item.CLASSIFICATION_TYPE || "U").toUpperCase()] || item.CLASSIFICATION_TYPE || "—");
  setProfileText("#profile-orbit", orbit);
  setProfileText("#profile-period", finiteNumber(item.PERIOD_MINUTES) == null ? "—" : `${Number(item.PERIOD_MINUTES).toFixed(2)} min`);
  setProfileText("#profile-inclination", finiteNumber(item.INCLINATION) == null ? "—" : `${Number(item.INCLINATION).toFixed(3)}°`);
  setProfileText("#profile-eccentricity", finiteNumber(item.ECCENTRICITY) == null ? "—" : Number(item.ECCENTRICITY).toFixed(7));
  setProfileText("#profile-apogee", finiteNumber(item.APOGEE_KM) == null ? "—" : `${Number(item.APOGEE_KM).toLocaleString("ko-KR", { maximumFractionDigits: 0 })} km`);
  setProfileText("#profile-perigee", finiteNumber(item.PERIGEE_KM) == null ? "—" : `${Number(item.PERIGEE_KM).toLocaleString("ko-KR", { maximumFractionDigits: 0 })} km`);
  setProfileText("#profile-epoch-age", item.EPOCH_AGE_HOURS == null ? "Epoch —" : `Epoch ${Number(item.EPOCH_AGE_HOURS).toFixed(1)} h 전`);
  setProfileText("#profile-source", "GP · SGP4");
  setProfileText("#profile-visual-class", `${orbit} · ${objectTypeLabel({}, item).toUpperCase()}`);
  setProfileText("#profile-data-note", "궤도는 최신 GP 요소를 SGP4로 전파한 값입니다. 대표 형상은 객체 유형에 따른 시각화이며 실제 촬영 이미지나 정확한 기체 외형이 아닙니다.");
  const link = $("#profile-celestrak-link");
  if (link) link.href = `https://celestrak.org/satcat/records.php?CATNR=${encodeURIComponent(id)}&FORMAT=JSON-PRETTY`;
  updateSatelliteInspectorLive(position, id);
}

function applySatelliteProfile(item, id, payload) {
  const inspector = $("#satellite-inspector");
  if (!inspector || inspector.dataset.satelliteId !== String(id)) return;
  const catalog = payload?.catalog || {};
  const visual = $("#satellite-profile-visual");
  const kind = objectVisualKind(item, catalog);
  if (visual) visual.dataset.kind = kind;
  const statusCode = String(catalog.OPS_STATUS_CODE || "?").trim() || "?";
  const [statusLabel, statusClass] = OPS_STATUS[statusCode] || [`상태 코드 ${statusCode}`, "neutral"];
  const dot = $("#profile-status-dot");
  if (dot) dot.className = statusClass;
  setProfileText("#profile-status", payload.source === "gp-cache" ? "SATCAT 상세 제한" : statusLabel);
  setProfileText("#profile-name", catalog.OBJECT_NAME || item.OBJECT_NAME || `NORAD ${id}`);
  setProfileText("#profile-cospar", `COSPAR ${catalog.OBJECT_ID || item.OBJECT_ID || "—"}`);
  setProfileText("#profile-owner", ownerLabel(catalog.OWNER));
  setProfileText("#profile-ops-status", statusLabel);
  setProfileText("#profile-object-type", objectTypeLabel(catalog, item));
  setProfileText("#profile-object-id", catalog.OBJECT_ID || item.OBJECT_ID || "—");
  setProfileText("#profile-launch-date", catalog.LAUNCH_DATE || "—");
  setProfileText("#profile-launch-site", catalog.LAUNCH_SITE || "—");
  const rcs = finiteNumber(catalog.RCS);
  setProfileText("#profile-rcs", rcs == null ? "—" : `${rcs.toLocaleString("ko-KR", { maximumFractionDigits: 3 })} m²`);
  setProfileText("#profile-classification", CLASSIFICATION_LABELS[String(item.CLASSIFICATION_TYPE || "U").toUpperCase()] || item.CLASSIFICATION_TYPE || "—");
  setProfileText("#profile-source", payload.source === "celestrak-satcat" ? "CelesTrak SATCAT" : "현재 GP 정보");
  setProfileText("#profile-visual-class", `${orbitRegime(item)} · ${objectTypeLabel(catalog, item).toUpperCase()}`);
  if (payload.warning) setProfileText("#profile-data-note", payload.warning);
  inspector.classList.remove("loading");
}

async function loadSatelliteProfile(item, id) {
  const cached = satelliteProfileCache.get(String(id));
  if (cached) {
    applySatelliteProfile(item, id, cached);
    return;
  }
  const token = ++profileRequestToken;
  try {
    const payload = await api.satelliteProfile(id);
    satelliteProfileCache.set(String(id), payload);
    if (token === profileRequestToken) applySatelliteProfile(item, id, payload);
  } catch (error) {
    if (token !== profileRequestToken || $("#satellite-inspector")?.dataset.satelliteId !== String(id)) return;
    const inspector = $("#satellite-inspector");
    inspector?.classList.remove("loading");
    const dot = $("#profile-status-dot");
    if (dot) dot.className = "warning";
    setProfileText("#profile-status", "상세정보 제한");
    setProfileText("#profile-source", "현재 GP 정보");
    setProfileText("#profile-data-note", `SATCAT 메타데이터를 불러오지 못했습니다. 현재 궤도 정보는 계속 표시됩니다. (${error.message})`);
  }
}

function openSatelliteInspector(item, position, id) {
  const inspector = $("#satellite-inspector");
  if (!inspector) return;
  inspector.hidden = false;
  renderSatelliteInspectorBase(item, position, id);
  loadSatelliteProfile(item, id);
}

function hoverSatellite(payload) {
  const card = $("#satellite-hover-card");
  if (!card || !payload?.item || !payload.screen) {
    if (card) card.hidden = true;
    lastHoverSatelliteId = null;
    return;
  }
  const { item, position, id, screen } = payload;
  if (lastHoverSatelliteId !== id) {
    card.innerHTML = `<div class="hover-head"><span>HOVER</span><b>${escapeMarkup(item.OBJECT_NAME)}</b></div>
      <dl><div><dt>NORAD</dt><dd>${escapeMarkup(id)}</dd></div><div><dt>궤도</dt><dd>${escapeMarkup(item.ORBIT_REGIME)}</dd></div>
      <div><dt>고도</dt><dd>${position ? `${position.altitude.toFixed(0)} km` : "—"}</dd></div><div><dt>Epoch</dt><dd>${item.EPOCH_AGE_HOURS == null ? "—" : `${Number(item.EPOCH_AGE_HOURS).toFixed(1)} h`}</dd></div></dl>
      <small>클릭하면 활성 위성으로 설정됩니다.</small>`;
    lastHoverSatelliteId = id;
  }
  card.hidden = false;
  const globeCard = card.closest(".globe-card");
  const width = globeCard?.clientWidth || 700;
  const height = globeCard?.clientHeight || 420;
  const left = Math.max(8, Math.min(width - 217, screen.x + 14));
  const top = screen.y + 126 > height ? Math.max(8, screen.y - 126) : screen.y + 14;
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

function revealSelectedSatellite(id) {
  const list = $("#satellite-list");
  const index = store.satellites.findIndex((item) => String(item.NORAD_CAT_ID) === String(id));
  if (!list || index < 0) return;
  if (list.classList.contains("virtualized")) {
    list.scrollTop = Math.max(0, index * SATELLITE_ROW_HEIGHT - list.clientHeight / 2);
    paintSatelliteWindow();
    return;
  }
  const button = list.querySelector(`[data-satellite-id="${id}"]`);
  if (button) list.scrollTop = Math.max(0, button.offsetTop - list.clientHeight / 2);
}

function statusFor(item) {
  const age = Number(item.EPOCH_AGE_HOURS);
  if (!Number.isFinite(age)) return { label: "GP 미확인", cls: "warning" };
  if (age > 120) return { label: `GP ${Math.round(age)}h`, cls: "danger" };
  if (age > 48) return { label: `GP ${Math.round(age)}h`, cls: "warning" };
  return { label: `GP ${Math.round(age)}h`, cls: "success" };
}

function iconForSatellite(name) {
  if (/ISS|TIANGONG|SPACE STATION/i.test(name)) return "▦";
  if (/HST|HUBBLE/i.test(name)) return "◈";
  return "✣";
}

function renderScenarios() {
  const list = $("#scenario-list");
  list.innerHTML = store.scenarios.map((scenario) => `
    <button class="list-item ${scenario.id === store.runtime.scenario_id ? "active" : ""}" data-scenario-id="${scenario.id}">
      <span class="status-dot ${scenario.status === "ready" ? "ok" : "warning"}"></span>
      <span class="item-body"><b>${scenario.name}</b><small>${scenario.description}</small></span>
      <span class="badge ${scenario.status === "ready" ? "success" : "warning"}">${scenario.status.toUpperCase()}</span>
    </button>`).join("");
  list.querySelectorAll("[data-scenario-id]").forEach((button) => button.addEventListener("click", async () => {
    try {
      const runtime = await api.selectScenario(button.dataset.scenarioId);
      setState({ runtime }, "runtime"); renderScenarios(); emit("toast", { type: "success", title: "시나리오 로드", message: button.dataset.scenarioId });
    } catch (error) { emit("toast", { type: "error", title: "시나리오 오류", message: error.message }); }
  }));
}

function satelliteRow(item, index, top = null) {
  const id = String(item.NORAD_CAT_ID || index + 1);
  const status = statusFor(item);
  const style = top == null ? "" : ` style="top:${top}px"`;
  return `<button class="list-item ${store.selectedSatellite === id ? "active" : ""}" data-satellite-id="${id}"${style}>
    <span class="entity-icon">${iconForSatellite(item.OBJECT_NAME)}</span>
    <span class="item-body"><b>${item.OBJECT_NAME}</b><small>NORAD ${id}</small></span>
    <span class="badge ${status.cls}">${status.label}</span>
  </button>`;
}

function bindSatelliteRows(container) {
  container.querySelectorAll("[data-satellite-id]").forEach((button) => button.addEventListener("click", () => globe?.select(button.dataset.satelliteId, true, { userInitiated: true })));
}

function paintSatelliteWindow() {
  const list = $("#satellite-list");
  if (!list.classList.contains("virtualized")) return;
  const space = list.querySelector(".virtual-satellite-space");
  if (!space) return;
  const start = Math.max(0, Math.floor(list.scrollTop / SATELLITE_ROW_HEIGHT) - SATELLITE_ROW_BUFFER);
  const visibleRows = Math.ceil((list.clientHeight || 420) / SATELLITE_ROW_HEIGHT) + SATELLITE_ROW_BUFFER * 2;
  const end = Math.min(store.satellites.length, start + visibleRows);
  space.innerHTML = store.satellites.slice(start, end).map((item, localIndex) => satelliteRow(item, start + localIndex, (start + localIndex) * SATELLITE_ROW_HEIGHT)).join("");
  bindSatelliteRows(space);
}

function renderSatelliteList() {
  const list = $("#satellite-list");
  const items = store.satellites;
  if (items.length > SATELLITE_VIRTUAL_THRESHOLD) {
    const first = String(items[0]?.NORAD_CAT_ID || "");
    const last = String(items.at(-1)?.NORAD_CAT_ID || "");
    const catalogKey = `${items.length}:${first}:${last}`;
    if (!list.classList.contains("virtualized") || list.dataset.catalogKey !== catalogKey) {
      list.classList.add("virtualized");
      list.dataset.catalogKey = catalogKey;
      list.scrollTop = 0;
      list.innerHTML = `<div class="virtual-satellite-space" style="height:${items.length * SATELLITE_ROW_HEIGHT}px"></div>`;
    }
    paintSatelliteWindow();
  } else {
    list.classList.remove("virtualized");
    delete list.dataset.catalogKey;
    list.innerHTML = items.map((item, index) => satelliteRow(item, index)).join("") || `<div class="empty-state">검색 결과 없음</div>`;
    bindSatelliteRows(list);
  }
  $("#visible-satellite-count").textContent = `${items.length}/${store.satelliteCatalog.total || items.length} `;
}

function renderNodeStatus() {
  const list = $("#node-status-list");
  const labels = [
    ["위성 본체", "▱", 100], ["자세 제어", "⌘", 100], ["전력 계통", "ϟ", Math.round(store.telemetry.power || 86)],
    ["통신 장비", "⌁", Math.round(store.telemetry.link_quality || 96)], ["탑재체", "▣", 82], ["추진 시스템", "↗", 94], ["소프트웨어", "</>", 100],
  ];
  list.innerHTML = labels.map(([name, icon, value]) => `<article class="status-card"><span class="entity-icon">${icon}</span><span><b>${name}</b><small>${value >= 80 ? "정상" : value >= 60 ? "경고" : "이상"}</small></span><span class="percent" style="color:${value >= 80 ? "var(--green)" : value >= 60 ? "var(--orange)" : "var(--red)"}">${value}%</span></article>`).join("");
}

function selectedSatellite(item, position, id, context = {}) {
  const changed = store.selectedSatellite !== id;
  store.selectedSatellite = id;
  if (changed) { renderSatelliteList(); revealSelectedSatellite(id); }
  const inspector = $("#satellite-inspector");
  if (context.userInitiated || (changed && inspector && !inspector.hidden)) openSatelliteInspector(item, position, id);
  else updateSatelliteInspectorLive(position, id);
  const activeStatus = $("#globe-selection-status");
  if (activeStatus) {
    activeStatus.hidden = false;
    activeStatus.querySelector("b").textContent = item.OBJECT_NAME;
  }
  const meanMotion = Number(item.MEAN_MOTION || 15.2);
  const period = Number(item.PERIOD_MINUTES || 1440 / meanMotion);
  const inclination = Number(item.INCLINATION || item.inclination || 0);
  $("#selected-satellite-name").textContent = item.OBJECT_NAME;
  $("#selected-satellite-detail").innerHTML = `
    <div><dt>NORAD</dt><dd>${id}</dd></div>
    <div><dt>고도</dt><dd>${position ? position.altitude.toFixed(1) : "—"} km</dd></div>
    <div><dt>위도</dt><dd>${position ? position.latitude.toFixed(2) : "—"}°</dd></div>
    <div><dt>경도</dt><dd>${position ? position.longitude.toFixed(2) : "—"}°</dd></div>
    <div><dt>원지점</dt><dd>${Number(item.APOGEE_KM || 0).toFixed(0)} km</dd></div>
    <div><dt>근지점</dt><dd>${Number(item.PERIGEE_KM || 0).toFixed(0)} km</dd></div>
    <div><dt>Epoch Age</dt><dd>${item.EPOCH_AGE_HOURS == null ? "—" : `${Number(item.EPOCH_AGE_HOURS).toFixed(1)} h`}</dd></div>
    <div><dt>궤도</dt><dd>${item.ORBIT_REGIME || "—"}</dd></div>`;
  $("#orbit-altitude").textContent = position ? position.altitude.toFixed(0) : "—";
  $("#orbit-inclination").textContent = inclination ? inclination.toFixed(1) : "—";
  $("#orbit-period").textContent = period.toFixed(1);
  if (changed) renderPasses(true);
  emit("satellite:selected", { item, position, id });
}

export async function loadSatellites(force = false) {
  const group = $("#satellite-group").value;
  const orbit = $("#orbit-regime").value;
  const query = $("#satellite-search").value.trim();
  $("#satellite-refresh").classList.add("spinning");
  try {
    const payload = await api.satellites({ group, limit: 0, query, orbit });
    const catalog = { total: payload.total, filtered_total: payload.filtered_total, count: payload.count, fetched_at: payload.fetched_at, truncated: payload.truncated };
    setState({ satellites: payload.items, satelliteSource: payload.source, satelliteCatalog: catalog }, "satellites");
    await globe.setSatellites(payload.items);
    renderSatelliteList();
    renderCatalogSummary();
    const chip = $("#source-chip");
    const stale = payload.source === "celestrak-stale";
    const live = payload.source === "celestrak-live" || payload.source === "celestrak-cache";
    const unavailable = payload.source === "upstream-unavailable";
    chip.innerHTML = `<span class="status-dot ${live ? "ok" : "warning"}"></span><span>${live ? "GP Snapshot · SGP4" : stale ? "Stale GP Snapshot" : unavailable ? "GP Snapshot 제한" : "Demo Fallback"} · ${Number(payload.total || 0).toLocaleString()}</span>`;
    emit("toast", { type: live ? "success" : "warning", title: live ? "위성 카탈로그 준비" : stale ? "마지막 정상 스냅샷 사용" : unavailable ? "CelesTrak 갱신 제한" : "오프라인 대체 데이터", message: payload.warning || `전체 ${Number(payload.total || 0).toLocaleString()} · 표시 ${payload.count} · ${payload.source}` });
  } catch (error) {
    emit("toast", { type: "error", title: "위성 데이터 오류", message: error.message });
  } finally { $("#satellite-refresh").classList.remove("spinning"); }
}

function renderCatalogSummary() {
  const catalog = store.satelliteCatalog;
  const date = catalog.fetched_at ? new Date(catalog.fetched_at).toISOString().slice(5,16).replace("T"," ") : "—";
  $("#catalog-summary").innerHTML = `<span>카탈로그<b>${Number(catalog.total || 0).toLocaleString()}</b></span><span>조건/표시<b>${Number(catalog.filtered_total || 0).toLocaleString()} / ${catalog.count || 0}</b></span><span>갱신 UTC<b>${date}</b></span>`;
}

function renderPasses(force = false) {
  if (!globe || !store.selectedSatellite) return;
  const station = $("#ground-station").value;
  const bucket = Math.floor((store.runtime.elapsed_seconds || 0) / 300);
  const key = `${store.selectedSatellite}:${station}:${bucket}`;
  if (!force && key === lastPassKey) return;
  lastPassKey = key;
  const passes = globe.predictPasses(store.selectedSatellite, station, 24);
  $("#pass-list").innerHTML = passes.length ? passes.map((pass) => {
    const aos = pass.aos.toISOString().slice(11,16); const los = pass.los.toISOString().slice(11,16);
    return `<div class="pass-item"><b>${aos}–${los}</b><span>${Math.floor(pass.durationSeconds/60)}m ${pass.durationSeconds%60}s</span><span>EL ${pass.maxElevation.toFixed(0)}°</span></div>`;
  }).join("") : `<span>24시간 내 5° 이상 패스 없음</span>`;
}

function bindControls() {
  $("#satellite-search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadSatellites(false), 450); });
  $("#satellite-group").addEventListener("change", () => loadSatellites(false));
  $("#orbit-regime").addEventListener("change", () => loadSatellites(false));
  $("#satellite-refresh").addEventListener("click", () => loadSatellites(false));
  $("#satellite-list").addEventListener("scroll", () => {
    if (!$("#satellite-list").classList.contains("virtualized") || satelliteListFrame) return;
    satelliteListFrame = requestAnimationFrame(() => { satelliteListFrame = 0; paintSatelliteWindow(); });
  });
  $("#ground-station").addEventListener("change", () => renderPasses(true));
  $("#satellite-inspector-close").addEventListener("click", () => {
    profileRequestToken += 1;
    $("#satellite-inspector").hidden = true;
  });
  $("#profile-track").addEventListener("click", () => {
    if (store.selectedSatellite) globe?.select(store.selectedSatellite, true, { userInitiated: false });
  });
  $("#profile-home").addEventListener("click", () => globe?.home());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#satellite-inspector").hidden) {
      profileRequestToken += 1;
      $("#satellite-inspector").hidden = true;
    }
  });
  $("#imagery-layer").addEventListener("change", async (event) => {
    const applied = await globe.setImagery(event.target.value);
    event.target.value = applied;
    emit("toast", { type: "success", title: "지도 레이어 전환", message: applied === "satellite" ? "Esri World Imagery" : applied });
  });
  $("#scenario-reset").addEventListener("click", async () => {
    const runtime = await api.runtimeControl("reset"); setState({ runtime }, "runtime"); renderScenarios();
  });
  $("#runtime-toggle").addEventListener("click", async () => {
    const action = store.runtime.running ? "pause" : "start";
    const runtime = await api.runtimeControl(action); setState({ runtime }, "runtime"); updateRuntimeControls();
  });
  $("#runtime-reset").addEventListener("click", async () => {
    const runtime = await api.runtimeControl("reset"); setState({ runtime }, "runtime"); updateRuntimeControls();
  });
  $("#runtime-speed").addEventListener("change", async (event) => {
    const runtime = await api.runtimeSpeed(event.target.value); setState({ runtime }, "runtime"); emit("toast", { type: "success", title: "시뮬레이션 배속", message: `${runtime.speed}x` });
  });
  $("#fault-button").addEventListener("click", () => $("#fault-dialog").showModal());
  document.querySelectorAll("[data-globe-mode]").forEach((button) => button.addEventListener("click", () => {
    const mode = button.dataset.globeMode;
    if (mode === "home") globe.home();
    if (mode === "selected" && store.selectedSatellite) globe.select(store.selectedSatellite, true, { userInitiated: true });
    if (mode === "tracks") button.classList.toggle("active", globe.toggleTracks());
    if (mode === "labels") button.classList.toggle("active", globe.toggleLabels());
    if (mode === "contrast") {
      const enabled = globe.toggleEmphasis();
      button.classList.toggle("active", enabled);
      emit("toast", { type: "success", title: "위성 강조 필터", message: enabled ? "지구 감광 필터 ON" : "원본 지도 밝기" });
    }
  }));
  document.querySelectorAll("[data-scene-mode]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll("[data-scene-mode]").forEach((item) => item.classList.toggle("active", item === button));
    globe.setSceneMode(button.dataset.sceneMode);
  }));
}

function updateRuntimeControls() {
  $("#runtime-toggle").textContent = store.runtime.running ? "Ⅱ" : "▶";
  $("#runtime-speed").value = String(store.runtime.speed || 1);
  const seconds = store.runtime.elapsed_seconds || 0;
  const h = Math.floor(seconds / 3600); const m = Math.floor(seconds % 3600 / 60); const s = Math.floor(seconds % 60); const ms = Math.floor(seconds % 1 * 1000);
  $("#simulation-time").textContent = `T+${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${String(ms).padStart(3,"0")}`;
  $("#time-slider").value = String((seconds / 25) % 100);
}

export async function initOrbit() {
  renderScenarios(); renderNodeStatus(); bindControls(); updateRuntimeControls();
  globe = new GlobeController($("#cesium-container"), $("#globe-fallback"), {
    onSelect: selectedSatellite,
    onPosition: (id, position) => store.livePositions.set(id, position),
    onHover: hoverSatellite,
    sunElement: $("#space-sun"),
  });
  const result = await globe.init();
  $("#globe-loading").classList.add("hidden");
  if (result.mode === "fallback") emit("toast", { type: "warning", title: "2D 지구 대체 모드", message: "CesiumJS 연결을 확인하세요." });
  await loadSatellites(false);
}

export function updateOrbitTelemetry(payload) {
  store.runtime = payload.runtime || store.runtime;
  store.telemetry = payload.telemetry || store.telemetry;
  updateRuntimeControls(); renderNodeStatus();
  const t = store.telemetry;
  $("#power-value").textContent = `${Math.round(t.power || 0)}%`;
  $("#temperature-value").textContent = `${Number(t.temperature || 0).toFixed(1)}°C`;
  $("#storage-value").textContent = `${Math.round(t.storage || 0)}%`;
  $("#downlink-value").textContent = `${Number(t.throughput_mbps || 0).toFixed(1)} Mbps`;
  $("#uplink-value").textContent = `${Math.max(0, Number(t.throughput_mbps || 0) * .31).toFixed(1)} Mbps`;
  drawSparkline($("#uplink-spark"), pushHistory("uplink", (t.throughput_mbps || 0) * .31), "#2d7ff9");
  drawSparkline($("#downlink-spark"), pushHistory("downlink", t.throughput_mbps || 0), "#2d7ff9");
  drawSparkline($("#telemetry-spark"), pushHistory("power", t.power || 0), "#12a36d");
  const visibility = Math.max(10, Math.min(100, Math.round(t.link_quality || 78)));
  $("#visibility-ring").style.setProperty("--value", visibility); $("#visibility-ring strong").textContent = `${visibility}%`;
  const scenarioDate = new Date(new Date(store.runtime.started_at || Date.now()).getTime() + (store.runtime.elapsed_seconds || 0) * 1000);
  if (store.activeTab === "orbit") {
    globe?.update(scenarioDate);
    if (++pathRefreshCounter % 120 === 0) globe?.update(scenarioDate, true);
  }
  if (store.selectedSatellite) {
    const entry = store.satellites.find((item) => String(item.NORAD_CAT_ID) === store.selectedSatellite);
    const position = store.livePositions.get(store.selectedSatellite);
    if (entry && position) selectedSatellite(entry, position, store.selectedSatellite);
  }
}
