import test from 'node:test';
import assert from 'node:assert/strict';

const { createLoadingScreen, progressPercent, currentPhase, phaseCeiling, smoothedPercent, LOADING_PHASES } = await import('../../../user_application/web/scripts/loading.js');

function elements() {
  const root = { hidden: false, dataset: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  const bar = { style: {} };
  const percent = { textContent: '' };
  const step = { textContent: '' };
  const list = { innerHTML: '' };
  return { root, bar, percent, step, list };
}
const allDone = Object.fromEntries(LOADING_PHASES.map(phase => [phase.key, 1]));

test('the percentage is the weighted sum of phase fractions and the weights add up to 100', () => {
  assert.equal(LOADING_PHASES.reduce((sum, phase) => sum + phase.weight, 0), 100);
  assert.equal(progressPercent({}), 0);
  assert.equal(progressPercent({ bootstrap: 1 }), 6);
  assert.equal(progressPercent({ bootstrap: 1, library: 1, imagery: 1, catalog: 1, propagation: .5 }), 70);
  assert.equal(progressPercent({ propagation: 7, catalog: -2 }), 40, 'fractions are clamped to [0, 1]');
  assert.equal(progressPercent(allDone), 100);
});

test('the shown step is the first unfinished phase in start-up order', () => {
  assert.equal(currentPhase({}).key, 'bootstrap');
  assert.equal(currentPhase({ bootstrap: 1, library: 1 }).key, 'imagery');
  assert.equal(currentPhase({ bootstrap: 1, library: 1, imagery: 1, catalog: 1, propagation: .3, models: 1, telemetry: 1 }).key, 'propagation');
  assert.equal(currentPhase(allDone), null);
});

test('the creep ceiling stops one point short of completing the current phase', () => {
  assert.equal(phaseCeiling({}), 5, 'bootstrap weighs 6: creep may reach 5');
  assert.equal(phaseCeiling({ bootstrap: 1, library: 1, imagery: 1 }), 49, 'catalogue fetch: 30 done, may creep to 49');
  assert.equal(phaseCeiling({ bootstrap: 1, library: 1, imagery: 1, catalog: 1, propagation: .9 }), 89);
  assert.equal(phaseCeiling(allDone), 100);
  assert.ok(phaseCeiling({ bootstrap: 1, library: 1, imagery: 1, catalog: .99 }) >= progressPercent({ bootstrap: 1, library: 1, imagery: 1, catalog: .99 }), 'the ceiling is never below the estimate');
});

test('the shown value catches up quickly to a new estimate and creeps slowly toward the ceiling without reaching it', () => {
  let shown = 0;
  shown = smoothedPercent(shown, 30, 49, 16);
  assert.ok(shown > 1 && shown < 30, `one frame moves part of the way, ${shown}`);
  shown = smoothedPercent(shown, 30, 49, 2000);
  assert.ok(Math.abs(shown - 30) < .01, `two seconds settle on the estimate, ${shown}`);
  const afterTenSeconds = smoothedPercent(30, 30, 49, 10_000);
  assert.ok(afterTenSeconds > 40 && afterTenSeconds < 49, `a stalled phase still creeps, ${afterTenSeconds}`);
  assert.ok(smoothedPercent(30, 30, 49, 600_000) <= 49, 'creep never passes the ceiling, which sits below phase completion');
  assert.equal(smoothedPercent(48.9, 30, 49, 5000) >= 48.9, true, 'the shown value never moves backwards');
  assert.equal(smoothedPercent(70, 100, 100, 60_000), 100, 'finishing runs the bar out to 100');
});

test('reports move the bar, label and phase list; unknown phases are ignored', () => {
  const els = elements();
  const screen = createLoadingScreen({ ...els, hideDelayMs: 0, animate: false });
  assert.equal(els.root.dataset.state, 'loading');
  assert.equal(els.percent.textContent, '0%');
  assert.equal(els.step.textContent, '런타임 상태 수신');
  assert.match(els.list.innerHTML, /data-phase="bootstrap" data-status="active"/);
  assert.match(els.list.innerHTML, /data-phase="library" data-status="pending"/);
  screen.report('bootstrap', 1);
  screen.report('library', 1);
  screen.report('imagery', 1);
  screen.report('catalog', 1);
  screen.report('propagation', .25, '4,000 / 16,000');
  assert.equal(els.bar.style.width, '60%');
  assert.equal(els.percent.textContent, '60%');
  assert.equal(els.root.attributes['aria-valuenow'], '60');
  assert.equal(els.step.textContent, '궤도 요소 준비 (4,000 / 16,000)');
  assert.match(els.list.innerHTML, /data-phase="catalog" data-status="done"/);
  assert.match(els.list.innerHTML, /data-phase="propagation" data-status="active"/);
  screen.report('models', 1);
  assert.equal(els.step.textContent, '궤도 요소 준비 (4,000 / 16,000)', 'a report from another phase keeps the count');
  screen.report('nonsense', 1);
  assert.equal(screen.percent, 64);
});

test('finish forces the optional phases to 100 % and hides the screen after the fade', async () => {
  const els = elements();
  const screen = createLoadingScreen({ ...els, hideDelayMs: 0, animate: false });
  screen.report('bootstrap', 1);
  screen.report('catalog', .5);
  screen.finish();
  assert.equal(screen.state, 'done');
  assert.equal(els.percent.textContent, '100%');
  assert.equal(els.step.textContent, '초기화 완료');
  assert.equal(els.root.dataset.state, 'done');
  assert.ok(!/data-status="(active|pending)"/.test(els.list.innerHTML), 'every phase reads as done');
  assert.equal(els.root.hidden, false, 'the fade-out runs before the element is removed from layout');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(els.root.hidden, true);
  screen.report('telemetry', 0);
  assert.equal(screen.percent, 100, 'reports after completion, such as a catalogue refresh, are ignored');
});

test('a failed start-up keeps the screen with the error and no later report or finish hides it', () => {
  const els = elements();
  const screen = createLoadingScreen({ ...els, hideDelayMs: 0, animate: false });
  screen.report('bootstrap', 1);
  screen.fail('HTTP 503');
  assert.equal(screen.state, 'failed');
  assert.equal(els.root.dataset.state, 'failed');
  assert.equal(els.step.textContent, 'HTTP 503');
  screen.report('library', 1);
  screen.finish();
  assert.equal(screen.state, 'failed');
  assert.equal(els.root.hidden, false);
  assert.equal(els.step.textContent, 'HTTP 503');
});

test('the animated screen drives the bar from a frame loop that eases toward the estimate', async () => {
  const els = elements();
  const frames = [];
  let clock = 0;
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  try {
    const screen = createLoadingScreen({ ...els, hideDelayMs: 0, now: () => clock });
    screen.report('bootstrap', 1);
    screen.report('library', 1);
    screen.report('imagery', 1);
    assert.equal(screen.percent, 30);
    assert.equal(els.percent.textContent, '0%', 'the estimate is not painted directly');
    clock = 16; frames.shift()();
    const first = parseFloat(els.bar.style.width);
    assert.ok(first > 0 && first < 30, `the first frame starts the catch-up, ${first}`);
    clock = 3000; frames.shift()();
    assert.equal(els.percent.textContent, '30%');
    clock = 13_000; frames.shift()();
    const crept = parseFloat(els.bar.style.width);
    assert.ok(crept > 30 && crept < 49, `a stalled catalogue fetch still shows movement, ${crept}`);
    assert.ok(frames.length === 1, 'the loop keeps scheduling itself while loading');
  } finally {
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  }
});

test('a screen without elements is inert, so modules can import it outside a browser', () => {
  const screen = createLoadingScreen({ animate: false });
  screen.report('bootstrap', 1);
  screen.finish();
  assert.equal(screen.state, 'done');
  assert.equal(screen.percent, 100);
});
