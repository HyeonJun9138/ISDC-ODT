// 데이터 관리 탭. 데이터 센터의 데이터가 얼마나 안정적으로 수집·저장·분산·복제·서비스되고 있는지를
// 데이터 관리 모듈(ICD-01)에서 받아 보여준다. 왼쪽은 모듈 연결과 저장 노드, 가운데는 안정성·파이프라인·
// 카탈로그, 오른쪽은 선택 객체와 운영 조치, 이벤트다. 값은 모듈이 보고한 것이며 이 탭은 상태를 소유하지 않는다.
// 데이터 패브릭(ICD-02, 경로·전달)과 달리 이 모듈은 데이터 객체의 위치·복제·정합성·서비스를 다룬다.
import { api } from "/static/communication/api.js?v=20260907-1";
import { drawSparkline, history, pushHistory } from "/static/visualization/charts.js";
import { emit, on, store } from "../state.js";
import { escapeMarkup as esc } from "./fault_dialog.js";
import {
  ACTION_GUIDES, CLASS_LABELS, REPLICA_LABELS, componentRows, elapsedLabel, eventRow, formatGb, formatSize, gradeOf, mergeEvents, moduleBadge, nodeRow,
  objectRow, percent, stageRows, tileRows, replicaSummary, deploymentView, acceptsDeploymentReport,
} from "../data_management/view_model.js";

const $ = selector => document.querySelector(selector);
const POLL_MS = 3000;
const MAX_EVENTS = 200;

let view = null;
let active = false;
let timer = null;
let inFlight = null;
let dashboard = null;
let events = [];
let eventCursor = 0;
let selectedObjectId = null;
let selectedNodeId = null;
let classFilter = "";
let nodeKindFilter = "all";
let eventSeverity = "all";
let searchText = "";
let searchTimer = null;
let objectsKey = null;
let nodesKey = null;
let scopeId = null, expectedDeployment = null, epoch = 0, refreshAgain = false, queryError = '', knownRun = null;

function clearScope() {
  events = []; eventCursor = 0; selectedObjectId = null; selectedNodeId = null; lastRequest = null;
  objectsKey = null; nodesKey = null;
  for(const key of ['dm-ingest','dm-lag','dm-latency']) history(key).length = 0;
  for(const id of ['#dm-spark-ingest','#dm-spark-lag','#dm-spark-latency']) {
    const canvas=$(id); canvas?.getContext('2d')?.clearRect(0,0,canvas.width,canvas.height);
  }
}

function invalidateDeployment(deployment = null) {
  if(deployment?.scope_id && deployment.scope_id === expectedDeployment?.scope_id) return;
  expectedDeployment = deployment; epoch++; scopeId = null; clearScope();
  queryError = '배치 구성을 동기화하고 있습니다.';
  dashboard = {deployment,runtime:store.runtime,nodes:[],objects:{total:0,items:[]},overview:null};
  if(active) { render(); refresh(); }
}

function toast(type, title, message) {
  emit("toast", { type, title, message });
}

/* ---------- data ---------- */

