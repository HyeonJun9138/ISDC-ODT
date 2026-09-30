// 설정 탭. 내·외부 모듈의 연결 토폴로지, 링크별 연결 설정(전송 방식 · 엔드포인트 · 하트비트), ICD 관리표를 둔다.
// 모듈·링크 카탈로그와 상태 계산은 ../settings/topology.js(순수 모듈)에 있고, 여기서는 그리기와 입력만 다룬다.
// 링크 상태는 서버의 /api/integration/probe가 실제로 확인한 결과를 따른다: 내장 모듈은 프로세스 안에서 살아 있는지,
// 원격 엔드포인트는 실제 TCP 접속으로 검사한다. 운용 콘솔 링크(L09)는 이 브라우저의 WebSocket 상태를 반영한다.
// SVG는 한 번만 만들고 상태 변화는 클래스와 알약 텍스트만 바꾸므로 흐름 애니메이션이 끊기지 않는다.
import { emit, on, store } from "../state.js";
import { escapeMarkup } from "./fault_dialog.js";
import {
  GROUPS, ICDS, ICD_STATUSES, LINKS, LINK_KINDS, LINK_STATES, MESSAGE_STATUSES, MODES, MODULES, PLACEMENTS, TRANSPORTS, VIEWBOX, ZONES,
  endpointOf, evaluateLinks, icdById, layoutEdges, linkById, loadSettings, modeById, moduleById, moduleStatus,
  normalizeLinkSettings, probeReason, probeTargets, resolveLink, saveSettings, summarize, transportLabel, securityDeployment,
} from "../settings/topology.js?v=20260908-scenario1";

const $ = selector => document.querySelector(selector);
const EDGES = layoutEdges(LINKS, MODULES);
const PROBE_INTERVAL_MS = 5000;
const STATE_CLASSES = Object.keys(LINK_STATES);

let api = null;
let settings = { mode: MODES[0].id, links: {} };
let health = { socket: null, rtt: null, probes: undefined, checkedAt: null, probeError: null };
let selection = null;
let lastSignature = "";
let lastSelectionKey = "";
let testToken = 0;
let probeInFlight = false;
const previousStates = new Map();

const storage = () => { try { return window.localStorage; } catch (_) { return null; } };
const toast = (type, title, message) => emit("toast", { type, title, message });
const selfHost = () => window.location?.host || "";
const context = () => ({ mode: settings.mode, overrides: settings.links, health });
const moduleName = id => moduleById(id)?.name || id;
const spanLabel = link => `${moduleName(link.from)} ↔ ${moduleName(link.to)}`;
const stateBadge = state => `<span class="badge ${LINK_STATES[state].badge}">${LINK_STATES[state].label}</span>`;

// ---- SVG -----------------------------------------------------------------------------------------

function textWidth(text, size) {
  let width = 0;
  for (const character of String(text)) {
    if (/[ᄀ-ᇿ㄰-㆏가-힯]/.test(character)) width += size * 0.95;
    else if (/[·.\s|:]/.test(character)) width += size * 0.35;
    else width += size * 0.58;
  }
  return width;
}

function pillFor(item) {
  if (item.link.icd) return item.link.icd;
  if (item.state === "down") return "!";
  if (item.state === "disabled") return "OFF";
  if (item.state === "unknown") return "?";
  return "";
}

function packetDuration(edge) {
  const length = Math.hypot(edge.to.x - edge.from.x, edge.to.y - edge.from.y) * 1.15;
  return Math.min(4.5, Math.max(1.4, length / 110)).toFixed(2);
}

