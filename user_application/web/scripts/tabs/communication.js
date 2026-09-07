import { api } from "/static/communication/api.js";
import { drawSparkline, pushHistory } from "/static/visualization/charts.js";
import { emit, store } from "../state.js";

const $ = (selector) => document.querySelector(selector);
let listMode = "nodes";
let layoutMode = "mesh";
let routeLinkIds = new Set();
let contactWindows = [];
const baseQualities = new Map();

const colors = { good: "#12a36d", fair: "#2d7ff9", warn: "#f39a2d", bad: "#e75555", line: "#b9c9da" };
const linkColor = (q, protocol) => q < 50 ? colors.bad : q < 75 ? colors.warn : protocol === "DTN" ? colors.fair : colors.good;
const nodeIcon = (type) => type === "satellite" ? "✣" : type === "ground" ? "⌁" : "▣";

function renderSummary() {
  const counts = store.communication.nodes.reduce((acc, item) => { acc[item.type] = (acc[item.type] || 0) + 1; return acc; }, {});
  $("#node-type-summary").innerHTML = `<span><b>${store.communication.nodes.length}</b>전체</span><span><b>${counts.satellite || 0}</b>위성</span><span><b>${counts.ground || 0}</b>지상국</span><span><b>${counts.gateway || 0}</b>게이트웨이</span>`;
}

function renderEntityList() {
  const container = $("#comm-entity-list");
  if (listMode === "nodes") {
    container.innerHTML = store.communication.nodes.map((node) => `<button class="list-item" data-comm-node="${node.id}"><span class="status-dot ${node.status === "online" ? "ok" : node.status === "warning" ? "warning" : "danger"}"></span><span class="item-body"><b>${node.id}</b><small>${node.type.toUpperCase()}</small></span><span class="badge ${node.status === "online" ? "success" : "warning"}">${node.status === "online" ? "OK" : "경고"}</span></button>`).join("");
  } else {
    container.innerHTML = store.communication.links.map((link) => `<button class="list-item ${store.selectedLink === link.id ? "active" : ""}" data-comm-link="${link.id}"><span class="entity-icon">⌁</span><span class="item-body"><b>${link.source} → ${link.target}</b><small>${link.protocol}</small></span><span class="badge ${link.quality >= 80 ? "success" : link.quality >= 60 ? "warning" : "danger"}">${link.quality}%</span></button>`).join("");
  }
  container.querySelectorAll("[data-comm-link]").forEach((button) => button.addEventListener("click", () => selectLink(button.dataset.commLink)));
  container.querySelectorAll("[data-comm-node]").forEach((button) => button.addEventListener("click", () => focusNode(button.dataset.commNode)));
}

function transformedNode(node) {
  if (layoutMode === "geo") return { ...node, px: 100 + node.x * 8, py: 80 + node.y * 4.6 };
  return { ...node, px: 90 + node.x * 8.2, py: 35 + node.y * 5.25 };
}

function renderNetwork() {
  const svg = $("#network-svg");
  const protocol = $("#protocol-filter").value;
  const nodes = store.communication.nodes.map(transformedNode);
  const map = new Map(nodes.map((n) => [n.id, n]));
  const links = store.communication.links.filter((link) => protocol === "all" || link.protocol === protocol);
  const defs = `<defs><filter id="nodeShadow"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000" flood-opacity=".18"/></filter><pattern id="dots" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="var(--diagram-grid)"/></pattern></defs>`;
  const grid = `<rect x="0" y="0" width="1000" height="640" fill="url(#dots)" opacity=".45"/><ellipse cx="500" cy="330" rx="455" ry="240" fill="none" stroke="var(--diagram-ring)" stroke-width="1.5"/><ellipse cx="500" cy="330" rx="350" ry="180" fill="none" stroke="var(--diagram-grid)" stroke-width="1"/>`;
  const linkMarkup = links.map((link) => {
    const a=map.get(link.source), b=map.get(link.target); if(!a||!b)return "";
    const color=linkColor(link.quality, link.protocol); const selected=store.selectedLink===link.id; const routed=routeLinkIds.has(link.id);
    const mx=(a.px+b.px)/2, my=(a.py+b.py)/2;
    return `<g class="net-link" data-network-link="${link.id}"><line x1="${a.px}" y1="${a.py}" x2="${b.px}" y2="${b.py}" stroke="${routed?'#8b5cf6':color}" stroke-width="${routed?6:selected?5:2.4}" stroke-dasharray="${routed?'none':link.protocol==='DTN'?'8 6':'5 4'}" opacity="${routeLinkIds.size && !routed ? .35 : 1}"/><rect x="${mx-18}" y="${my-12}" width="36" height="20" rx="3" fill="var(--diagram-node)" stroke="${routed?'#8b5cf6':color}"/><text x="${mx}" y="${my+2}" text-anchor="middle" font-size="10" font-weight="800" fill="${routed?'#8b5cf6':color}">${link.quality}%</text></g>`;
  }).join("");
  const nodeMarkup = nodes.map((node) => {
    const color=node.status==='online'?colors.good:node.status==='warning'?colors.warn:colors.bad;
    return `<g class="net-node" data-network-node="${node.id}" transform="translate(${node.px},${node.py})"><circle class="node-halo" r="30" fill="none" stroke="${color}" stroke-width="5" opacity=".12"/><circle r="22" fill="var(--diagram-node)" stroke="${color}" stroke-width="2.5" filter="url(#nodeShadow)"/><text y="5" text-anchor="middle" font-size="17" fill="var(--diagram-text)">${nodeIcon(node.type)}</text><text class="net-label" y="42" text-anchor="middle">${node.id}</text></g>`;
  }).join("");
  svg.innerHTML = defs + grid + linkMarkup + nodeMarkup;
  svg.querySelectorAll("[data-network-link]").forEach((item) => item.addEventListener("click", () => selectLink(item.dataset.networkLink)));
  svg.querySelectorAll("[data-network-node]").forEach((item) => item.addEventListener("click", () => focusNode(item.dataset.networkNode)));
}