async function refresh() {
  if (inFlight) { refreshAgain = true; return inFlight; }
  const requestEpoch = epoch;
  inFlight = (async () => {
    try {
      const params = { limit: 200, after: eventCursor };
      if (classFilter) params.class = classFilter;
      if (selectedNodeId) params.node = selectedNodeId;
      if (searchText) params.query = searchText;
      const incomingDashboard = await api.dataManagementDashboard(params);
      if(requestEpoch !== epoch) return;
      if(!acceptsDeploymentReport(incomingDashboard,expectedDeployment,store.runtime?.run_id)) {
        queryError = '현재 배치와 다른 응답입니다. 구성을 다시 확인합니다.';
        renderControls(); return;
      }
      const nextScope = incomingDashboard.deployment.scope_id;
      if(nextScope !== scopeId) {
        const needsReload = params.after > 0 || !!params.node;
        clearScope(); scopeId = nextScope;
        if(needsReload) {
          expectedDeployment = incomingDashboard.deployment;
          dashboard = {...incomingDashboard,objects:{total:0,items:[]},overview:null,events:{items:[],latest:0}};
          queryError = '새 배치의 데이터를 조회하고 있습니다.';
          refreshAgain = true; render(); return;
        }
      }
      expectedDeployment = incomingDashboard.deployment;
      dashboard = incomingDashboard; queryError = '';
      const incoming = dashboard.events?.items || [];
      events = mergeEvents(events, incoming, MAX_EVENTS);
      eventCursor = Math.max(eventCursor, Number(dashboard.events?.latest) || 0);
      pushTrends(dashboard.overview);
      render();
    } catch (error) {
      if(requestEpoch !== epoch) return;
      queryError = error.message;
      $("#dm-module-badge").textContent = "대시보드 조회 실패";
      $("#dm-module-badge").className = "dm-tag danger";
      $("#dm-module-values").innerHTML = `<div><dt>오류</dt><dd>${esc(error.message)}</dd></div>`;
      renderControls();
    } finally {
      inFlight = null;
      if(refreshAgain && active) { refreshAgain = false; queueMicrotask(refresh); }
    }
  })();
  return inFlight;
}

function pushTrends(overview) {
  if (!overview) return;
  pushHistory("dm-ingest", overview.metrics?.ingest_mbps ?? 0, 60);
  pushHistory("dm-lag", overview.metrics?.mean_sync_lag_s ?? 0, 60);
  pushHistory("dm-latency", overview.metrics?.mean_latency_ms ?? 0, 60);
}

/* ---------- render ---------- */

function render() {
  if (!dashboard) return;
  renderModule(); renderNodes(); renderStability(); renderPipeline(); renderCatalog(); renderDetail(); renderPolicy(); renderEvents(); renderControls();
}

function renderControls() {
  const state=deploymentView(dashboard,queryError);
  $('#dm-deployment-note').textContent=queryError || state.message;
  $('#dm-deployment-note').classList.toggle('danger',!!queryError || dashboard?.module?.reachable === false);
  document.querySelectorAll('[data-dm-action], [data-object-action], #dm-request-form button').forEach(button=>button.disabled=!state.canOperate);
  for(const id of ['#dm-policy-apply','#dm-policy-class','#dm-policy-rf']) $(id).disabled=!state.canConfigure;
  $('#dm-snapshot').disabled=true;
}