function buildTopology() {
  const host = $("#settings-topology");
  if (!host) return;
  const zones = ZONES.map(zone => `<g class="topo-zone ${zone.group}"><rect x="${zone.x}" y="${zone.y}" width="${zone.w}" height="${zone.h}" rx="12"/><text x="${zone.x + 14}" y="${zone.y + 21}">${escapeMarkup(zone.label)}</text></g>`).join("");
  const edges = EDGES.map(edge => {
    const duration = packetDuration(edge);
    const railId = `topo-path-${edge.id}`;
    return `<g class="topo-edge standby" data-link="${edge.id}" data-duration="${duration}" tabindex="0" role="button">`
      + `<title></title>`
      + `<path class="hit" d="${edge.d}"/><path class="line" d="${edge.d}"/><path class="draw" pathLength="1" d="${edge.d}"/><path class="flow" d="${edge.d}"/>`
      + `<path id="${railId}" class="rail" d="${edge.d}"/>`
      + `<circle class="packet" r="3.2"/><circle class="packet reverse" r="2.4"/>`
      + `<g class="pill" transform="translate(${edge.mid.x},${edge.mid.y})"><rect y="-9" height="18" rx="9"/><text text-anchor="middle" y="3.5"></text></g>`
      + `</g>`;
  }).join("");
  const nodes = MODULES.map(module => {
    const placement = PLACEMENTS[module.placement]?.label || "";
    const title = `${module.name} · ${module.role} · ${GROUPS[module.group].label} · ${PLACEMENTS[module.placement]?.description || ""}`;
    return `<g class="topo-node ${module.group} idle" data-module="${module.id}" tabindex="0" role="button" aria-label="${escapeMarkup(title)}" transform="translate(${module.x},${module.y})">`
      + `<title>${escapeMarkup(title)}</title>`
      + `<rect class="body" width="${module.w}" height="${module.h}" rx="9"/><rect class="tint" x="0" y="9" width="3" height="${module.h - 18}" rx="1.5"/>`
      + `<circle class="dot" cx="17" cy="19" r="4"/>`
      + `<text class="name" x="27" y="24">${escapeMarkup(module.name)}</text>`
      + `<foreignObject x="14" y="34" width="${module.w - 28}" height="32"><div xmlns="http://www.w3.org/1999/xhtml" class="role">${escapeMarkup(module.role)}</div></foreignObject>`
      + `<text class="placement" x="${module.w - 12}" y="${module.h - 9}" text-anchor="end">${escapeMarkup(placement)}</text>`
      + `</g>`;
  }).join("");
  host.innerHTML = `<svg width="${VIEWBOX.width}" height="${VIEWBOX.height}" viewBox="0 0 ${VIEWBOX.width} ${VIEWBOX.height}" preserveAspectRatio="xMidYMin meet" role="group" aria-label="모듈 연결 토폴로지">${zones}${edges}${nodes}</svg>`;
  previousStates.clear();
  packetRails = [...host.querySelectorAll(".topo-edge")].map((group, index) => {
    const rail = group.querySelector(".rail");
    return { group, rail, length: rail.getTotalLength(), duration: Number(group.dataset.duration) || 2, phase: (index * 0.37) % 1,
      forward: group.querySelector(".packet:not(.reverse)"), reverse: group.querySelector(".packet.reverse") };
  });
}

// Packets run along every connected link, one each way, driven by requestAnimationFrame so the motion
// does not depend on SMIL support and stops by itself while the tab is hidden.
let packetRails = [];
let packetFrame = 0;

function animatePackets(now) {
  packetFrame = requestAnimationFrame(animatePackets);
  if (store.activeTab !== "settings" || document.hidden) return;
  const seconds = now / 1000;
  for (const item of packetRails) {
    if (!item.group.classList.contains("active") || !item.length) continue;
    const t = (seconds / item.duration + item.phase) % 1;
    const ahead = item.rail.getPointAtLength(item.length * t);
    const behind = item.rail.getPointAtLength(item.length * (1 - ((t + 0.5) % 1)));
    item.forward.setAttribute("cx", ahead.x.toFixed(1));
    item.forward.setAttribute("cy", ahead.y.toFixed(1));
    item.reverse.setAttribute("cx", behind.x.toFixed(1));
    item.reverse.setAttribute("cy", behind.y.toFixed(1));
  }
}

function replayConnect(group, delayMs = 0) {
  group.classList.remove("connecting");
  void group.getBoundingClientRect();
  group.style.setProperty("--draw-delay", `${delayMs}ms`);
  group.classList.add("connecting");
  setTimeout(() => group.classList.remove("connecting"), 1100 + delayMs);
}

