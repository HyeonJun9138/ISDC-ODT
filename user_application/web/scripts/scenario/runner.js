// The scenario player: loads a PoC definition, sets the console up (constellation, stations,
// missions), then advances through the timeline steps against the scenario clock, executing each
// step's actions through the modules' ICDs and collecting KPI samples for the verdict. It owns no
// twin state: nodes live in the constellation store and the server deployment, missions in the
// mission store, faults in the runtime, judgements in the modules. DOM-free; the console module
// renders its state. Every dependency is injected so node:test can run it with fakes.
import { assembleConstellation, assembleMissions, assembleStations, fillTemplate, resolveReference } from "/static/model_library/scenario_assembly.js?v=20260908-scenario3";
import { missionPhase, timeOf } from "/static/model_library/mission_types.js";
import { emptyEvents, evaluateChecks, resultRecord, takeSample, verdict as judge } from "/static/verification/scenario_kpi.js?v=20260908-scenario3";
import { pairKey } from "../nodes/links.js?v=20260908-planes1";

export const STORAGE_KEY = "spacetwin-scenario-v1";
export const PHASES = Object.freeze(["idle", "selected", "preparing", "ready", "playing", "paused", "finished", "stale"]);
export const SAMPLE_INTERVAL_S = 2;
export const POLL_INTERVAL_MS = 5000;
export const MAX_LOG = 400;

const SETUP_STAGES = Object.freeze([
  ["runtime", "SIM 런타임 초기화 (새 실행, 시계 0초)"],
  ["constellation", "군집 조립과 서버 배치 수락 (노드 → 데이터 관리 DM-04)"],
  ["stations", "지상국 구성"],
  ["missions", "임무 등록과 편성 요청 (ICD-03 OR-01 → OR-02)"],
  ["commit", "실행 확정 통보 (ICD-03 OR-03)"],
  ["network", "네트워크 상태 첫 교환 (ICD-02 DF-01 → DF-02)"],
  ["views", "화면 준비"],
]);

const clone = value => (value == null ? value : JSON.parse(JSON.stringify(value)));