function selectLink(id) {
  store.selectedLink = id;
  const link = store.communication.links.find((item) => item.id === id);
  if (!link) return;
  $("#selected-link-name").textContent = `${link.source} → ${link.target}`;
  $("#selected-link-detail").innerHTML = `<div><dt>Link ID</dt><dd>${link.id}</dd></div><div><dt>Protocol</dt><dd>${link.protocol}</dd></div><div><dt>Quality</dt><dd>${link.quality}%</dd></div><div><dt>Status</dt><dd>${link.quality >= 75 ? "정상" : "경고"}</dd></div>`;
  $("#budget-distance").value = String(Math.round(600 + (100-link.quality)*32));
  renderContacts();
  renderNetwork(); renderEntityList();
}

function focusNode(id) {
  const node = store.communication.nodes.find((item) => item.id === id);
  if (!node) return;
  emit("toast", { type: node.status === "online" ? "success" : "warning", title: id, message: `${node.type} · ${node.status}` });
}

function renderQueue() {
  $("#packet-queue").innerHTML = store.communication.queue.map((item) => `<article class="queue-item"><b>${item.id}</b><small>${item.route}</small><div class="queue-progress"><i style="width:${item.progress}%"></i></div><small>${item.size} · ${item.protocol}</small></article>`).join("");
}

function renderLogs() {
  const now = new Date();
  const links = store.communication.links.slice(0, 7);
  $("#packet-log-body").innerHTML = links.map((link, i) => `<tr><td>${new Date(now-i*740).toISOString().slice(11,23)}</td><td>${link.source}</td><td>${link.target}</td><td>${link.protocol}</td><td><span class="badge ${link.quality >= 70 ? "success" : "danger"}">${link.quality >= 70 ? "전송" : "실패"}</span></td></tr>`).join("");
}

function qualityTemplate(id, label, value, unit, color) {
  return `<article class="quality-card"><small>${label}</small><strong id="${id}-value">${value} <small>${unit}</small></strong><canvas id="${id}-chart" width="240" height="44"></canvas></article>`;
}

function renderQualityCards() {
  $("#link-quality-cards").innerHTML = [
    qualityTemplate("delay","지연시간 (Delay)","31.2","ms",colors.good), qualityTemplate("loss","패킷 손실 (Loss)","0.32","%",colors.fair), qualityTemplate("throughput","처리량 (Throughput)","42.8","Mbps",colors.warn), qualityTemplate("ber","비트 오류율 (BER)","1.2e-6","",colors.bad), qualityTemplate("auth","인증 상태 (Auth)","99.8","%",colors.good),
  ].join("");
}

function populateRouteControls() {
  const options=store.communication.nodes.map((node)=>`<option value="${node.id}">${node.id}</option>`).join("");
  $("#route-source").innerHTML=options; $("#route-target").innerHTML=options;
  $("#route-source").value="SAT-01"; $("#route-target").value="GW-DTN";
}

async function calculateRoute() {
  try {
    const result=await api.route($("#route-source").value,$("#route-target").value,$("#route-objective").value);
    routeLinkIds=new Set(result.link_ids||[]); renderNetwork();
    $("#route-result").textContent=result.status==="available"?`${result.path.join(" → ")} · ${result.hops} hops`:`경로 없음 · 장애 ${result.active_fault_targets.join(", ")||"—"}`;
    emit("toast",{type:result.status==="available"?"success":"warning",title:"시간의존 경로 계산",message:$("#route-result").textContent});
  } catch(error){emit("toast",{type:"error",title:"경로 계산 실패",message:error.message});}
}

async function loadContacts() {
  try { const payload=await api.contacts(12); contactWindows=payload.items||[]; renderContacts(); }
  catch(error){emit("toast",{type:"error",title:"접속창 로드 실패",message:error.message});}
}

function renderContacts() {
  const selected=store.selectedLink;
  const items=(selected?contactWindows.filter((item)=>item.link_id===selected):contactWindows).slice(0,6);
  $("#contact-window-list").innerHTML=items.map((item)=>{const start=new Date(item.start).toISOString().slice(11,16);const end=new Date(item.end).toISOString().slice(11,16);return `<article class="contact-window"><b>${item.source} → ${item.target}</b><small><span>${start}–${end} UTC</span><span>${item.capacity_mb} MB</span></small><div class="contact-bar"><i style="width:${item.quality}%"></i></div></article>`;}).join("")||`<div class="empty-state">선택 링크 접속창 없음</div>`;
}