function syncTopology(evaluations) {
  const host = $("#settings-topology");
  if (!host) return;
  if (!host.querySelector("svg")) buildTopology();
  const firstPass = previousStates.size === 0;
  let connected = 0;
  for (const item of evaluations) {
    const group = host.querySelector(`[data-link="${item.link.id}"]`);
    if (!group) continue;
    const previous = previousStates.get(item.link.id);
    STATE_CLASSES.forEach(state => group.classList.toggle(state, item.state === state));
    if (item.state === "active" && previous !== "active") replayConnect(group, firstPass ? connected++ * 70 : 0);
    previousStates.set(item.link.id, item.state);
    const label = pillFor(item);
    const pill = group.querySelector(".pill");
    pill.style.display = label ? "" : "none";
    if (label) {
      const width = Math.round(textWidth(label, 9.5) + 16);
      const rect = pill.querySelector("rect");
      rect.setAttribute("x", String(-width / 2));
      rect.setAttribute("width", String(width));
      pill.querySelector("text").textContent = label;
    }
    const title = `${item.link.id} · ${spanLabel(item.link)} · ${LINK_STATES[item.state].label} · ${item.reason}`;
    group.querySelector("title").textContent = title;
    group.setAttribute("aria-label", title);
  }
  for (const module of MODULES) {
    const node = host.querySelector(`[data-module="${module.id}"]`);
    if (!node) continue;
    const deployment = module.id === "security-ops" ? securityDeployment(health.security, health.securityError) : null;
    const status = deployment?.state || moduleStatus(module.id, evaluations);
    if (deployment) node.querySelector(".placement").textContent = `${deployment.placement} / ${{ ok: "응답 확인", warn: "응답 오류", idle: "미확인" }[deployment.state]}`;
    ["ok", "warn", "idle"].forEach(name => node.classList.toggle(name, status === name));
  }
}

function applySelection() {
  const host = $("#settings-topology");
  host?.querySelectorAll(".topo-node").forEach(node => node.classList.toggle("selected", selection?.type === "module" && node.dataset.module === selection.id));
  host?.querySelectorAll(".topo-edge").forEach(edge => {
    const link = linkById(edge.dataset.link);
    const own = selection?.type === "link" && edge.dataset.link === selection.id;
    const touches = selection?.type === "module" && (link?.from === selection.id || link?.to === selection.id);
    edge.classList.toggle("selected", own);
    edge.classList.toggle("related", Boolean(touches));
  });
  $("#settings-link-rows")?.querySelectorAll("tr").forEach(row => row.classList.toggle("active", selection?.type === "link" && row.dataset.linkRow === selection.id));
}

// ---- panels --------------------------------------------------------------------------------------

function renderModeBar() {
  const bar = $("#settings-mode-bar");
  if (bar) bar.innerHTML = MODES.map(mode => `<button type="button" data-settings-mode="${mode.id}" class="${mode.id === settings.mode ? "active" : ""}" title="${escapeMarkup(mode.description)}">${escapeMarkup(mode.label)}</button>`).join("");
  const note = $("#settings-mode-note");
  if (note) note.textContent = modeById(settings.mode).description;
}

function renderSummary(evaluations) {
  const summary = summarize(evaluations);
  const chips = ["active", "down", "unknown", "standby", "disabled"]
    .map(state => `<span class="summary-chip ${state}${summary[state] ? "" : " zero"}"><i></i>${escapeMarkup(LINK_STATES[state].label)} <b>${summary[state]}</b></span>`).join("");
  const element = $("#settings-summary");
  if (element) element.innerHTML = `<span class="summary-chip total">링크 <b>${summary.total}</b></span>${chips}`;
  const count = $("#settings-links-count");
  if (count) count.textContent = `${summary.active} / ${summary.total} 연결`;
}

function renderRtt() {
  const element = $("#settings-rtt");
  if (!element) return;
  if (health.probeError) {
    element.textContent = `확인 실패 · ${health.probeError}`;
    element.classList.add("warn");
    return;
  }
  const checked = health.checkedAt ? ` · 확인 ${String(health.checkedAt).slice(11, 19)} UTC` : "";
  element.textContent = `${health.rtt == null ? "콘솔 왕복 —" : `콘솔 왕복 ${health.rtt} ms`}${checked}`;
  element.classList.toggle("warn", health.rtt == null);
}

