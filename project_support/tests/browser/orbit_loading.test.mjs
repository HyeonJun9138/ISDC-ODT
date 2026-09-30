import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../../user_application/web/scripts/tabs/orbit.js', import.meta.url), 'utf8');
const catalogUrl = new URL('../../../user_application/web/scripts/orbit/catalog.js', import.meta.url).href;
const analysisTime = new Date('2026-09-07T12:00:00Z');
const oldPassTable = '<tr><td>이전 GP의 관측창</td></tr>';
const oldItem = { NORAD_CAT_ID: 1, OBJECT_NAME: 'SAT A', EPOCH: '2026-09-01T00:00:00Z', MEAN_MOTION: 15, ORBIT_REGIME: 'LEO' };
const newItem = { ...oldItem, EPOCH: '2026-09-07T00:00:00Z', MEAN_MOTION: 15.1 };
const freshCatalog = { group: 'active', source: 'celestrak-live', fetched_at: '2026-09-07T11:59:00Z', items: [newItem], count: 1, total: 1, filtered_total: 1, truncated: false };
let fixtureNumber = 0;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

async function loadingFixture(t) {
  const firstRequest = deferred(), secondRequest = deferred(), rendering = deferred();
  const timers = new Map(), nodes = new Map(), tasks = [];
  let timerId = 0, requestCount = 0, renderingFinished = false;
  const previousDocument = globalThis.document;
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: ({ '#ground-station': 'SEOUL', '#satellite-group': 'active', '#orbit-regime': 'all', '#elevation-mask': '5' })[selector] || '',
      innerHTML: selector === '#pass-list' ? oldPassTable : '', textContent: '',
      classList: { toggle() {} }, setAttribute() {}, replaceChildren() { this.innerHTML = ''; },
    });
    return nodes.get(selector);
  };
  globalThis.document = { querySelector: node, querySelectorAll: () => [] };

  // API 대기와 Cesium의 비동기 카탈로그 조립만 통제한다. 실제 loadSatellites,
  // schedulePasses, tick과 패스 HTML 생성은 수정 없이 실행한다.
  const inspector = { select() {}, clear() {}, update() {} };
  const globe = {
    currentDate: analysisTime, selectedId: '1', satelliteLib: {}, viewer: null, positions: new Map(),
    setVisibleSatellites() {}, setSdcMode() {}, update() {},
    async setSatellites(items) {
      this.items = items;
      await rendering.promise;
      renderingFinished = true;
      this.positions.set('1', this.positionAt('1'));
      module.selectSatellite(items[0], this.positionAt('1'), '1');
    },
    positionAt() { return renderingFinished ? { latitude: 0, longitude: 0, altitude: 500, velocity: 7.6 } : null; },
    predictPasses(id, stationKey) {
      assert.equal(id, '1');
      assert.equal(stationKey, 'SEOUL');
      assert.equal(this.items[0].EPOCH, '2026-09-07T00:00:00Z');
      return [{ aos: new Date('2026-09-07T12:10:00Z'), los: new Date('2026-09-07T12:20:00Z'), maxElevation: 47.5, durationSeconds: 600, inProgress: false, truncated: false }];
    },
  };
  const fixture = {
    api: { satellites: () => ++requestCount === 1 ? firstRequest.promise : secondRequest.promise },
    GROUND_STATIONS: { SEOUL: { latitude: 0, longitude: 0 } },
    lookAnglesAt: () => null, emit() {}, on() {}, setState() {},
    // No deployed node-tab satellites in this fixture: the GP snapshot is the whole catalog.
    constellation: { deployedItems: () => [] },
    // The loading screen only observes progress; it is not part of the race under test.
    loading: { report() {}, finish() {}, fail() {} },
    store: { activeTab: 'orbit', livePositions: new Map(), selectedSatellite: '1' },
    globe, inspector, list: { setItems() {}, select() {}, paint() {} },
    clock: { now: () => new Date(analysisTime), running: false, isLive: false, speed: 1 },
    oldItem,
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const key = `__orbitLoadingFixture${++fixtureNumber}`;
  globalThis[key] = fixture;
  // 절대 /static 경로와 DOM 조립 경계를 대체한다. 시험 전용 상태 설정/관찰은
  // 메모리로 읽은 모듈에만 붙이며 생산 코드에 시험 API를 추가하지 않는다.
  const instrumented = `
    import { displayNumber, utcLabel, escapeMarkup as esc, selectCatalog } from ${JSON.stringify(catalogUrl)};
    const fixture = globalThis[${JSON.stringify(key)}];
    const { api, GROUND_STATIONS, lookAnglesAt, emit, on, setState, store, setTimeout, clearTimeout, constellation, loading } = fixture;
    ${source.replace(/^import .*;\r?\n/gm, '')}
    globe = fixture.globe; inspector = fixture.inspector; list = fixture.list; clock = fixture.clock;
    selectedId = '1'; catalogItems = [fixture.oldItem]; itemById = new Map([['1', fixture.oldItem]]);
    catalog = { source: 'celestrak-cache', items: catalogItems }; ready = true;
    passBasis = clock.now().getTime();
    export { selectSatellite, tick };
    export function loadingState() { return { ready, passBasis, epoch: catalogItems[0]?.EPOCH }; }
  `;
  const module = await import(`data:text/javascript;base64,${Buffer.from(instrumented).toString('base64')}`);
  t.after(async () => {
    // 실패한 assertion에서도 미완료 Promise나 전역 DOM이 다음 시험에 새지 않는다.
    firstRequest.resolve(freshCatalog);
    secondRequest.reject(new Error('fixture cleanup'));
    secondRequest.promise.catch(() => {});
    rendering.resolve();
    await Promise.allSettled(tasks);
    timers.clear();
    delete globalThis[key];
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  return {
    module, node, firstRequest, secondRequest, rendering,
    load() { const task = module.loadSatellites(); tasks.push(task); return task; },
    runTimers() {
      for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
    },
  };
}

test('새 GP 스냅샷을 적용하면 렌더링 완료 전에도 이전 패스 결과를 무효화한다', async t => {
  const f = await loadingFixture(t);
  f.load(); f.firstRequest.resolve(freshCatalog);
  await flush();
  assert.equal(f.module.loadingState().epoch, '2026-09-07T00:00:00Z');
  assert.notEqual(f.node('#pass-list').innerHTML, oldPassTable, '새 GP의 전파값과 이전 GP의 패스 표를 함께 표시하면 안 된다.');
  assert.equal(f.module.loadingState().passBasis, null, '이전 계산 기준을 유지하면 정지 시계에서 자동 재계산되지 않는다.');
});

test('최신 요청 실패는 앞선 스냅샷의 진행 중 렌더링을 기다린 뒤 패스를 재계산한다', async t => {
  const f = await loadingFixture(t);
  const first = f.load(); f.firstRequest.resolve(freshCatalog);
  await flush();
  const second = f.load(); f.secondRequest.reject(new Error('latest request fails'));
  await flush();
  assert.equal(f.module.loadingState().ready, false, '아직 조립 중인 renderer를 준비 완료 상태로 되돌리면 안 된다.');
  f.rendering.resolve();
  await Promise.all([first, second]);
  f.runTimers();
  assert.equal(f.module.loadingState().ready, true);
  assert.match(f.node('#pass-list').innerHTML, /09-07 12:10:00/, '적용된 새 GP로 관측창을 다시 표시해야 한다.');
  assert.doesNotMatch(f.node('#pass-list').innerHTML, /이전 GP/);
});

test('앞선 렌더링이 먼저 완료되어도 최신 요청 실패 후 정지 시계의 패스 표를 갱신한다', async t => {
  const f = await loadingFixture(t);
  const first = f.load(); f.firstRequest.resolve(freshCatalog);
  await flush();
  const second = f.load();
  f.rendering.resolve(); await first;
  f.secondRequest.reject(new Error('latest request fails')); await second;
  f.module.tick(); f.runTimers();
  assert.equal(f.module.loadingState().ready, true);
  assert.equal(f.module.loadingState().epoch, '2026-09-07T00:00:00Z');
  assert.match(f.node('#pass-list').innerHTML, /09-07 12:10:00/, '분석 시각이 정지돼 있어도 GP 변경에 맞춰 재계산해야 한다.');
  assert.doesNotMatch(f.node('#pass-list').innerHTML, /이전 GP/);
});

test('경합 복구는 이전 DEMO 출처 칩도 적용된 실제 GP 출처와 개수로 갱신한다', async t => {
  const f = await loadingFixture(t);
  f.node('#source-chip').textContent = 'DEMO / 모의 궤도';
  const first = f.load(); f.firstRequest.resolve(freshCatalog);
  await flush();
  const second = f.load();
  f.rendering.resolve(); await first;
  f.secondRequest.reject(new Error('latest request fails')); await second;
  assert.equal(f.node('#source-chip').textContent, '1 objects / GP snapshot');
  assert.match(f.node('#catalog-source').textContent, /CelesTrak GP/);
});
