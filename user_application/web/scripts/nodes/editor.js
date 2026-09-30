// Node editor form: name, bus, 3D model, operating mode, orbit, power and equipment. The form
// edits a copy of the node; the owner validates and stores it on save. Markup builders are pure
// so the field layout can be tested without a browser.
import { BUS_PRESETS, EQUIPMENT_CATALOG, EQUIPMENT_KINDS, NODE_MODES, OISL_ROLES, createEquipment, equipmentSpec } from "/static/model_library/satellite_nodes.js";
import { catalogElements } from "/static/simulation/satellite_dynamics.js";
import { escapeMarkup as esc, displayNumber } from "../orbit/catalog.js";

const ORBIT_FIELDS = [
  ["altitude_km", "평균 고도", "km", 0.1, 150, 60000], ["eccentricity", "이심률", "", 0.0001, 0, 0.95], ["inclination", "경사각", "°", 0.01, 0, 180],
  ["raan", "승교점 적경", "°", 0.01, 0, 360], ["argp", "근지점 편각", "°", 0.01, 0, 360], ["mean_anomaly", "평균 근점 이각", "°", 0.01, 0, 360],
];
const POWER_FIELDS = [["generation_w", "발전 전력", "W"], ["bus_w", "버스 소비", "W"], ["battery_wh", "배터리 용량", "Wh"]];

function localDateTime(epoch) {
  const time = typeof epoch === "number" ? epoch : Date.parse(epoch);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 19) : "";
}

export function modelOptionsMarkup(models, selectedKey) {
  const groups = new Map();
  for (const model of models || []) {
    const group = model.provider === "spacetwin" ? "SpaceTwin 자체 제작 대표 형상" : model.provider === "noaa_goesr" ? "NOAA/NASA GOES-R" : "NASA 3D Resources (실제 기체)";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(model);
  }
  return [...groups].map(([group, list]) => `<optgroup label="${esc(group)}">${list.map(model =>
    `<option value="${esc(model.key)}" ${model.key === selectedKey ? "selected" : ""}>${esc(model.label || model.title)} · ${esc(displayNumber(model.size_m, 1))} m</option>`).join("")}</optgroup>`).join("");
}

export function orbitSummaryText(orbit) {
  const summary = catalogElements(orbit);
  if (!summary) return "궤도 정의가 허용 범위를 벗어났습니다.";
  return `${summary.ORBIT_REGIME} · 주기 ${displayNumber(summary.PERIOD_MINUTES, 2)} min · 근지점 ${displayNumber(summary.PERIGEE_KM, 0)} km · 원지점 ${displayNumber(summary.APOGEE_KM, 0)} km · 승교점 이동 ${displayNumber(summary.RAAN_DRIFT_DEG_PER_DAY, 3)}°/일`;
}