function renderLinkTable(evaluations) {
  const body = $("#settings-link-rows");
  if (!body) return;
  body.innerHTML = evaluations.map(item => {
    const endpoint = `${transportLabel(item.settings.transport)} · ${endpointOf(item.settings, selfHost())}`;
    const icd = item.link.icd ? `<button type="button" class="link-button" data-open-icd="${item.link.icd}">${item.link.icd}</button>` : "—";
    return `<tr data-link-row="${item.link.id}"><td><b>${item.link.id}</b></td><td>${escapeMarkup(spanLabel(item.link))}</td><td>${escapeMarkup(endpoint)}</td><td>${icd}</td><td>${stateBadge(item.state)}</td><td class="muted" title="${escapeMarkup(item.reason)}">${escapeMarkup(item.reason)}</td></tr>`;
  }).join("");
}

function renderIcdTable(evaluations) {
  const body = $("#settings-icd-rows");
  if (!body) return;
  const byLink = new Map(evaluations.map(item => [item.link.id, item]));
  body.innerHTML = ICDS.map(icd => {
    const status = ICD_STATUSES[icd.status] || ICD_STATUSES.draft;
    const link = byLink.get(icd.link);
    return `<tr data-open-icd="${icd.id}" title="${escapeMarkup(icd.summary)}"><td><b>${icd.id}</b></td><td>${escapeMarkup(icd.title)}</td><td>${escapeMarkup(icd.parties.map(moduleName).join(" ↔ "))}</td><td>v${escapeMarkup(icd.version)}</td><td><span class="badge ${status.badge}">${status.label}</span></td><td><span class="status-dot ${link ? LINK_STATES[link.state].dot : ""}" title="${escapeMarkup(link ? `${icd.link} ${LINK_STATES[link.state].label}` : "")}"></span></td></tr>`;
  }).join("");
  const count = $("#settings-icd-count");
  if (count) count.textContent = `${ICDS.length}건`;
}

function linkForm(item) {
  const { link, settings: current } = item;
  const isConsole = link.kind === "console";
  const transports = TRANSPORTS.filter(transport => isConsole ? transport === "WebSocket" : true);
  const option = transport => `<option value="${transport}" ${transport === current.transport ? "selected" : ""}>${escapeMarkup(transportLabel(transport))}</option>`;
  const hostValue = current.host === "self" ? selfHost() : current.host;
  return `<form id="link-settings-form" class="link-form" data-link-form="${link.id}">
    <div class="form-grid"><label>전송 방식<select class="field compact" name="transport" ${isConsole ? "disabled" : ""}>${transports.map(option).join("")}</select></label><label>포트<input class="field compact" name="port" type="number" min="0" max="65535" value="${escapeMarkup(current.port)}" ${isConsole ? "disabled" : ""}></label></div>
    <label>호스트<input class="field compact" name="host" value="${escapeMarkup(hostValue)}" placeholder="127.0.0.1" ${isConsole ? "disabled" : ""}></label>
    <div class="form-grid"><label>하트비트 (s)<input class="field compact" name="heartbeat" type="number" min="0.5" step="0.5" value="${escapeMarkup(current.heartbeat)}"></label><label>타임아웃 (s)<input class="field compact" name="timeout" type="number" min="1" step="0.5" value="${escapeMarkup(current.timeout)}"></label></div>
    <div class="link-toggles"><label class="check"><input type="checkbox" name="reconnect" ${current.reconnect ? "checked" : ""}> 자동 재연결</label><label class="check"><input type="checkbox" name="enabled" ${current.enabled ? "checked" : ""}> 링크 사용</label></div>
    <div class="link-actions"><button class="button primary" type="submit">적용</button><button class="button ghost" type="button" data-link-action="reset">기본값</button><button class="button ghost" type="button" data-link-action="test">연결 시험</button></div>
    <div class="link-test" id="link-test-result" hidden></div>
  </form>`;
}

