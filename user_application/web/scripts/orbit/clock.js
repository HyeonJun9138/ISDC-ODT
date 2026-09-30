// A local analysis cursor, not the authoritative server SIM runtime.
//
// Every tab owns one clock. While a scenario plays, all clocks follow one shared time source (the
// scenario clock that mirrors the server SIM clock) so the tabs show the same instant; the local
// transport controls then act on that source instead of the local cursor. Following is engaged
// and released for every registered clock at once, which keeps the tab modules unchanged.
const registry = new Set();
let follower = null;

export class OrbitClock {
  constructor(wallNow = () => Date.now()) {
    this.wallNow = wallNow;
    this._speed = 1;
    this._running = true;
    this._isLive = true;
    this.anchorWall = wallNow();
    this.anchorTime = this.anchorWall;
    registry.add(this);
  }
  get following() { return follower !== null; }
  get speed() { return follower ? follower.speed : this._speed; }
  set speed(value) { this._speed = value; }
  get running() { return follower ? follower.running : this._running; }
  set running(value) { this._running = value; }
  get isLive() { return follower ? false : this._isLive; }
  set isLive(value) { this._isLive = value; }
  now() {
    if (follower) return new Date(follower.now());
    return new Date(this._isLive ? this.wallNow() : this.anchorTime + (this._running ? (this.wallNow() - this.anchorWall) * this._speed : 0));
  }
  anchor() {
    this.anchorTime = this.now().getTime();
    this.anchorWall = this.wallNow();
  }
  pause() {
    if (follower) { follower.pause?.(); return; }
    this.anchor(); this._running = false; this._isLive = false;
  }
  play() {
    if (follower) { follower.play?.(); return; }
    this.anchor(); this._running = true;
  }
  setSpeed(speed) {
    if (!Number.isFinite(speed) || speed <= 0 || speed > 600) throw new RangeError('배속은 0 초과 600 이하여야 합니다.');
    if (follower) { follower.setSpeed?.(speed); return; }
    this.anchor(); this._speed = speed; this._isLive = false;
  }
  step(seconds) {
    if (!Number.isFinite(seconds)) throw new RangeError('유효한 시간 간격이 필요합니다.');
    if (follower) { follower.step?.(seconds); return; }
    this.pause(); this.anchorTime += seconds * 1000;
  }
  seek(date) {
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new RangeError('유효한 UTC 시각이 필요합니다.');
    if (follower) { follower.seek?.(date); return; }
    this.pause(); this.anchorTime = date.getTime();
  }
  live() {
    if (follower) { follower.live?.(); return; }
    this.anchorWall = this.wallNow(); this.anchorTime = this.anchorWall;
    this._speed = 1; this._running = true; this._isLive = true;
  }
}

// source: { now(): ms, running, speed, pause(), play(), setSpeed(v), step(s), seek(date), live() }.
export function followAll(source) {
  if (!source || typeof source.now !== 'function') throw new TypeError('시계 추종 대상에는 now()가 필요합니다.');
  follower = source;
  return registry.size;
}

export function releaseAll() {
  follower = null;
  // Every clock resumes at the wall clock so no tab is left at a stale scenario instant.
  for (const clock of registry) clock.live();
}

export function followedSource() {
  return follower;
}

export function registeredClocks() {
  return registry.size;
}
