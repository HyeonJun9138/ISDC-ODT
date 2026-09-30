// The scenario clock: the server SIM clock (run start UTC plus elapsed seconds) interpolated between
// telemetry frames. While a scenario is loaded every tab clock follows it (orbit/clock.js), so the
// transport controls of any tab act on the runtime through the callbacks the player supplies.
import { followAll, releaseAll, followedSource } from "../orbit/clock.js?v=20260908-scenario1";

export function createScenarioClock({ runtime = () => null, receivedAt = () => null, wallNow = () => Date.now(), control = {} } = {}) {
  function elapsed() {
    const status = runtime();
    if (!status) return 0;
    const base = Number(status.elapsed_seconds) || 0;
    const stamp = receivedAt();
    if (!status.running || stamp == null) return base;
    return base + Math.max(0, (wallNow() - stamp) / 1000) * (Number(status.speed) || 1);
  }
  function startMs() {
    const status = runtime();
    const parsed = status?.started_at ? Date.parse(status.started_at) : NaN;
    return Number.isFinite(parsed) ? parsed : wallNow();
  }
  const source = {
    elapsed,
    startMs,
    now: () => startMs() + elapsed() * 1000,
    engage() { followAll(source); },
    disengage() { if (followedSource() === source) releaseAll(); },
    get engaged() { return followedSource() === source; },
    get running() { return runtime()?.running === true; },
    get speed() { return Number(runtime()?.speed) || 1; },
    pause: () => control.pause?.(),
    play: () => control.play?.(),
    setSpeed: speed => control.setSpeed?.(speed),
    // The runtime only moves forward: a backward step or seek is refused, a forward one advances the clock.
    step: seconds => { if (seconds > 0) control.advance?.(seconds); else control.refuse?.("시나리오 시계는 되감을 수 없습니다."); },
    seek: date => { const delta = (date.getTime() - (startMs() + elapsed() * 1000)) / 1000; if (delta > 0) control.advance?.(delta); else control.refuse?.("시나리오 시계는 되감을 수 없습니다."); },
    live: () => control.refuse?.("시나리오 재생 중에는 시계가 서버 SIM 시각을 따릅니다."),
  };
  return source;
}