function linkDetail(item) {
  const { link } = item;
  const modes = link.modes.map(id => modeById(id).label).join(" · ");
  const icd = link.icd ? `<button type="button" class="link-button" data-open-icd="${link.icd}">${link.icd} · ${escapeMarkup(icdById(link.icd)?.title || "")}</button>` : "—";
  const probe = health.probes?.[link.id];
  const checked = probe ? `<div><dt>확인 방법</dt><dd>${escapeMarkup(probe.method === "in-process" ? "프로세스 내 검사" : probe.method === "tcp-connect" ? "TCP 접속 시험" : probe.method === "udp-resolve" ? "UDP 주소 해석" : probe.method)}${probe.latency_ms != null ? ` · ${escapeMarkup(probe.latency_ms)} ms` : ""}</dd></div>` : "";
  return `<div class="detail-head"><div><small>링크 · ${link.id} · ${escapeMarkup(LINK_KINDS[link.kind])}</small><h3>${escapeMarkup(spanLabel(link))}</h3></div>${stateBadge(item.state)}</div>
    <p class="detail-reason ${item.state}">${escapeMarkup(item.reason)}</p>
    <dl class="detail-list compact"><div><dt>사용 모드</dt><dd>${escapeMarkup(modes)}</dd></div><div><dt>ICD</dt><dd>${icd}</dd></div><div><dt>양끝 모듈</dt><dd><button type="button" class="link-button" data-select-module="${link.from}">${escapeMarkup(moduleName(link.from))}</button> · <button type="button" class="link-button" data-select-module="${link.to}">${escapeMarkup(moduleName(link.to))}</button></dd></div>${checked}</dl>
    ${[link.from, link.to].some(id => id.startsWith("security-")) ? '<p class="detail-reason">아래 주소는 연결 진단용입니다. 저장해도 실제 모듈 배치는 바뀌지 않습니다. 외부 보안 운용 SW는 서버의 SPACETWIN_SECURITY_URL 설정과 재시작으로 교체합니다. TCP 도달 가능 여부는 보안 프로토콜 검증 결과가 아닙니다.</p>' : ""}
    <h4 class="detail-title">연결 설정</h4>${linkForm(item)}`;
}

function moduleDetail(module, evaluations) {
  const deployment = module.id === "security-ops" ? securityDeployment(health.security, health.securityError) : null;
  const placement = deployment ? { label: deployment.placement, description: "서버가 보고한 실제 배치" } : PLACEMENTS[module.placement] || PLACEMENTS.embedded;
  const incident = evaluations.filter(item => item.link.from === module.id || item.link.to === module.id);
  const links = incident.map(item => {
    const other = item.link.from === module.id ? item.link.to : item.link.from;
    return `<button type="button" class="list-item" data-select-link="${item.link.id}"><span class="status-dot ${LINK_STATES[item.state].dot}"></span><span class="item-body"><b>${escapeMarkup(moduleName(other))}</b><small>${item.link.id} · ${escapeMarkup(transportLabel(item.settings.transport))} · ${escapeMarkup(endpointOf(item.settings, selfHost()))}</small></span>${stateBadge(item.state)}</button>`;
  }).join("") || `<div class="empty-state">연결된 링크 없음</div>`;
  const status = deployment?.state || moduleStatus(module.id, evaluations);
  const statusLabel = { ok: ["success", deployment ? "모듈 응답" : "정상"], warn: ["danger", deployment ? "응답 오류" : "링크 단절"], idle: ["neutral", "미연결"] }[status];
  return `<div class="detail-head"><div><small>모듈 · ${escapeMarkup(GROUPS[module.group].label)} · ${escapeMarkup(placement.label)}</small><h3>${escapeMarkup(module.name)}</h3></div><span class="badge ${statusLabel[0]}">${statusLabel[1]}</span></div>
    <p class="detail-reason">${escapeMarkup(module.role)} · ${escapeMarkup(placement.description)}</p>
    ${deployment ? `<dl class="detail-list compact"><div><dt>실제 주소</dt><dd>${escapeMarkup(deployment.endpoint)}</dd></div><div><dt>응답 상태</dt><dd>${escapeMarkup(deployment.response)}</dd></div><div><dt>계약 버전</dt><dd>${escapeMarkup(deployment.contract)}</dd></div><div><dt>구현</dt><dd>${escapeMarkup(deployment.implementation)}</dd></div></dl><p class="detail-reason">SIM 규칙 판정이며 실제 보안 검증이 아닙니다. 실제 배치는 서버 설정으로 결정되며 아래 링크의 진단 주소와 무관합니다.</p>` : ""}
    <h4 class="detail-title">기능</h4><ul class="detail-bullets">${(module.functions || []).map(text => `<li>${escapeMarkup(text)}</li>`).join("")}</ul>
    <h4 class="detail-title">연결 링크 <span class="badge neutral">${incident.length}</span></h4><div class="entity-list">${links}</div>`;
}