function renderModule() {
  const module = dashboard.module || null;
  const badge = moduleBadge(module);
  const element = $("#dm-module-badge");
  element.textContent = badge.label;
  element.className = `dm-tag ${badge.tone}`;
  const sync = dashboard.sync;
  const runtime = dashboard.runtime || {};
  $("#dm-module-values").innerHTML = [
    ["구현", module ? `${module.implementation || "—"} v${module.version || "—"}` : "—"],
    ["연동 링크", "ICD-01 · L01"],
    ["모듈 시각", module?.sim_elapsed_s != null ? elapsedLabel(module.sim_elapsed_s) : "—"],
    ["SIM 런타임", `${elapsedLabel(runtime.elapsed_seconds)} · ×${runtime.speed ?? "—"} · ${runtime.running ? "실행" : "정지"}`],
    ["마지막 동기화", sync ? `${sync.nodes}개 노드 · 제품 ${sync.products}건` : module?.reachable === false ? esc(module.detail || "응답 없음") : "—"],
    ["메시지 순번", module?.sequence ?? "—"],
  ].map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`).join("");
}

function renderNodes() {
  const nodes = (dashboard.nodes || []).map(nodeRow).filter(node => nodeKindFilter === "all" || (dashboard.nodes.find(raw => raw.id === node.id)?.kind === nodeKindFilter));
  $("#dm-node-count").textContent = String(dashboard.nodes?.length || 0);
  const key = nodes.map(node => `${node.id}|${node.tone}|${node.ratio?.toFixed(3) ?? 'unknown'}|${node.objects}|${node.reason}`).join(";") + `|${selectedNodeId}|${deploymentView(dashboard,queryError).message}`;
  if (key === nodesKey) return;
  nodesKey = key;
  $("#dm-nodes").innerHTML = nodes.map(node => `<button class="dm-node ${node.tone}" role="option" aria-selected="${node.id === selectedNodeId}" data-node-id="${esc(node.id)}" title="${esc(node.reason || node.kind)}">
    <span class="status-dot ${node.tone === "ok" ? "ok" : node.tone}"></span>
    <span class="dm-node-body"><b>${esc(node.name)}</b><small>${esc(node.kind)} · 객체 ${node.objects}${node.reason ? ` · ${esc(node.reason)}` : ""}</small>
      <i class="dm-bar"><b style="width:${Math.min(100, node.ratio * 100).toFixed(1)}%" class="${node.ratio >= 0.8 ? "warning" : ""}"></b></i></span>
    <span class="dm-node-cap"><b>${esc(percent(node.ratio, 0))}</b><small>${esc(node.used)} / ${esc(node.capacity)}</small></span></button>`).join("")
    || `<div class="dm-empty">${esc(deploymentView(dashboard,queryError).message)}</div>`;
}

function renderStability() {
  const overview = dashboard.overview;
  const grade = gradeOf(overview?.stability);
  const ring = $("#dm-score-ring");
  ring.style.setProperty("--value", grade.score ?? 0);
  ring.dataset.tone = grade.tone;
  $("#dm-score").textContent = grade.score === null ? "—" : grade.score.toFixed(0);
  $("#dm-grade").textContent = grade.score === null ? "평가 대기" : `${grade.label} · 안정성`;
  $("#dm-components").innerHTML = componentRows(overview?.stability).map(row => `<div class="dm-component ${row.tone}" title="가중치 ${Math.round(row.weight * 100)} %"><span>${esc(row.label)}</span><i><b style="width:${row.fraction === null ? 0 : (row.fraction * 100).toFixed(1)}%"></b></i><b>${esc(percent(row.fraction, 0))}</b></div>`).join("");
  $("#dm-tiles").innerHTML = tileRows(overview).map(tile => `<article class="dm-tile ${tile.tone}"><small>${esc(tile.label)}</small><strong>${esc(tile.value)}</strong></article>`).join("");
  const alerts = overview?.alerts || [];
  $("#dm-alerts").innerHTML = alerts.length
    ? alerts.map(alert => `<span class="dm-alert ${esc(alert.severity)}">${esc(alert.message)}</span>`).join("")
    : grade.score === null ? `<span class="dm-alert">평가할 데이터가 없습니다.</span>` : `<span class="dm-alert ok">활성 경고 없음</span>`;
}

function renderPipeline() {
  const overview = dashboard.overview;
  const stages = stageRows(overview);
  const peak = Math.max(1, ...stages.map(stage => stage.count));
  $("#dm-stages").innerHTML = stages.map((stage, index) => `<div class="dm-stage" style="--fill:${(stage.count / peak * 100).toFixed(1)}%">
    <b>${stage.count}</b><span>${esc(stage.label)}</span><small>${esc(stage.note)}</small>${index < stages.length - 1 ? '<i class="dm-arrow" aria-hidden="true">›</i>' : ""}</div>`).join("");
  $("#dm-pipeline-note").textContent = `최근 ${Math.round((overview?.stages?.window_s || 300) / 60)}분 · SIM ${elapsedLabel(overview?.sim_elapsed_s)}`;
  const metrics = overview?.metrics || {};
  $("#dm-trend-ingest").textContent = metrics.ingest_mbps != null ? Number(metrics.ingest_mbps).toFixed(1) : "—";
  $("#dm-trend-lag").textContent = metrics.mean_sync_lag_s != null ? Number(metrics.mean_sync_lag_s).toFixed(1) : "—";
  $("#dm-trend-latency").textContent = metrics.mean_latency_ms != null ? Number(metrics.mean_latency_ms).toFixed(0) : "—";
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--blue").trim() || "#2d7ff9";
  drawSparkline($("#dm-spark-ingest"), history("dm-ingest"), accent);
  drawSparkline($("#dm-spark-lag"), history("dm-lag"), "#f39a2d");
  drawSparkline($("#dm-spark-latency"), history("dm-latency"), "#12a36d");
}

function renderCatalog() {
  const overview = dashboard.overview;
  const listing = dashboard.objects || { total: 0, items: [] };
  const replication = overview?.policy?.replication || {};
  const chips = $("#dm-class-filter");
  const classes = Object.keys(CLASS_LABELS);
  if (!chips.childElementCount) {
    chips.innerHTML = [`<button data-class="" aria-pressed="true">전체</button>`, ...classes.map(name => `<button data-class="${name}" aria-pressed="false">${esc(CLASS_LABELS[name])}</button>`)].join("");
  }
  chips.querySelectorAll("[data-class]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.class === classFilter)));
  $("#dm-catalog-count").textContent = `${listing.items.length} / ${listing.total}`;
  const key = listing.items.map(obj => `${obj.id}|${obj.status}|${obj.tier}|${obj.replicas?.map(replica => replica.state).join("")}`).join(";") + `|${selectedObjectId}|${deploymentView(dashboard,queryError).message}`;
  if (key === objectsKey) return;
  objectsKey = key;
  $("#dm-objects").innerHTML = listing.items.map(obj => {
    const row = objectRow(obj, replication[obj.class]);
    return `<tr data-object-id="${esc(row.id)}" class="${row.id === selectedObjectId ? "active" : ""}"><td><b>${esc(row.id)}</b><small>${esc(row.label)}</small></td><td>${esc(row.classLabel)}</td><td>${esc(row.source)}</td><td>${esc(row.size)}</td><td><span class="dm-tag ${row.replicaTone}">${esc(row.replicas)}</span></td><td>${esc(row.integrity)}</td><td>${esc(row.tier)}</td><td><span class="dm-tag ${row.tone}">${esc(row.statusLabel)}</span></td><td>${esc(row.created)}</td></tr>`;
  }).join("") || `<tr><td colspan="9" class="dm-empty">${esc(deploymentView(dashboard,queryError).canConfigure ? '배치한 노드의 생성 주기를 기다리거나 필터 조건을 확인하세요.' : deploymentView(dashboard,queryError).message)}</td></tr>`;
}

function selectedObject() {
  return (dashboard?.objects?.items || []).find(obj => obj.id === selectedObjectId) || null;
}

function renderDetail() {
  const host = $("#dm-detail");
  const obj = selectedObject();
  if (!obj) {
    host.innerHTML = `<div class="dm-empty tall">카탈로그에서 데이터 객체를 선택하면 복제본 배치, 정합성과 서비스 이력을 표시합니다.</div>`;
    return;
  }
  const replication = dashboard.overview?.policy?.replication?.[obj.class];
  const row = objectRow(obj, replication);
  const summary = replicaSummary(obj);
  const nodesById = new Map((dashboard.nodes || []).map(node => [node.id, node]));
  const destinations = (dashboard.nodes || []).filter(node => node.available !== false && node.capacity_gb > 0);
  host.innerHTML = `
    <header class="dm-detail-head"><span class="dm-kicker">${esc(row.classLabel)} · ${esc(obj.source)} · 버전 ${esc(obj.version)}</span><h3>${esc(obj.id)}</h3><small>${esc(obj.label)}</small>
      <div class="dm-tags"><span class="dm-tag ${row.tone}">${esc(row.statusLabel)}</span><span class="dm-tag">${esc(row.tier)} 계층</span><span class="dm-tag ${row.replicaTone}">복제 ${esc(row.replicas)}</span></div></header>
    <dl class="dm-values">
      <div><dt>크기</dt><dd>${esc(row.size)}</dd></div><div><dt>등록</dt><dd>${esc(row.created)}</dd></div>
      <div><dt>체크섬</dt><dd class="mono">${esc(obj.checksum)}</dd></div><div><dt>보존</dt><dd>${esc(obj.retention_days)}일</dd></div>
      <div><dt>마지막 검증</dt><dd>${esc(elapsedLabel(obj.last_verified_s))}</dd></div><div><dt>서비스 횟수</dt><dd>${esc(obj.requests)}</dd></div>
    </dl>
    <h4>복제본 배치 <small>검증 ${summary.verified} · 대기 ${summary.pending} · 손상 ${summary.damaged}</small></h4>
    <div class="dm-replicas">${(obj.replicas || []).map(replica => `<div class="dm-replica ${esc(replica.state)}"><b>${esc(nodesById.get(replica.node)?.name || replica.node)}</b><span>${esc(REPLICA_LABELS[replica.state] || replica.state)}</span><small>${replica.lag_s != null ? `지연 ${Number(replica.lag_s).toFixed(1)} s` : replica.ready_s != null ? `완료 ${esc(elapsedLabel(replica.ready_s))}` : "—"}</small></div>`).join("") || '<div class="dm-empty">복제본 없음</div>'}</div>
    <div class="dm-detail-actions">
      <button data-object-action="verify" data-tip="이 객체의 복제본 체크섬을 다시 확인합니다.">무결성 검사</button>
      <button data-object-action="heal" data-tip="부족하거나 손상된 복제본을 다른 노드에 다시 만듭니다.">재복제</button>
    </div>
    <form class="dm-request" id="dm-request-form"><label>서비스 요청 → <select id="dm-request-destination">${destinations.map(node => `<option value="${esc(node.id)}">${esc(node.name || node.id)}</option>`).join("")}</select></label><button type="submit" data-tip="지정한 노드가 이 객체를 요청했을 때 어느 복제본에서 얼마의 지연으로 제공되는지 확인합니다.">요청</button></form>
    <p class="dm-note" id="dm-request-result">${esc(lastRequestNote(obj.id))}</p>`;
  host.querySelectorAll("[data-object-action]").forEach(button => button.addEventListener("click", () => runAction({ action: button.dataset.objectAction, object_id: obj.id })));
  host.querySelector("#dm-request-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    if(!deploymentView(dashboard,queryError).canOperate) return;
    const actionEpoch=epoch, actionScope=scopeId;
    const destination = host.querySelector("#dm-request-destination")?.value;
    try {
      const result = await api.dataManagementRequest({ object_id: obj.id, destination, scope_id:actionScope });
      if(actionEpoch !== epoch || actionScope !== scopeId) return;
      lastRequest = result;
      $("#dm-request-result").textContent = requestNote(result);
      toast(result.status === "served" ? "success" : "warning", "서비스 요청", requestNote(result));
      refresh();
    } catch (error) { if(actionEpoch === epoch) toast("error", "서비스 요청 실패", error.message); }
  });
}

let lastRequest = null;
function requestNote(result) {
  if (!result) return "";
  return result.status === "served"
    ? `${result.id}: ${result.served_from}에서 ${result.destination}로 제공 · 지연 ${Number(result.latency_ms).toFixed(0)} ms`
    : `${result.id}: 실패 (${result.reason || "사유 미상"})`;
}
function lastRequestNote(objectId) {
  return lastRequest && lastRequest.object_id === objectId ? requestNote(lastRequest) : "요청 결과는 모듈이 고른 복제본과 예상 지연이며 실제 전송이 아닙니다.";
}

function renderPolicy() {
  const policy = dashboard.overview?.policy;
  const select = $("#dm-policy-class");
  if (!select.childElementCount) {
    select.innerHTML = Object.keys(CLASS_LABELS).map(name => `<option value="${name}">${esc(CLASS_LABELS[name])}</option>`).join("");
    select.addEventListener("change", syncPolicySlider);
  }
  if (!policy) { $('#dm-policy-note').textContent='배치 구성과 모듈 정책 수신 대기'; $('#dm-jobs').innerHTML='<div class="dm-empty">진행 중인 작업 없음</div>'; return; }
  if (!select.dataset.touched) syncPolicySlider();
  const filters = policy.filters || {};
  $("#dm-policy-note").textContent = `필터: 최소 ${filters.min_size_mb} MB · ${(filters.accept_classes || []).length}개 종류 허용 · 검사 주기 ${policy.verify_interval_s}s · 복구 ${policy.heal_rate_mbps} Mbps`;
  const jobs = (dashboard.overview?.jobs || []).filter(job => job.status === "running");
  $("#dm-jobs").innerHTML = jobs.map(job => `<div class="dm-job"><b>${esc(job.kind)}</b><span>${esc(job.object_id || job.detail || "")}${job.target ? ` → ${esc(job.target)}` : ""}</span><i class="dm-bar"><b style="width:${(job.progress * 100).toFixed(0)}%"></b></i></div>`).join("") || `<div class="dm-empty">진행 중인 작업 없음</div>`;
}

function syncPolicySlider() {
  const policy = dashboard?.overview?.policy;
  const name = $("#dm-policy-class").value;
  const value = policy?.replication?.[name] ?? 2;
  $("#dm-policy-rf").value = String(value);
  $("#dm-policy-rf-value").textContent = String(value);
}

function renderEvents() {
  const rows = events.map(eventRow).filter(row => eventSeverity === "all" || row.severity === eventSeverity);
  $("#dm-event-count").textContent = String(rows.length);
  $("#dm-events").innerHTML = rows.slice(0, 120).map(row => `<div class="dm-event ${esc(row.severity)}" ${row.objectId ? `data-object-id="${esc(row.objectId)}"` : ""}><span class="dm-event-time">${esc(row.time)}</span><b>${esc(row.kind)}</b><small>${esc(row.message)}</small></div>`).join("")
    || `<div class="dm-empty">이벤트 없음</div>`;
}

/* ---------- actions ---------- */

async function runAction(body) {
  const state=deploymentView(dashboard,queryError);
  if(!(body.action === 'set_replication' ? state.canConfigure : state.canOperate)) return;
  const actionEpoch=epoch, actionScope=scopeId;
  try {
    const result = await api.dataManagementAction({...body,scope_id:actionScope});
    if(actionEpoch !== epoch || actionScope !== scopeId) return;
    toast(result.status === "running" ? "warning" : "success", "운영 조치", result.detail || result.action);
    refresh();
  } catch (error) {
    if(actionEpoch === epoch) toast("error", "운영 조치 실패", error.message);
  }
}

function bind() {
  $("#dm-nodes").addEventListener("click", event => {
    const button = event.target.closest("[data-node-id]");
    if (!button) return;
    selectedNodeId = selectedNodeId === button.dataset.nodeId ? null : button.dataset.nodeId;
    nodesKey = null; objectsKey = null;
    refresh();
  });
  document.querySelectorAll("[data-node-kind]").forEach(button => button.addEventListener("click", () => {
    nodeKindFilter = button.dataset.nodeKind;
    document.querySelectorAll("[data-node-kind]").forEach(other => other.setAttribute("aria-pressed", String(other === button)));
    nodesKey = null; renderNodes();
  }));
  $("#dm-class-filter").addEventListener("click", event => {
    const button = event.target.closest("[data-class]");
    if (!button) return;
    classFilter = button.dataset.class;
    objectsKey = null;
    refresh();
  });
  $("#dm-search").addEventListener("input", event => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchText = event.target.value.trim(); objectsKey = null; refresh(); }, 200);
  });
  $("#dm-objects").addEventListener("click", event => {
    const row = event.target.closest("[data-object-id]");
    if (!row) return;
    selectedObjectId = selectedObjectId === row.dataset.objectId ? null : row.dataset.objectId;
    objectsKey = null; renderCatalog(); renderDetail(); renderControls();
  });
  $("#dm-events").addEventListener("click", event => {
    const row = event.target.closest("[data-object-id]");
    if (!row) return;
    selectedObjectId = row.dataset.objectId;
    objectsKey = null; renderCatalog(); renderDetail(); renderControls();
  });
  document.querySelectorAll("[data-dm-action]").forEach(button => {
    button.dataset.tip = ACTION_GUIDES[button.dataset.dmAction] || "";
    button.addEventListener("click", () => runAction({ action: button.dataset.dmAction }));
  });
  document.querySelectorAll("[data-event-severity]").forEach(button => button.addEventListener("click", () => {
    eventSeverity = button.dataset.eventSeverity;
    document.querySelectorAll("[data-event-severity]").forEach(other => other.setAttribute("aria-pressed", String(other === button)));
    renderEvents();
  }));
  $("#dm-policy-rf").addEventListener("input", event => { $("#dm-policy-rf-value").textContent = event.target.value; $("#dm-policy-class").dataset.touched = "1"; });
  $("#dm-policy-apply").addEventListener("click", () => {
    runAction({ action: "set_replication", class: $("#dm-policy-class").value, replication: Number($("#dm-policy-rf").value) });
    delete $("#dm-policy-class").dataset.touched;
  });
  $("#dm-snapshot").disabled = true;

  $("#dm-refresh").addEventListener("click", () => refresh());
  bindTooltips(view);
}

// Small guide bubble for data-tip elements, matching the node tab.
function bindTooltips(root) {
  const tip = $("#dm-tip");
  if (!tip || !root) return;
  let timer = null, current = null;
  const show = target => {
    if (!target?.dataset.tip) return;
    current = target; clearTimeout(timer);
    timer = setTimeout(() => {
      if (current !== target || !document.contains(target)) return;
      tip.textContent = target.dataset.tip; tip.hidden = false;
      const rect = target.getBoundingClientRect();
      const left = Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 8, rect.left + rect.width / 2 - tip.offsetWidth / 2));
      const above = rect.top - tip.offsetHeight - 8;
      tip.style.left = `${left}px`; tip.style.top = `${above >= 8 ? above : rect.bottom + 8}px`;
    }, 220);
  };
  const hide = () => { clearTimeout(timer); current = null; tip.hidden = true; };
  root.addEventListener("mouseover", event => { const target = event.target.closest("[data-tip]"); if (target && target !== current) show(target); });
  root.addEventListener("mouseout", event => { const target = event.target.closest("[data-tip]"); if (target && !target.contains(event.relatedTarget)) hide(); });
  root.addEventListener("focusin", event => { const target = event.target.closest("[data-tip]"); if (target) show(target); });
  root.addEventListener("focusout", hide);
  root.addEventListener("mousedown", hide);
}

function setActive(next) {
  active = next;
  clearInterval(timer); timer = null;
  if (!active) { epoch++; refreshAgain=false; return; }
  refresh();
  timer = setInterval(refresh, POLL_MS);
}

export function initDataManagement() {
  view = $("#view-data");
  if (!view || !$("#dm-objects")) return;
  bind();
  renderDetail();
  renderControls();
  knownRun=store.runtime?.run_id || null;
  const unsubscribe=on('data:deployment',invalidateDeployment);
  new MutationObserver(() => {
    const isActive = view.classList.contains("active");
    if (isActive !== active) setActive(isActive);
  }).observe(view, { attributes: true, attributeFilter: ["class"] });
  if (view.classList.contains("active")) setActive(true);
  window.addEventListener("pagehide", () => { epoch++; active=false; unsubscribe(); clearInterval(timer); clearTimeout(searchTimer); });
}

// The module is polled on its own cadence; runtime telemetry only refreshes the SIM clock readout.
export function updateDataManagementTelemetry(payload) {
  const nextRun=payload?.runtime?.run_id;
  if(nextRun && knownRun && nextRun !== knownRun) invalidateDeployment();
  if(nextRun) knownRun=nextRun;
  if (payload?.runtime) store.runtime = payload.runtime;
  if (!active || !dashboard) return;
  dashboard.runtime = { ...dashboard.runtime, elapsed_seconds: store.runtime?.elapsed_seconds, running: store.runtime?.running, speed: store.runtime?.speed };
  renderModule();
}