export function createScenarioRunner(deps) {
  const {
    api, constellation, groundSegment, missionStore, dataDeployment, planner, networkTwin, clock,
    storage = null, emit = () => {}, switchTab = () => {}, runtime = () => null, now = () => Date.now(), pressSdcFilter = () => {},
    wait = ms => new Promise(resolve => setTimeout(resolve, ms)), applyRuntime = () => {},
  } = deps;
  const listeners = new Set();
  let state = freshState();
  let definition = null;
  let tickTimer = null;
  let pollTimer = null;
  let lastSampleAt = null;
  let lastPollAt = 0;
  let stepBusy = false;
  let dashboard = null;
  let security = null;
  let lastRoute = null;
  let lastService = null;
  let hostTab = () => "orbit";

  function freshState() {
    return { phase: "idle", scenarioId: null, runId: null, startedAt: null, roles: {}, missions: {}, steps: {}, fault: null, faultLink: null, routeSpec: null,
      phases: {}, series: [], events: emptyEvents(), log: [], setup: { stage: null, done: [], error: null }, verdict: null, finishedAt: null, autoFollow: true, currentStep: null, pending: [] };
  }

  const notify = event => listeners.forEach(listener => listener(event, api_));
  const persist = () => { try { storage?.setItem?.(STORAGE_KEY, JSON.stringify({ ...state, series: state.series.slice(-240) })); } catch { /* session only */ } };
  const setPhase = phase => { state.phase = phase; persist(); notify("phase"); };
  const toast = (type, title, message) => emit("toast", { type, title, message });

  function log(direction, icd, message, summary, extra = {}) {
    state.log.push({ t: Math.round(elapsed() * 10) / 10, at: new Date(now()).toISOString(), direction, icd, message, summary, ...extra });
    if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
    notify("log");
  }

  const elapsed = () => clock.elapsed();
  const scenarioDate = () => new Date(clock.now());
  const roleNode = key => { const id = state.roles[key]; return id ? constellation.deployed.find(node => node.id === id) || constellation.drafts.find(node => node.id === id) || null : null; };
  const roleName = key => roleNode(key)?.name || state.roles[key] || "—";
  const missionOf = key => (state.missions[key] ? missionStore.find(state.missions[key]) : null);
  const names = () => Object.fromEntries([...constellation.deployed.map(node => [node.id, node.name]), ...groundSegment.stations.map(station => [station.id, station.name])]);

  /* ---------- catalogue ---------- */

  async function list() {
    const listing = await api.scenarios();
    return listing.scenarios.filter(item => item.kind === "poc");
  }

  async function select(scenarioId) {
    definition = await api.scenario(scenarioId);
    if (state.scenarioId !== scenarioId || state.phase === "stale") state = { ...freshState(), scenarioId, autoFollow: state.autoFollow };
    else state.scenarioId = scenarioId;
    setPhase(state.phase === "idle" ? "selected" : state.phase);
    notify("definition");
    return definition;
  }

  /* ---------- setup ---------- */

  async function stage(key, work) {
    state.setup.stage = key; state.setup.error = null; persist(); notify("setup");
    try { await work(); }
    catch (error) { state.setup.error = `${SETUP_STAGES.find(([id]) => id === key)?.[1] || key}: ${error.message}`; persist(); notify("setup"); throw error; }
    state.setup.done.push(key); persist(); notify("setup");
  }

  async function setup() {
    if (!definition) throw new Error("먼저 시나리오를 고르세요.");
    stop({ keepSelection: true });
    state = { ...freshState(), scenarioId: definition.id, autoFollow: state.autoFollow };
    setPhase("preparing");
    try {
      await stage("runtime", async () => {
        applyRuntime(await api.runtimeControl("pause"));
        const status = await api.selectScenario(definition.id);
        // The console's runtime copy is refreshed here, not a WebSocket frame later, so the scenario
        // clock reads T+0 of the new run before the constellation and missions are built.
        applyRuntime(status);
        state.runId = status.run_id; state.startedAt = status.started_at;
        clock.engage();
        log("콘솔 → 프레임워크", "ICD-07", "CS-004 시나리오 선택", `${definition.id} · 새 실행 ${status.run_id}`);
      });
      await stage("constellation", async () => {
        constellation.clear();
        networkTwin.resetHistories();
        const assembled = assembleConstellation(definition, { epoch: now(), idFactory: () => constellation.nextIds(), formationId: `FRM-${definition.id}` });
        constellation.addMany(assembled.nodes);
        state.roles = Object.fromEntries(Object.entries(assembled.roles).map(([key, node]) => [key, node.id]));
        const accepted = await dataDeployment.deploy();
        log("노드 → 런타임 → 데이터 관리", "ICD-01", "배치 수락 · DM-04 저장 노드 상태 갱신", `${accepted.nodes.length}기 · 구성 버전 ${accepted.revision}`);
        pressSdcFilter();
      });
      await stage("stations", async () => {
        groundSegment.reset();
        const wanted = assembleStations(definition);
        for (const station of groundSegment.stations) if (!wanted.some(item => item.id === station.id)) groundSegment.remove(station.id);
        for (const station of wanted) if (!groundSegment.find(station.id)) groundSegment.add({ preset: station.preset });
      });
      await stage("missions", async () => {
        for (const mission of [...missionStore.missions]) if (/^\[scenario:/.test(String(mission.notes || ""))) missionStore.remove(mission.id);
        planner.invalidateWindows();
        const roles = Object.fromEntries(Object.entries(state.roles).map(([key, id]) => [key, { id }]));
        for (const partial of assembleMissions(definition, roles, { now: clock.now() })) {
          const { mission, errors } = missionStore.add(partial, { satellites: constellation.deployed, stations: groundSegment.enabled });
          if (!mission) throw new Error(`${partial.name}: ${errors.join(", ")}`);
          state.missions[partial.key] = mission.id;
          const { request, answer } = await planner.plan(mission);
          missionStore.setPlan(mission.id, { ...answer, request_horizon: request.horizon, exclude: request.exclude });
          log("프레임워크 → 군집 운용", "ICD-03", "OR-01 임무 편성 요청 → OR-02 역할 배정", `${mission.name}: ${answer.feasible ? `${answer.tasks.length}개 작업 · 경로 ${(answer.summary?.path || []).map(id => names()[id] || id).join(" → ")}` : `실행 불가 (${answer.reasons?.[0] || ""})`}`);
        }
        persist();
      });
      await stage("commit", async () => {
        for (const spec of definition.missions) {
          const mission = missionOf(spec.key);
          if (!mission || !spec.commit || !mission.plan?.feasible) continue;
          const ack = await planner.commit(mission, "commit");
          missionStore.setStatus(mission.id, "committed", `${mission.name} 실행 확정 (시나리오) · 계획 v${mission.plan.version}`);
          log("프레임워크 → 군집 운용", "ICD-03", "OR-03 실행 확정 통보", `${mission.name} · 점유 작업 ${ack.held_tasks}개`);
        }
      });
      await stage("network", async () => {
        await tickTwin(true);
        const report = networkTwin.report;
        if (!report) throw new Error(networkTwin.fabricState.error || "데이터 패브릭이 응답하지 않습니다.");
        log("DT 엔진 → 데이터 패브릭", "ICD-02", "DF-01 네트워크 상태 갱신 → DF-02 링크 판정", `#${report.sequence} · 사용 가능 링크 ${report.summary?.usable_links}/${report.summary?.links}`);
        state.routeSpec = definition.route ? { source: resolveReference(definition.route.source, rolesById()), target: resolveReference(definition.route.target, rolesById()), objective: definition.route.objective || "latency" } : null;
        await pollModules(true);
      });
      await stage("views", async () => {
        for (const tab of ["nodes", "communication", "mission", "data", "security"]) { switchTab(tab); await wait(900); }
        switchTab("orbit");
      });
      if (definition.playback?.speed) applyRuntime(await api.runtimeSpeed(definition.playback.speed));
      setPhase("ready");
      toast("success", "시나리오 준비 완료", `${definition.name} · 재생을 누르면 시작합니다.`);
    } catch (error) {
      toast("error", "시나리오 세팅 실패", error.message);
      setPhase("selected");
      throw error;
    }
  }

  const rolesById = () => Object.fromEntries(Object.entries(state.roles).map(([key, id]) => [key, { id }]));

  /* ---------- playback ---------- */

  async function play() {
    if (!["ready", "paused"].includes(state.phase)) return;
    applyRuntime(await api.runtimeControl("start"));
    setPhase("playing");
    startTimers();
    tick().catch(error => console.warn("시나리오 틱 실패", error));
  }

  async function pause() {
    if (state.phase !== "playing") return;
    applyRuntime(await api.runtimeControl("pause"));
    setPhase("paused");
  }

  async function setSpeed(speed) {
    applyRuntime(await api.runtimeSpeed(speed));
    notify("phase");
  }

  async function advance(seconds) {
    const status = await api.scenarioAdvance(Math.max(1, Math.min(3600, Math.round(seconds))));
    applyRuntime(status);
    log("콘솔 → 프레임워크", "ICD-07", "CS-004 시계 전진", `${Math.round(seconds)}초 → T+${Math.round(status.elapsed_seconds)}s`);
    // A jump in time changes the network and the fault state at once; the fabric sees it before
    // the due steps are judged.
    await tickTwin(true);
    await tick();
  }

  // Jump to the next step that has a resolvable time in the future.
  async function skipToNextStep() {
    const next = orderedSteps().find(step => state.steps[step.id]?.firedAt == null);
    if (!next) return null;
    const due = resolveAt(next.at);
    if (due == null) { toast("warning", "다음 단계", "다음 단계의 시각을 아직 정할 수 없습니다. 임무 계획이 끝나면 다시 시도하세요."); return null; }
    const delta = due - elapsed();
    if (delta > 1) await advance(delta + 0.5);
    else tick();
    return next.id;
  }

  function stop({ keepSelection = false } = {}) {
    stopTimers();
    clock.disengage();
    if (!keepSelection) { state = freshState(); definition = null; }
    else state.phase = definition ? "selected" : "idle";
    persist(); notify("phase");
  }

  // Page hide: release the timers and the clocks but keep the persisted phase so a reload resumes.
  function suspend() {
    stopTimers();
    clock.disengage();
    persist();
  }

  function startTimers() {
    stopTimers();
    tickTimer = setInterval(() => tick().catch(error => console.warn("시나리오 틱 실패", error)), 1000);
    pollTimer = setInterval(() => pollModules(), POLL_INTERVAL_MS);
  }

  function stopTimers() {
    clearInterval(tickTimer); tickTimer = null;
    clearInterval(pollTimer); pollTimer = null;
  }

  /* ---------- the loop ---------- */

  // Advance the shared network twin and, while playing, exchange the message with the fabric before
  // anything is sampled, so route judgements never read a state the fabric has not seen yet. The
  // communication tab drives the twin while it is visible; a forced tick bypasses that.
  async function tickTwin(force = false) {
    if (!force && hostTab() === "communication") return networkTwin.last;
    const result = networkTwin.tick(scenarioDate(), { nodes: constellation.deployed, stations: groundSegment.enabled, faults: runtime()?.active_faults || [] });
    if (state.phase === "playing" || force) await networkTwin.exchange({ force });
    return result;
  }

  let runningTick = null;
  let queuedTick = null;

  // One tick at a time: the interval tick and a tick after a skip must not interleave their
  // fabric exchanges and route samples, or a stale answer could overwrite a newer one. A tick
  // requested while one runs is coalesced into a single follow-up tick.
  function tick() {
    if (!definition || !["playing", "paused", "ready", "finished"].includes(state.phase)) return Promise.resolve();
    if (!runningTick) {
      runningTick = runTick().finally(() => { runningTick = null; });
      return runningTick;
    }
    if (!queuedTick) {
      const follow = () => { queuedTick = null; return tick(); };
      queuedTick = runningTick.then(follow, follow);
    }
    return queuedTick;
  }

  async function runTick() {
    await tickTwin();
    if (state.phase === "playing") {
      // The fault's lifecycle is settled before the route is judged, so a restored primary path is
      // attributed to the clearance in the same tick.
      watchFaultLifecycle();
      await sampleRoute();
      await fireDueSteps();
      collectSample();
    }
    notify("tick");
  }

  async function sampleRoute() {
    if (!state.routeSpec || !networkTwin.reachable()) return;
    try {
      lastRoute = await networkTwin.route(state.routeSpec.source, state.routeSpec.target, state.routeSpec.objective);
      const at = elapsed();
      if (state.events.fault_at_s != null && lastRoute.status === "available") {
        const same = state.events.primary_path && JSON.stringify(lastRoute.path) === JSON.stringify(state.events.primary_path);
        if (state.events.detour_available_at_s == null && !same && !lastRoute.hop_list?.some(hop => hop.link_id === state.faultLink)) {
          state.events.detour_available_at_s = at;
          log("데이터 패브릭 → DT", "ICD-02", "DF-04 경로 계산 결과 (우회)", `${(lastRoute.path || []).map(id => names()[id] || id).join(" → ")} · ${lastRoute.hops}홉 · ${Number(lastRoute.total_delay_ms).toFixed(1)} ms`);
        }
        if (state.events.fault_end_s != null && state.events.primary_restored_at_s == null && same) {
          state.events.primary_restored_at_s = at;
          log("데이터 패브릭 → DT", "ICD-02", "DF-04 경로 계산 결과 (주 경로 복귀)", `${(lastRoute.path || []).map(id => names()[id] || id).join(" → ")}`);
        }
      } else if (state.events.fault_at_s == null && lastRoute.status === "available" && !state.events.primary_path) {
        state.events.primary_path = [...lastRoute.path];
      }
    } catch (error) {
      lastRoute = { status: "error", detail: error.message };
    }
  }

  function watchFaultLifecycle() {
    if (!state.fault || state.events.fault_end_s != null) return;
    const active = (runtime()?.active_faults || []).some(fault => fault.id === state.fault.id);
    if (!active && elapsed() >= (state.fault.expires_at ?? Infinity) - 0.5) {
      // The runtime clears the fault at its scheduled expiry; the console only notices a frame later.
      state.events.fault_end_s = Math.min(elapsed(), Number(state.fault.expires_at) || elapsed());
      log("DT 런타임", "ICD-05", "EN-04 fault.cleared 이벤트", `${state.fault.target} 장애 해제`);
      persist();
    }
  }

  async function pollModules(force = false) {
    if (!force && now() - lastPollAt < POLL_INTERVAL_MS - 200) return;
    lastPollAt = now();
    const tasks = [];
    if (force || hostTab() !== "data") tasks.push(api.dataManagementDashboard({ limit: 20 }).then(result => { dashboard = result; log("DT 엔진 → 데이터 관리", "ICD-01", "DM-01 수집 등록 · DM-05 상태 보고", `객체 ${result.overview?.metrics?.objects ?? 0} · 안정성 ${result.overview?.stability?.score ?? "—"}`, { quiet: true }); }).catch(() => { dashboard = null; }));
    if (force || hostTab() !== "security") tasks.push(api.securityDashboard().then(result => { security = result; log("DT 엔진 → 보안 운용 SW", "ICD-08", "SEC-01 관측 전달 → SEC-02 판정", `인증 판정 ${result.overview?.verdict?.authentication || "—"}`, { quiet: true }); }).catch(() => { security = null; }));
    await Promise.all(tasks);
    notify("modules");
  }

  function currentSample() {
    const mission = missionOf("relay") || Object.values(state.missions).map(id => missionStore.find(id)).find(Boolean) || null;
    return takeSample({
      at_s: elapsed(), route: lastRoute, report: networkTwin.report, sourceId: state.roles.source || null, faultLink: state.faultLink,
      mission, missionPhase: mission ? missionPhase(mission, clock.now()) : null, dashboard, security, service: lastService, names: names(),
    });
  }

  function collectSample() {
    const at = elapsed();
    if (lastSampleAt != null && at - lastSampleAt < (definition.playback?.sample_interval_s || SAMPLE_INTERVAL_S)) return;
    lastSampleAt = at;
    state.series.push(currentSample());
    if (state.series.length > 600) state.series.splice(0, state.series.length - 600);
  }

  /* ---------- steps ---------- */

  const orderedSteps = () => [...(definition?.steps || [])].sort((a, b) => a.order - b.order);

  function taskAnchor(anchor) {
    const mission = missionOf(anchor.mission);
    const tasks = (mission?.plan?.tasks || []).filter(task => !anchor.task_kind || task.kind === anchor.task_kind);
    const task = tasks[anchor.index || 0];
    if (!task) return null;
    const ms = timeOf(anchor.edge === "end" ? task.end : task.start);
    return ms == null ? null : (ms - clock.startMs()) / 1000;
  }

  function resolveAt(at) {
    if (!at) return 0;
    const offset = Number(at.offset_s) || 0;
    if (Array.isArray(at.max)) {
      const values = at.max.map(item => resolveAt({ ...item, offset_s: 0 }));
      if (values.some(value => value == null)) return at.fallback_s != null ? Number(at.fallback_s) + offset : null;
      return Math.max(...values) + offset;
    }
    if (at.after) {
      const fired = state.steps[at.after]?.firedAt;
      return fired == null ? null : fired + offset;
    }
    let base = 0;
    if (at.anchor === "task") base = taskAnchor(at);
    else if (at.anchor === "mission_end") {
      const mission = missionOf(at.mission);
      const finish = mission?.plan?.summary?.finish_at ? timeOf(mission.plan.summary.finish_at) : null;
      base = finish == null ? null : (finish - clock.startMs()) / 1000;
    } else if (at.anchor === "fault_end") base = state.steps[at.step]?.faultExpiresAt ?? null;
    if (base == null) return at.fallback_s != null ? Number(at.fallback_s) + offset : null;
    return base + offset;
  }

  async function fireDueSteps() {
    if (stepBusy) return;
    const at = elapsed();
    for (const step of orderedSteps()) {
      if (state.steps[step.id]?.firedAt != null) continue;
      const due = resolveAt(step.at);
      state.steps[step.id] = { ...(state.steps[step.id] || {}), due };
      if (due == null || at < due) break;
      stepBusy = true;
      try { await fireStep(step, at); } finally { stepBusy = false; }
      break;
    }
    for (const pending of [...state.pending]) {
      if (at < pending.due) continue;
      state.pending = state.pending.filter(item => item !== pending);
      await runAction(pending.action, orderedSteps().find(step => step.id === pending.step));
    }
  }

  async function fireStep(step, at) {
    state.steps[step.id] = { ...(state.steps[step.id] || {}), firedAt: at, status: "active" };
    state.currentStep = step.id;
    if (step.speed && Number(runtime()?.speed) !== Number(step.speed)) { try { applyRuntime(await api.runtimeSpeed(step.speed)); } catch { /* keep the current speed */ } }
    for (const action of step.actions || []) {
      if (action.delay_s) state.pending.push({ step: step.id, action, due: at + Number(action.delay_s) });
      else await runAction(action, step);
    }
    persist();
    notify("step");
    if (state.autoFollow) switchTab(step.tab);
    emit("scenario:step", { step, context: context() });
  }

  async function runAction(action, step) {
    try {
      switch (action.kind) {
        case "route": {
          if (state.routeSpec) emit("scenario:route", state.routeSpec);
          break;
        }
        case "sample": {
          await pollModules(true);
          await sampleRoute();
          state.phases[action.phase] = currentSample();
          log("프레임워크 → 시험 관리", "ICD-06", "VF-02 KPI 샘플", `${action.phase} 구간 표본 기록`);
          break;
        }
        case "inject_fault": {
          const target = faultTargetOf(action.target);
          if (!target) throw new Error("장애를 줄 링크를 계획에서 찾지 못했습니다.");
          const fault = await api.injectFault({ target, kind: action.fault || "link_loss", severity: action.severity || "high", duration_seconds: Number(action.duration_s) || 300 });
          state.fault = fault; state.faultLink = target;
          state.events.fault_at_s = elapsed(); state.events.fault_link = target;
          state.steps[step.id].faultExpiresAt = Number(fault.expires_at);
          log("콘솔 → 프레임워크", "ICD-07", "CS-004 장애 주입", `${target} · ${fault.kind} · ${fault.severity} · ${fault.duration_seconds}s`);
          toast("warning", "장애 주입", `${linkLabel(target)} 링크 손실 (${fault.duration_seconds}s)`);
          break;
        }
        case "verify_link_unusable": {
          await tickTwin(true);
          const report = networkTwin.report;
          const verdictOfLink = report?.links?.find(link => link.id === state.faultLink) || null;
          log("DT 엔진 → 데이터 패브릭", "ICD-02", "DF-01 faulted=true → DF-02 판정", verdictOfLink ? `${linkLabel(state.faultLink)}: usable=${verdictOfLink.usable} (${verdictOfLink.reason || "—"})` : "장애 링크가 네트워크 상태에 없음");
          break;
        }
        case "replan_mission": {
          const mission = missionOf(action.mission);
          if (!mission) throw new Error("재구성할 임무가 없습니다.");
          const affected = planner.affectedTasks(mission, clock.now());
          const { request, answer } = await planner.plan(mission, { exclude: affected.satellites });
          missionStore.setPlan(mission.id, { ...answer, request_horizon: request.horizon, exclude: request.exclude });
          log("프레임워크 → 군집 운용", "ICD-03", "OR-01 재구성 요청 (장애 링크 제외) → OR-02", `${mission.name}: ${answer.feasible ? `${answer.tasks.length}개 작업 · 경로 ${(answer.summary?.path || []).map(id => names()[id] || id).join(" → ")}` : `실행 불가 (${answer.reasons?.[0] || ""})`}`);
          state.events.reroute_at_s = elapsed();
          const updated = missionStore.find(mission.id);
          if (updated?.plan?.feasible) {
            const ack = await planner.commit(updated, "commit");
            missionStore.setStatus(mission.id, "committed", `${mission.name} 재구성 실행 확정 · 계획 v${updated.plan.version}`);
            log("프레임워크 → 군집 운용", "ICD-03", "OR-03 실행 확정 통보 (재구성)", `${mission.name} · 점유 작업 ${ack.held_tasks}개`);
          }
          break;
        }
        case "dm_request": {
          if (!definition.service || !dashboard?.deployment?.scope_id) break;
          const destination = resolveReference(definition.service.destination, rolesById());
          lastService = await api.dataManagementRequest({ class: definition.service.class, destination, scope_id: dashboard.deployment.scope_id });
          log("DT 엔진 → 데이터 관리", "ICD-01", "DM-02 서비스 요청", lastService.status === "served" ? `${lastService.id}: ${names()[lastService.served_from] || lastService.served_from} → ${names()[destination] || destination} · ${Number(lastService.latency_ms).toFixed(0)} ms` : `${lastService.id}: 실패 (${lastService.reason || "—"})`);
          break;
        }
        case "verdict": {
          await tickTwin(true);
          await pollModules(true);
          await sampleRoute();
          state.phases.recovery = state.phases.recovery || currentSample();
          state.verdict = judge(definition.criteria, context());
          state.finishedAt = new Date(now()).toISOString();
          log("프레임워크 → 시험 관리", "ICD-06", "VF-03 시험 결과 기록", `${state.verdict.passed}/${state.verdict.total} 항목 통과 · ${state.verdict.ok ? "복구 판정 통과" : "복구 판정 미달"}`);
          stopTimers();
          try { await api.runtimeControl("pause"); } catch { /* the verdict stands regardless */ }
          setPhase("finished");
          toast(state.verdict.ok ? "success" : "warning", "복구 판정", `${state.verdict.passed}/${state.verdict.total} 항목 통과`);
          break;
        }
        case "switch_tab": switchTab(action.tab); break;
        default: break;
      }
    } catch (error) {
      log("재생기", "—", `${action.kind} 실패`, error.message, { error: true });
      toast("error", `단계 조치 실패 (${action.kind})`, error.message);
    }
    persist();
    notify("action");
  }

  // The primary link of a plan: the crosslink task the definition points at, as the OISL pair id
  // the runtime and the network message use.
  function faultTargetOf(spec) {
    const mission = missionOf(spec?.from_plan);
    const tasks = (mission?.plan?.tasks || []).filter(task => task.kind === (spec.task_kind || "crosslink"));
    const task = tasks[spec.index || 0];
    return task?.counterpart ? pairKey(task.satellite, task.counterpart) : null;
  }

  function linkLabel(id) {
    const [a, b] = String(id || "").split("|");
    return `${names()[a] || a} ↔ ${names()[b] || b}`;
  }

  /* ---------- context for guidance and checks ---------- */

  function context() {
    const latest = currentSample();
    const relay = missionOf("relay");
    const nameOf = id => names()[id] || id;
    return {
      phases: state.phases, series: state.series, events: state.events, latest,
      source: roleName("source"), relay_node: roleName("relay"), alternate: roleName("alternate"), gateway: roleName("gateway"),
      relay: relay ? { path: (relay.plan?.summary?.path || []).map(nameOf).join(" → "), replan_path: (relay.plan?.summary?.path || []).map(nameOf).join(" → "), status: missionPhase(relay, clock.now()).label, version: relay.plan?.version } : {},
      route: lastRoute ? { path: (lastRoute.path || []).map(nameOf).join(" → "), hops: lastRoute.hops, delay: lastRoute.total_delay_ms == null ? "—" : `${Number(lastRoute.total_delay_ms).toFixed(1)} ms` } : {},
      fault: state.fault ? { link: linkLabel(state.faultLink), duration_s: state.fault.duration_seconds, id: state.fault.id } : { link: "(계획의 첫 위성 간 구간)", duration_s: definition?.steps?.find(step => step.actions?.some(action => action.kind === "inject_fault"))?.actions?.find(action => action.kind === "inject_fault")?.duration_s },
    };
  }

  function stepView(step) {
    const record = state.steps[step.id] || {};
    const ctx = context();
    return {
      ...step, firedAt: record.firedAt ?? null, due: record.due ?? resolveAt(step.at), status: record.firedAt != null ? (state.currentStep === step.id && state.phase !== "finished" ? "active" : "done") : "pending",
      narrativeText: fillTemplate(step.narrative, ctx), checkResults: record.firedAt != null ? evaluateChecks(step.checks, ctx) : [],
    };
  }

  function view() {
    return {
      phase: state.phase, scenario: definition, scenarioId: state.scenarioId, runId: state.runId, startedAt: state.startedAt, elapsed: elapsed(), now: clock.now(),
      running: clock.running, speed: clock.speed, steps: orderedSteps().map(stepView), currentStep: state.currentStep, setup: { ...state.setup, stages: SETUP_STAGES },
      roles: Object.fromEntries(Object.keys(state.roles).map(key => [key, { id: state.roles[key], name: roleName(key), label: definition?.constellation?.roles?.[key]?.label || key }])),
      missions: Object.fromEntries(Object.entries(state.missions).map(([key, id]) => [key, missionStore.find(id)])), fault: state.fault, faultLink: state.faultLink, events: state.events,
      log: state.log, verdict: state.verdict, phases: state.phases, autoFollow: state.autoFollow, modules: { fabric: networkTwin.fabricState, data: dashboard?.module || null, security: security?.module || null },
    };
  }

  function record() {
    return resultRecord({ scenario: definition, runId: state.runId, phases: state.phases, series: state.series, events: state.events, verdictResult: state.verdict, log: state.log, startedAt: state.startedAt, finishedAt: state.finishedAt });
  }

  /* ---------- persistence ---------- */

  async function restore() {
    let saved = null;
    try { saved = JSON.parse(storage?.getItem?.(STORAGE_KEY) || "null"); } catch { saved = null; }
    if (!saved?.scenarioId || saved.phase === "idle") return false;
    try { definition = await api.scenario(saved.scenarioId); } catch { return false; }
    state = { ...freshState(), ...saved, setup: saved.setup || freshState().setup };
    const runId = runtime()?.run_id;
    if (saved.runId && runId && saved.runId !== runId) { state.phase = "stale"; persist(); notify("phase"); return true; }
    if (["playing", "paused", "ready", "finished"].includes(state.phase)) {
      clock.engage();
      if (state.phase === "playing") startTimers();
    } else if (state.phase === "preparing") state.phase = "selected";
    notify("phase");
    return true;
  }

  function setAutoFollow(value) { state.autoFollow = value !== false; persist(); notify("phase"); }
  function onTelemetry() { if (state.phase === "playing" && !tickTimer) startTimers(); }

  const api_ = {
    list, select, setup, play, pause, setSpeed, advance, skipToNextStep, stop, suspend, tick, restore, view, record, context, setAutoFollow, onTelemetry,
    get definition() { return definition; }, get state() { return state; },
    setHostTab(fn) { hostTab = fn; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return api_;
}