async function calculateBudget() {
  const link=store.communication.links.find((item)=>item.id===store.selectedLink)||store.communication.links[0];
  const payload={link_id:link.id,frequency_ghz:Number($("#budget-frequency").value),distance_km:Number($("#budget-distance").value),tx_power_w:Number($("#budget-power").value),tx_gain_dbi:Number($("#budget-tx-gain").value),rx_gain_dbi:Number($("#budget-rx-gain").value),misc_losses_db:3,bandwidth_mhz:Number($("#budget-bandwidth").value),data_rate_mbps:10,system_temp_k:290,required_ebno_db:7};
  try{const result=await api.linkBudget(payload);$("#budget-result").innerHTML=`<article><small>FSPL</small><b>${result.fspl_db} dB</b></article><article><small>Rx Power</small><b>${result.received_power_dbw} dBW</b></article><article><small>Eb/N₀</small><b>${result.ebno_db} dB</b></article><article><small>Margin</small><b style="color:${result.margin_db>=3?'var(--green)':result.margin_db>=0?'var(--orange)':'var(--red)'}">${result.margin_db} dB</b></article><span>${result.model} · 용량 ${result.capacity_mbps} Mbps · ${result.status.toUpperCase()}</span>`;}
  catch(error){emit("toast",{type:"error",title:"링크 버짓 계산 실패",message:error.message});}
}

function bind() {
  document.querySelectorAll("[data-comm-list]").forEach((button) => button.addEventListener("click", () => {
    listMode=button.dataset.commList; document.querySelectorAll("[data-comm-list]").forEach((item)=>item.classList.toggle("active",item===button)); renderEntityList();
  }));
  document.querySelectorAll("[data-network-layout]").forEach((button) => button.addEventListener("click", () => {
    layoutMode=button.dataset.networkLayout; document.querySelectorAll("[data-network-layout]").forEach((item)=>item.classList.toggle("active",item===button)); renderNetwork();
  }));
  $("#protocol-filter").addEventListener("change", renderNetwork);
  $("#clear-packet-log").addEventListener("click", () => $("#packet-log-body").innerHTML="");
  $("#link-fault-button").addEventListener("click", () => {
    const selected=store.communication.links.find((item)=>item.id===store.selectedLink) || store.communication.links[0];
    $("#fault-target").innerHTML=`<option>${selected.id}</option><option>${selected.source}</option><option>${selected.target}</option>`; $("#fault-dialog").showModal();
  });
  $("#route-calculate").addEventListener("click",calculateRoute);
  $("#budget-calculate").addEventListener("click",calculateBudget);
  document.querySelectorAll("[data-comm-analysis]").forEach((button)=>button.addEventListener("click",()=>{document.querySelectorAll("[data-comm-analysis]").forEach((item)=>item.classList.toggle("active",item===button));document.querySelectorAll("[data-comm-pane]").forEach((pane)=>pane.hidden=pane.dataset.commPane!==button.dataset.commAnalysis);}));
}

export async function initCommunication() {
  store.communication.links.forEach((link)=>baseQualities.set(link.id,link.quality));
  renderSummary(); renderEntityList(); renderNetwork(); renderQueue(); renderLogs(); renderQualityCards(); populateRouteControls(); bind();
  window.addEventListener("spacetwin:themechange",renderNetwork);
  if (store.communication.links[0]) selectLink(store.communication.links[0].id);
  await loadContacts(); await calculateRoute(); await calculateBudget();
}

export function updateCommunicationTelemetry(payload) {
  const t=payload.telemetry||{};
  const values={delay:[t.delay_ms,"ms",colors.good],loss:[t.loss_percent,"%",colors.fair],throughput:[t.throughput_mbps,"Mbps",colors.warn],ber:[t.ber,"",colors.bad],auth:[t.auth_percent,"%",colors.good]};
  Object.entries(values).forEach(([id,[value,unit,color]])=>{
    const el=$(`#${id}-value`); if(!el)return;
    const display=id==="ber"?Number(value||0).toExponential(1):Number(value||0).toFixed(id==="loss"||id==="auth"?2:1);
    el.innerHTML=`${display} <small>${unit}</small>`;
    drawSparkline($(`#${id}-chart`),pushHistory(`comm-${id}`,Number(value||0)),color);
  });
  store.communication.links.forEach((link)=>{link.quality=baseQualities.get(link.id)??link.quality;});
  (store.runtime.active_faults||[]).filter((fault)=>fault.kind==="link_loss").forEach((fault)=>{store.communication.links.filter((link)=>link.id===fault.target||link.source===fault.target||link.target===fault.target).forEach((link)=>{const penalty=fault.severity==="high"?75:fault.severity==="low"?25:50;link.quality=Math.max(0,(baseQualities.get(link.id)||link.quality)-penalty);});});
  renderNetwork();
}