function renderDetail(evaluations, { force = false } = {}) {
  const host = $("#settings-detail");
  if (!host) return;
  const key = selection ? `${selection.type}:${selection.id}` : "";
  const editing = host.querySelector("form")?.contains(document.activeElement);
  if (!force && key === lastSelectionKey && editing) return;
  lastSelectionKey = key;
  if (!selection) {
    host.innerHTML = `<div class="empty-state settings-empty"><strong>토폴로지에서 모듈이나 링크를 선택하세요.</strong><span>모듈은 기능과 연결 링크를, 링크는 상태 사유와 연결 설정(전송 방식 · 엔드포인트 · 하트비트)을 보여줍니다. ICD 표의 행을 누르면 메시지 목록이 열립니다.</span></div>`;
    return;
  }
  if (selection.type === "link") {
    const item = evaluations.find(entry => entry.link.id === selection.id);
    host.innerHTML = item ? linkDetail(item) : "";
  } else {
    const module = moduleById(selection.id);
    host.innerHTML = module ? moduleDetail(module, evaluations) : "";
  }
}

function openIcdDialog(id, evaluations) {
  const icd = icdById(id);
  const dialog = $("#icd-dialog");
  if (!icd || !dialog) return;
  const [a, b] = icd.parties;
  const arrow = direction => direction === "ab" ? `${moduleName(a)} → ${moduleName(b)}` : direction === "ba" ? `${moduleName(b)} → ${moduleName(a)}` : "양방향";
  const link = evaluations.find(item => item.link.id === icd.link);
  const status = ICD_STATUSES[icd.status] || ICD_STATUSES.draft;
  $("#icd-dialog-kicker").textContent = `${icd.id} · ${status.label}`;
  $("#icd-dialog-title").textContent = icd.title;
  $("#icd-dialog-body").innerHTML = `
    <dl class="detail-list compact icd-meta">
      <div><dt>구간</dt><dd>${escapeMarkup(moduleName(a))} ↔ ${escapeMarkup(moduleName(b))}</dd></div>
      <div><dt>전송</dt><dd>${escapeMarkup(link ? `${transportLabel(link.settings.transport)} · ${endpointOf(link.settings, selfHost())}` : "—")}</dd></div>
      <div><dt>버전</dt><dd>v${escapeMarkup(icd.version)} · ${escapeMarkup(icd.revised)}</dd></div>
      <div><dt>연동 링크</dt><dd>${link ? `${icd.link} ${stateBadge(link.state)}` : "—"}</dd></div>
    </dl>
    <p class="icd-summary">${escapeMarkup(icd.summary)}</p>
    <h4 class="detail-title">메시지 <span class="badge neutral">${icd.messages.length}</span></h4>
    <div class="table-wrap icd-table"><table><thead><tr><th>ID</th><th>메시지</th><th>방향</th><th>주기</th><th>크기</th><th>구현</th><th>내용</th></tr></thead><tbody>${icd.messages.map(message => { const state = MESSAGE_STATUSES[message.status] || MESSAGE_STATUSES.planned; return `<tr><td><b>${escapeMarkup(message.id)}</b></td><td>${escapeMarkup(message.name)}</td><td>${escapeMarkup(arrow(message.direction))}</td><td>${escapeMarkup(message.rate)}</td><td>${escapeMarkup(message.size)}</td><td><span class="badge ${state.badge}">${state.label}</span></td><td class="wrap">${escapeMarkup(message.description)}</td></tr>`; }).join("")}</tbody></table></div>
    <p class="icd-summary">구현: 현재 코드가 교환하는 메시지 · 모의: 이 프로세스 안의 모의 구성이 대신하는 메시지 · 계획: 계약만 정의된 메시지</p>
    <h4 class="detail-title">개정 이력</h4><ul class="detail-bullets">${icd.history.map(text => `<li>${escapeMarkup(text)}</li>`).join("")}</ul>`;
  if (!dialog.open) dialog.showModal();
}