export function equipmentRowsMarkup(draft, otherNodes) {
  const rows = (draft.equipment || []).map(item => {
    const spec = equipmentSpec(item);
    if (!spec) return "";
    const oisl = spec.kind === "oisl";
    const targets = [`<option value="auto" ${item.target === "auto" || !item.target ? "selected" : ""}>자동 선택</option>`,
      ...otherNodes.map(node => `<option value="${esc(node.id)}" ${item.target === node.id ? "selected" : ""}>${esc(node.name)}</option>`)].join("");
    return `<div class="ns-eq-row ${item.enabled === false ? "off" : ""}" data-eq="${esc(item.id)}">
      <label class="ns-eq-toggle" title="사용 여부"><input type="checkbox" data-eq-enabled ${item.enabled !== false ? "checked" : ""}></label>
      <span class="ns-eq-name"><b>${esc(spec.label)}</b><small>${esc(EQUIPMENT_KINDS[spec.kind] || spec.kind)} · ${esc(spec.power_w)} W · ${esc(spec.mass_kg)} kg${oisl ? ` · ${esc(spec.data_rate_mbps / 1000)} Gbps · ${esc(spec.max_range_km)} km · 짐벌 ${esc(spec.slew_rate_deg_s)}°/s` : ""}</small></span>
      ${oisl ? `<select data-eq-role aria-label="장착 방향">${Object.entries(OISL_ROLES).map(([key, label]) => `<option value="${key}" ${item.role === key ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>
      <select data-eq-target aria-label="상대 위성">${targets}</select>` : "<span></span><span></span>"}
      <button type="button" data-eq-remove aria-label="장비 제거" title="장비 제거">×</button>
    </div>`;
  }).join("");
  return rows || `<div class="ns-empty">장비가 없습니다. 아래에서 추가하세요.</div>`;
}

export function editorMarkup(draft, { models = [], otherNodes = [] } = {}) {
  const busOptions = Object.entries(BUS_PRESETS).map(([key, bus]) => `<option value="${key}" ${draft.bus === key ? "selected" : ""}>${esc(bus.label)}</option>`).join("");
  const modeOptions = Object.entries(NODE_MODES).map(([key, mode]) => `<option value="${key}" ${draft.mode === key ? "selected" : ""}>${esc(mode.label)}</option>`).join("");
  const orbitInputs = ORBIT_FIELDS.map(([key, label, unit, step, min, max]) =>
    `<label><span>${esc(label)}${unit ? ` <small>${esc(unit)}</small>` : ""}</span><input type="number" data-path="orbit.${key}" value="${esc(draft.orbit?.[key] ?? "")}" step="${step}" min="${min}" max="${max}" required></label>`).join("");
  const powerInputs = POWER_FIELDS.map(([key, label, unit]) =>
    `<label><span>${esc(label)} <small>${esc(unit)}</small></span><input type="number" data-path="power.${key}" value="${esc(draft.power?.[key] ?? "")}" step="1" min="0" required></label>`).join("");
  const equipmentOptions = Object.entries(EQUIPMENT_CATALOG).map(([key, spec]) => `<option value="${key}">${esc(spec.label)} (${esc(spec.power_w)} W)</option>`).join("");
  return `
    <header class="ns-editor-head"><span class="ns-kicker">위성 편집 · ${esc(draft.id)}</span>${draft.formation ? `<span class="ns-tag warning" title="저장하면 편대 슬라이더의 영향을 받지 않는 개별 위성이 됩니다">편대 ${esc(draft.formation.id)} 소속 · 저장 시 분리</span>` : ""}</header>
    <section class="ns-editor-section">
      <h3>1. 기본 정보</h3>
      <label><span>위성 이름</span><input type="text" data-path="name" value="${esc(draft.name)}" maxlength="40" required autocomplete="off"></label>
      <div class="ns-grid-2">
        <label><span>버스 프리셋</span><select data-path="bus">${busOptions}</select></label>
        <label><span>운용 모드</span><select data-path="mode">${modeOptions}</select></label>
      </div>
      <p class="ns-note" id="node-mode-note">${esc(NODE_MODES[draft.mode]?.note || "")}</p>
    </section>
    <section class="ns-editor-section">
      <h3>2. 3D 모델</h3>
      <label><span>표시 모델</span><select data-path="model_key" id="node-model-select">${modelOptionsMarkup(models, draft.model_key)}</select></label>
      <figure class="ns-model-preview"><img id="node-model-preview" alt="" hidden decoding="async"><figcaption id="node-model-caption">모델을 선택하면 미리보기를 표시합니다.</figcaption></figure>
    </section>
    <section class="ns-editor-section">
      <h3>3. 임무 장비 <small>OISL 단말은 장착 방향과 상대 위성을 지정합니다</small></h3>
      <div class="ns-eq-list" id="node-equipment-list">${equipmentRowsMarkup(draft, otherNodes)}</div>
      <div class="ns-eq-add"><select id="node-equipment-catalog" aria-label="추가할 장비">${equipmentOptions}</select><button type="button" id="node-equipment-add">＋ 장비 추가</button></div>
    </section>
    <section class="ns-editor-section">
      <h3>4. 궤도 <small>Kepler + J2 섭동, 정의 시각 기준</small></h3>
      <div class="ns-grid-3">${orbitInputs}</div>
      <div class="ns-grid-epoch"><label><span>정의 시각 <small>UTC</small></span><input type="datetime-local" data-path="orbit.epoch" step="1" value="${esc(localDateTime(draft.orbit?.epoch))}" required></label><button type="button" id="node-epoch-now">지금</button></div>
      <p class="ns-note" id="node-orbit-summary">${esc(orbitSummaryText(draft.orbit))}</p>
    </section>
    <section class="ns-editor-section">
      <h3>5. 전력과 질량</h3>
      <div class="ns-grid-3">${powerInputs}<label><span>건조 질량 <small>kg</small></span><input type="number" data-path="mass_kg" value="${esc(draft.mass_kg ?? "")}" step="0.1" min="0"></label></div>
      <label><span>메모</span><textarea data-path="notes" rows="2" maxlength="300">${esc(draft.notes || "")}</textarea></label>
    </section>
    <ul class="ns-errors" id="node-editor-errors" hidden></ul>
    <footer class="ns-editor-actions"><button type="button" id="node-editor-cancel">취소</button><button type="submit" class="ns-primary" id="node-editor-save">저장</button></footer>`;
}

function setPath(target, path, value) {
  const keys = path.split(".");
  let cursor = target;
  for (const key of keys.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== "object") cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys.at(-1)] = value;
}

function parseField(input) {
  if (input.type === "number") return input.value.trim() === "" ? NaN : Number(input.value);
  if (input.type === "datetime-local") { const time = Date.parse(`${input.value}Z`); return Number.isFinite(time) ? time : NaN; }
  return input.value;
}

// The controller renders into `form`, keeps the working copy and hands it back on save.
export function createNodeEditor({ form, models = () => [], otherNodes = () => [], onSave, onCancel, onModelChange }) {
  let draft = null;

  const isOpen = () => draft !== null && !form.hidden;

  function renderEquipment() {
    const list = form.querySelector("#node-equipment-list");
    if (list) list.innerHTML = equipmentRowsMarkup(draft, otherNodes().filter(node => node.id !== draft.id));
  }

  function renderPreview() {
    const description = onModelChange?.(draft.model_key) || null;
    const image = form.querySelector("#node-model-preview");
    const caption = form.querySelector("#node-model-caption");
    if (!image || !caption) return;
    if (description?.thumbnail) { image.src = description.thumbnail; image.alt = description.alt || ""; image.hidden = false; }
    else { image.removeAttribute("src"); image.hidden = true; }
    caption.textContent = description?.note || "모델을 선택하면 미리보기를 표시합니다.";
  }

  function showErrors(errors) {
    const list = form.querySelector("#node-editor-errors");
    if (!list) return;
    list.innerHTML = (errors || []).map(error => `<li>${esc(error)}</li>`).join("");
    list.hidden = !(errors || []).length;
  }

  function applyBus(busKey) {
    const bus = BUS_PRESETS[busKey];
    if (!bus) return;
    draft.bus = busKey;
    draft.model_key = bus.model_key;
    draft.power = { generation_w: bus.generation_w, bus_w: bus.bus_w, battery_wh: bus.battery_wh };
    draft.mass_kg = bus.mass_kg;
    draft.equipment = bus.equipment.map(([catalog, role]) => createEquipment(catalog, { role }));
    render();
  }

  function bind() {
    form.querySelectorAll("[data-path]").forEach(input => {
      const handler = () => {
        const path = input.dataset.path;
        if (path === "bus") { applyBus(input.value); return; }
        setPath(draft, path, parseField(input));
        if (path === "model_key") renderPreview();
        if (path === "mode") { const note = form.querySelector("#node-mode-note"); if (note) note.textContent = NODE_MODES[draft.mode]?.note || ""; }
        if (path.startsWith("orbit.")) { const summary = form.querySelector("#node-orbit-summary"); if (summary) summary.textContent = orbitSummaryText(draft.orbit); }
      };
      input.addEventListener(input.tagName === "SELECT" ? "change" : "input", handler);
    });
    form.querySelector("#node-epoch-now")?.addEventListener("click", () => {
      draft.orbit.epoch = Date.now();
      const input = form.querySelector('[data-path="orbit.epoch"]');
      if (input) input.value = localDateTime(draft.orbit.epoch);
      const summary = form.querySelector("#node-orbit-summary"); if (summary) summary.textContent = orbitSummaryText(draft.orbit);
    });
    form.querySelector("#node-equipment-add")?.addEventListener("click", () => {
      const key = form.querySelector("#node-equipment-catalog")?.value;
      if (!EQUIPMENT_CATALOG[key]) return;
      draft.equipment = [...(draft.equipment || []), createEquipment(key)];
      renderEquipment();
    });
    form.querySelector("#node-equipment-list")?.addEventListener("click", event => {
      const button = event.target.closest("[data-eq-remove]");
      if (!button) return;
      const id = button.closest("[data-eq]")?.dataset.eq;
      draft.equipment = (draft.equipment || []).filter(item => item.id !== id);
      renderEquipment();
    });
    form.querySelector("#node-equipment-list")?.addEventListener("change", event => {
      const row = event.target.closest("[data-eq]");
      const item = (draft.equipment || []).find(entry => entry.id === row?.dataset.eq);
      if (!item) return;
      if (event.target.matches("[data-eq-role]")) item.role = event.target.value;
      if (event.target.matches("[data-eq-target]")) item.target = event.target.value;
      if (event.target.matches("[data-eq-enabled]")) { item.enabled = event.target.checked; row.classList.toggle("off", !item.enabled); }
    });
    form.querySelector("#node-editor-cancel")?.addEventListener("click", () => { close(); onCancel?.(); });
  }

  function render() {
    form.innerHTML = editorMarkup(draft, { models: models(), otherNodes: otherNodes().filter(node => node.id !== draft.id) });
    bind();
    renderPreview();
  }

  function open(node) {
    draft = structuredClone(node);
    form.hidden = false;
    render();
    form.querySelector('[data-path="name"]')?.focus();
  }

  function close() {
    draft = null;
    form.hidden = true;
    form.innerHTML = "";
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!draft) return;
    const errors = onSave?.(structuredClone(draft)) || [];
    if (errors.length) showErrors(errors); else close();
  });

  return { open, close, isOpen, get draft() { return draft; }, showErrors };
}
