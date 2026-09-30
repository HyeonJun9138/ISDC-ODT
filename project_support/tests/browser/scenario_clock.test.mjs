import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStatic } from './load_static.mjs';

// Both modules load through the static loader so the versioned import inside scenario/clock.js
// resolves to the same clock registry the test inspects, as it does in the browser.
const { OrbitClock, followAll, releaseAll, followedSource, registeredClocks } = await loadStatic('user_application/web/scripts/orbit/clock.js');
const { createScenarioClock } = await loadStatic('user_application/web/scripts/scenario/clock.js');

test('every registered clock follows the scenario source and returns to the wall clock on release', () => {
  let wall = 1_000_000;
  const a = new OrbitClock(() => wall);
  const b = new OrbitClock(() => wall);
  b.pause();
  assert.ok(registeredClocks() >= 2);
  const calls = [];
  const source = { now: () => 5_000_000, running: true, speed: 5, pause: () => calls.push('pause'), play: () => calls.push('play'), setSpeed: value => calls.push(`speed:${value}`), step: seconds => calls.push(`step:${seconds}`) };
  followAll(source);
  assert.equal(followedSource(), source);
  assert.equal(a.now().getTime(), 5_000_000);
  assert.equal(b.now().getTime(), 5_000_000);
  assert.equal(a.isLive, false);
  assert.equal(b.running, true, 'the source decides whether time runs while following');
  assert.equal(a.speed, 5);
  a.pause(); b.setSpeed(10); a.step(60);
  assert.deepEqual(calls, ['pause', 'speed:10', 'step:60']);
  releaseAll();
  assert.equal(followedSource(), null);
  assert.equal(a.now().getTime(), wall);
  assert.equal(b.isLive, true, 'released clocks resume live time');
  assert.throws(() => followAll({}), /now/);
});

test('the scenario clock interpolates the server SIM clock and refuses to move backwards', () => {
  let runtime = { started_at: '2026-09-08T00:00:00Z', elapsed_seconds: 100, running: true, speed: 10 };
  let received = 10_000;
  let wall = 12_000;
  const control = { advance: [], refused: [], pause: 0 };
  const clock = createScenarioClock({ runtime: () => runtime, receivedAt: () => received, wallNow: () => wall,
    control: { advance: seconds => control.advance.push(seconds), refuse: message => control.refused.push(message), pause: () => { control.pause += 1; } } });
  assert.equal(clock.elapsed(), 120, '2 s of wall time at ×10 add 20 s');
  assert.equal(clock.now(), Date.parse('2026-09-08T00:02:00Z'));
  runtime = { ...runtime, running: false };
  assert.equal(clock.elapsed(), 100, 'a paused runtime does not interpolate');
  clock.step(30); clock.step(-30); clock.live();
  assert.deepEqual(control.advance, [30]);
  assert.equal(control.refused.length, 2);
  clock.seek(new Date(Date.parse('2026-09-08T00:05:00Z')));
  assert.equal(Math.round(control.advance[1]), 200);
  clock.pause();
  assert.equal(control.pause, 1);
  const tab = new OrbitClock(() => wall);
  clock.engage();
  assert.equal(clock.engaged, true);
  assert.equal(tab.now().getTime(), clock.now());
  clock.disengage();
  assert.equal(clock.engaged, false);
  assert.equal(followedSource(), null);
});