// ---- state changes -------------------------------------------------------------------------------

function refresh({ force = false } = {}) {
  const evaluations = evaluateLinks(context());
  const signature = JSON.stringify([settings.mode, health.security, health.securityError, evaluations.map(item => [item.state, item.reason, item.settings])]);
  if (force || signature !== lastSignature) {
    lastSignature = signature;
    renderModeBar();
    renderSummary(evaluations);
    syncTopology(evaluations);
    renderLinkTable(evaluations);
    renderIcdTable(evaluations);
    renderDetail(evaluations, { force });
  }
  renderRtt();
  applySelection();
  return evaluations;
}

function persist() {
  if (!saveSettings(storage(), settings)) toast("warning", "설정 저장 실패", "브라우저 저장소에 쓸 수 없어 이번 세션에만 적용됩니다.");
}

function select(next) {
  selection = next;
  renderDetail(evaluateLinks(context()), { force: true });
  applySelection();
}

// 서버에 실제 연결 확인을 요청한다. only가 있으면 그 링크만 다시 확인한다.
async function probeLinks({ only = null } = {}) {
  if (!api?.integrationProbe) return null;
  if (probeInFlight && !only) return null;
  const targets = probeTargets(evaluateLinks(context())).filter(target => !only || target.id === only);
  probeInFlight = true;
  const started = performance.now();
  try {
    const response = await api.integrationProbe(targets);
    health.rtt = Math.round(performance.now() - started);
    health.probes = { ...(health.probes || {}), ...(response.results || {}) };
    health.checkedAt = response.checked_at || null;
    health.probeError = null;
    return response;
  } catch (error) {
    health.rtt = null;
    health.probeError = error.message;
    for (const target of targets) health.probes[target.id] = { state: "down", method: "probe-error", detail: "연결 확인 요청 실패" };
    return null;
  } finally {
    try {
      const response = await fetch("/api/security/status", { cache: "no-store", signal: AbortSignal.timeout(3500) });
      const report = await response.json();
      if (typeof report?.reachable !== "boolean") throw new Error("유효하지 않은 모듈 상태 응답");
      if (!response.ok && report.reachable !== false) throw new Error(`HTTP ${response.status}`);
      health.security = report;
      health.securityError = null;
    } catch (error) {
      health.securityError = error.message;
    }
    probeInFlight = false;
    refresh();
  }
}

function forgetProbe(...ids) {
  if (!health.probes) return;
  for (const id of ids) delete health.probes[id];
}

function setMode(id) {
  if (settings.mode === id) return;
  settings.mode = id;
  persist();
  refresh();
  toast("success", "운용 모드 전환", modeById(id).label);
  probeLinks();
}

function applyLinkForm(form) {
  const link = linkById(form.dataset.linkForm);
  if (!link) return;
  const data = new FormData(form);
  const current = resolveLink(link, settings.links);
  const input = {
    transport: form.elements.transport?.disabled ? current.transport : data.get("transport"),
    host: form.elements.host?.disabled ? current.host : data.get("host"),
    port: form.elements.port?.disabled ? current.port : data.get("port"),
    heartbeat: data.get("heartbeat"),
    timeout: data.get("timeout"),
    reconnect: data.get("reconnect") != null,
    enabled: data.get("enabled") != null,
  };
  settings.links[link.id] = normalizeLinkSettings(input, link);
  persist();
  forgetProbe(link.id);
  refresh({ force: true });
  toast("success", `${link.id} 설정 적용`, "서버에 연결을 다시 확인합니다.");
  probeLinks();
}

function resetLink(id) {
  delete settings.links[id];
  persist();
  forgetProbe(id);
  refresh({ force: true });
  toast("success", `${id} 기본값 복원`, spanLabel(linkById(id)));
  probeLinks();
}

