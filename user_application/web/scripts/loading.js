// Full-screen loading screen shown until the console's start-up work has finished. Every phase has a
// weight; the percentage is the weighted sum of the phase fractions, so it estimates work done rather
// than measuring time remaining. Phases are reported by whoever does the work (app bootstrap, the
// globe, the catalogue loader) and finish() forces the optional ones to complete.
//
// The shown value is not the raw estimate: it eases toward each new estimate and, while a phase has
// no sub-progress to report (a single HTTP request, the first imagery tiles), creeps asymptotically
// toward the end of that phase so the bar never looks frozen and never claims a phase is complete.
export const LOADING_PHASES = [
  { key: "bootstrap", weight: 6, label: "런타임 상태 수신" },
  { key: "library", weight: 14, label: "Cesium / SGP4 라이브러리 로드" },
  { key: "imagery", weight: 10, label: "지구 영상 타일 로드" },
  { key: "catalog", weight: 20, label: "GP 카탈로그 수신" },
  { key: "propagation", weight: 40, label: "궤도 요소 준비" },
  { key: "models", weight: 4, label: "위성 3D 모델 목록" },
  { key: "telemetry", weight: 6, label: "실시간 텔레메트리 연결" },
];

// Easing time constants in milliseconds: fast catch-up to a new estimate, slow creep inside a phase.
const CATCH_UP_MS = 220;
const CREEP_MS = 7000;

const clamp = value => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

export function progressPercent(fractions, phases = LOADING_PHASES) {
  const total = phases.reduce((sum, phase) => sum + phase.weight, 0);
  if (!total) return 0;
  const done = phases.reduce((sum, phase) => sum + phase.weight * clamp(fractions[phase.key]), 0);
  return Math.round(done / total * 100);
}

// The first phase, in declared order, that has not completed; null when everything is done.
export function currentPhase(fractions, phases = LOADING_PHASES) {
  return phases.find(phase => clamp(fractions[phase.key]) < 1) || null;
}

// Highest value the shown bar may creep to: just short of the current phase completing.
export function phaseCeiling(fractions, phases = LOADING_PHASES) {
  const phase = currentPhase(fractions, phases);
  if (!phase) return 100;
  const completed = progressPercent({ ...fractions, [phase.key]: 1 }, phases);
  return Math.max(progressPercent(fractions, phases), completed - 1);
}

// One animation step of the shown value. Below the estimate it catches up quickly; at or above it
// it creeps toward the ceiling with an exponential approach that never arrives.
export function smoothedPercent(shown, target, ceiling, dtMs) {
  const dt = Math.max(0, Number(dtMs) || 0);
  // The catch-up is asymptotic, so treat anything within a twentieth of a point as arrived;
  // otherwise the value would sit just under the estimate and never start creeping.
  if (shown < target - .05) {
    const next = shown + (target - shown) * (1 - Math.exp(-dt / CATCH_UP_MS));
    return Math.min(target, Math.max(next, shown));
  }
  const limit = Math.max(target, ceiling);
  if (shown >= limit) return shown;
  return shown + (limit - shown) * (1 - Math.exp(-dt / CREEP_MS));
}

function phaseMarkup(phases, fractions, state) {
  const active = currentPhase(fractions, phases);
  return phases.map(phase => {
    const done = state === "done" || clamp(fractions[phase.key]) >= 1;
    const status = done ? "done" : phase === active ? "active" : "pending";
    return `<li data-phase="${phase.key}" data-status="${status}"><i></i><span>${phase.label}</span></li>`;
  }).join("");
}

export function createLoadingScreen({
  root, bar, percent, step, list, phases = LOADING_PHASES, hideDelayMs = 700,
  animate = typeof requestAnimationFrame === "function", now = () => Date.now(),
} = {}) {
  const fractions = {};
  const notes = {};
  let state = "loading";
  let shown = 0;
  let lastTick = now();
  let frame = 0;

  function paint(value) {
    if (bar) bar.style.width = `${value}%`;
    if (percent) percent.textContent = `${Math.round(value)}%`;
    if (root) root.setAttribute("aria-valuenow", String(Math.round(value)));
  }

  function render() {
    if (root) root.dataset.state = state;
    if (list) list.innerHTML = phaseMarkup(phases, fractions, state);
    if (!animate) { shown = progressPercent(fractions, phases); paint(shown); }
    if (step && state !== "failed") {
      const phase = currentPhase(fractions, phases);
      const note = phase ? notes[phase.key] : "";
      step.textContent = phase ? (note ? `${phase.label} (${note})` : phase.label) : "초기화 완료";
    }
  }

  function tick() {
    frame = 0;
    const time = now();
    const dt = time - lastTick;
    lastTick = time;
    const target = state === "done" ? 100 : progressPercent(fractions, phases);
    shown = smoothedPercent(shown, target, state === "done" ? 100 : phaseCeiling(fractions, phases), dt);
    paint(shown);
    const settled = state === "done" && shown >= 99.5;
    if (settled) paint(100);
    if (state === "loading" || !settled) frame = requestAnimationFrame(tick);
  }

  render();
  paint(shown);
  if (animate) frame = requestAnimationFrame(tick);
  return {
    // fraction is the phase's own completion in [0, 1]; detail is an optional short note such as a
    // count, kept per phase so a report from another phase does not wipe it.
    report(key, fraction, detail = "") {
      if (state !== "loading" || !phases.some(phase => phase.key === key)) return;
      fractions[key] = clamp(fraction);
      notes[key] = detail;
      render();
    },
    // Start-up is complete: optional phases count as done, the bar runs out to 100 and the screen fades.
    finish() {
      if (state !== "loading") return;
      phases.forEach(phase => { fractions[phase.key] = 1; });
      state = "done";
      render();
      setTimeout(() => { if (root) root.hidden = true; }, hideDelayMs);
    },
    fail(message) {
      if (state === "done") return;
      state = "failed";
      if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      frame = 0;
      render();
      if (step) step.textContent = message || "초기화에 실패했습니다.";
    },
    get percent() { return progressPercent(fractions, phases); },
    get shown() { return shown; },
    get state() { return state; },
    get fractions() { return { ...fractions }; },
  };
}

function bindDocument(doc) {
  const root = doc.querySelector("#app-loading");
  if (!root) return createLoadingScreen({ animate: false });
  doc.querySelector("#app-loading-retry")?.addEventListener("click", () => doc.defaultView?.location.reload());
  return createLoadingScreen({
    root,
    bar: doc.querySelector("#app-loading-bar"),
    percent: doc.querySelector("#app-loading-percent"),
    step: doc.querySelector("#app-loading-step"),
    list: doc.querySelector("#app-loading-phases"),
  });
}

export const loading = typeof document === "undefined" ? createLoadingScreen({ animate: false }) : bindDocument(document);