async function testLink(id) {
  const link = linkById(id);
  const result = $("#link-test-result");
  if (!link || !result) return;
  const token = ++testToken;
  result.hidden = false;
  result.className = "link-test pending";
  result.textContent = "연결 시험 중…";
  let outcome;
  const before = evaluateLinks(context()).find(entry => entry.link.id === id);
  if (link.kind === "console") {
    const started = performance.now();
    try {
      if (!api) throw new Error("API 없음");
      await api.health();
      outcome = { ok: true, text: `정상 · REST 왕복 ${Math.round(performance.now() - started)} ms · WebSocket ${health.socket === "open" ? "수신 중" : "미연결"}` };
    } catch (error) {
      outcome = { ok: false, text: `실패 · ${error.message}` };
    }
  } else if (before.state === "standby" || before.state === "disabled" || link.kind === "external") {
    outcome = { ok: false, text: `시험 불가 · ${before.reason}` };
  } else {
    const response = await probeLinks({ only: id });
    const probe = response?.results?.[id];
    if (!probe) outcome = { ok: false, text: `실패 · ${health.probeError || "서버 응답 없음"}` };
    else outcome = { ok: probe.state === "up", text: `${probe.state === "up" ? "정상" : probe.state === "unverified" ? "미확인" : "실패"} · ${probeReason(probe)}` };
  }
  if (token !== testToken) return;
  const target = $("#link-test-result") || result;
  target.hidden = false;
  target.className = `link-test ${outcome.ok ? "ok" : "fail"}`;
  target.textContent = outcome.text;
}

function bind() {
  $("#settings-mode-bar")?.addEventListener("click", event => {
    const button = event.target.closest("[data-settings-mode]");
    if (button) setMode(button.dataset.settingsMode);
  });
  const topology = $("#settings-topology");
  const pick = target => {
    const edge = target.closest("[data-link]");
    if (edge) return select({ type: "link", id: edge.dataset.link });
    const node = target.closest("[data-module]");
    if (node) return select({ type: "module", id: node.dataset.module });
    return select(null);
  };
  topology?.addEventListener("click", event => pick(event.target));
  topology?.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pick(event.target); } });
  $("#settings-link-rows")?.addEventListener("click", event => {
    const icd = event.target.closest("[data-open-icd]");
    if (icd) return openIcdDialog(icd.dataset.openIcd, evaluateLinks(context()));
    const row = event.target.closest("[data-link-row]");
    if (row) select({ type: "link", id: row.dataset.linkRow });
  });
  $("#settings-icd-rows")?.addEventListener("click", event => {
    const row = event.target.closest("[data-open-icd]");
    if (row) openIcdDialog(row.dataset.openIcd, evaluateLinks(context()));
  });
  $("#settings-detail-clear")?.addEventListener("click", () => select(null));
  const detail = $("#settings-detail");
  detail?.addEventListener("click", event => {
    const icd = event.target.closest("[data-open-icd]");
    if (icd) return openIcdDialog(icd.dataset.openIcd, evaluateLinks(context()));
    const module = event.target.closest("[data-select-module]");
    if (module) return select({ type: "module", id: module.dataset.selectModule });
    const link = event.target.closest("[data-select-link]");
    if (link) return select({ type: "link", id: link.dataset.selectLink });
    const action = event.target.closest("[data-link-action]");
    if (action) {
      const id = action.closest("form")?.dataset.linkForm;
      if (action.dataset.linkAction === "reset") resetLink(id);
      if (action.dataset.linkAction === "test") testLink(id);
    }
  });
  detail?.addEventListener("submit", event => {
    event.preventDefault();
    if (event.target.matches("[data-link-form]")) applyLinkForm(event.target);
  });
  $("#icd-dialog")?.addEventListener("click", event => { if (event.target === event.currentTarget) event.currentTarget.close(); });
  on("socket", () => { health.socket = store.socket; refresh(); });
  window.addEventListener("resize", () => applySelection());
}

export function initSettings({ api: client } = {}) {
  api = client || null;
  settings = loadSettings(storage());
  health = { socket: store.socket || null, rtt: null, probes: api?.integrationProbe ? {} : undefined, checkedAt: null, probeError: null };
  bind();
  refresh({ force: true });
  probeLinks();
  setInterval(() => { if (store.activeTab === "settings") probeLinks(); }, PROBE_INTERVAL_MS);
  cancelAnimationFrame(packetFrame);
  packetFrame = requestAnimationFrame(animatePackets);
}

export function updateSettingsTelemetry(payload) {
  if (payload?.runtime) store.runtime = payload.runtime;
  if (store.activeTab !== "settings") return;
  refresh();
}
