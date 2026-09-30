import test from 'node:test';
import assert from 'node:assert/strict';

async function inspectorModule() {
  const module = await import('../../../user_application/web/scripts/orbit/inspector.js').catch(() => null);
  assert.ok(module, '선택 위성 분석 모듈이 필요하다.');
  return module;
}

// 실제 HTML에 있는 텍스트/목록/링크 출력 경계만 대체한다. 전역 DOM은 쓰지 않는다.
function inspectorRoot() {
  const nodes = new Map([
    'selected-name', 'selected-id', 'selected-cospar', 'selected-model',
    'propagation-state', 'propagation-note', 'position-values', 'element-values',
    'element-note', 'satcat-state', 'identity-values', 'satcat-note',
    'source-values', 'profile-celestrak-link',
  ].map(id => [id, {
    textContent: '', innerHTML: '', dataset: {}, hidden: false,
    removeAttribute(name) { delete this[name]; },
  }]));
  return { querySelector: selector => nodes.get(selector.slice(1)) ?? null, get: id => nodes.get(id) };
}

const epoch = new Date('2026-09-07T00:00:00Z');
const realItem = Object.freeze({
  OBJECT_NAME: 'SAT A', NORAD_CAT_ID: 1, OBJECT_ID: '2026-001A',
  EPOCH: '2026-09-07T00:00:00', ORBIT_REGIME: 'LEO',
  MEAN_MOTION: 15, INCLINATION: 0, ECCENTRICITY: 0,
  RA_OF_ASC_NODE: 0, ARG_OF_PERICENTER: 0, MEAN_ANOMALY: 0,
  PERIOD_MINUTES: 96, SEMI_MAJOR_AXIS_KM: 6945.033,
  PERIGEE_KM: 566.90, APOGEE_KM: 566.90,
});
const catalog = Object.freeze({ source: 'celestrak-cache', fetched_at: '2026-09-06T23:30:00Z' });

function profile(id, name, fields = {}) {
  return {
    source: 'celestrak-satcat', fetched_at: '2026-09-07T00:00:00Z',
    catalog: {
      OBJECT_NAME: name, NORAD_CAT_ID: id, OBJECT_ID: `2026-00${id}A`,
      OBJECT_TYPE: 'PAY', OPS_STATUS_CODE: '+', OWNER: 'US',
      LAUNCH_DATE: '2026-01-01', LAUNCH_SITE: 'AFETR', DECAY_DATE: '',
      PERIOD: 96, INCLINATION: 0, APOGEE: 566.9, PERIGEE: 566.9,
      RCS: 0, DATA_STATUS_CODE: '', ORBIT_CENTER: 'EA', ORBIT_TYPE: 'ORB',
      ...fields,
    },
    gp: null,
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function row(root, list, label) {
  const html = root.get(list).innerHTML;
  const value = html.split(`<dt>${label}</dt><dd>`)[1]?.split('</dd>')[0];
  assert.notEqual(value, undefined, `${list}에 ${label} 값이 필요하다: ${html}`);
  return value;
}

test('GP 평균 요소의 실제 0은 유지하고 결측값과 파생 0은 미제공으로 표시한다', async () => {
  const { createInspector } = await inspectorModule();
  const root = inspectorRoot();
  const inspector = createInspector({ root });
  await inspector.select(realItem, catalog, epoch);
  assert.equal(root.get('selected-name').textContent, 'SAT A');
  assert.equal(root.get('selected-id').textContent, 'NORAD 1');
  assert.equal(root.get('selected-cospar').textContent, 'COSPAR 2026-001A');
  assert.equal(row(root, 'element-values', '경사각'), '0.000<small>°</small>');
  assert.equal(row(root, 'element-values', '이심률'), '0.0000000');
  assert.equal(row(root, 'element-values', '주기'), '96.00<small>min</small>');
  assert.equal(row(root, 'source-values', 'GP Epoch UTC'), '2026-09-07 00:00:00');
  assert.equal(row(root, 'source-values', '분석시각 − Epoch'), '0.0<small>h</small>');
  await inspector.select({ NORAD_CAT_ID: 2, INCLINATION: null, ECCENTRICITY: '',
    MEAN_MOTION: null, PERIOD_MINUTES: 0, PERIGEE_KM: 0, APOGEE_KM: 0 }, {}, epoch);
  for (const label of ['경사각', '이심률', '평균 운동', '주기', '근지점', '원지점']) {
    assert.equal(row(root, 'element-values', label), '미제공');
  }
  assert.equal(row(root, 'source-values', 'GP Epoch UTC'), '미제공');
  assert.equal(row(root, 'source-values', '분석시각 − Epoch'), '미제공');
});

test('이전 SATCAT 응답은 새 선택에 적용되지 않는다', async () => {
  const { createInspector } = await inspectorModule();
  const root = inspectorRoot(), first = deferred(), second = deferred();
  const inspector = createInspector({ root, loadProfile: id => id === 1 ? first.promise : second.promise });
  const firstSelection = inspector.select(realItem, catalog, epoch);
  const secondSelection = inspector.select({ ...realItem, NORAD_CAT_ID: 2, OBJECT_NAME: 'SAT B' }, catalog, epoch);
  second.resolve(profile(2, 'B 확인'));
  await secondSelection;
  first.resolve(profile(1, 'A 과거 응답'));
  await firstSelection;
  assert.equal(root.get('selected-name').textContent, 'B 확인');
  assert.equal(row(root, 'identity-values', '이름'), 'B 확인');
  assert.ok(!root.get('identity-values').innerHTML.includes('A 과거 응답'));
});

test('SATCAT은 벽시계 24시간 동안 재사용하고 분석 시각 변경은 만료시키지 않는다', async () => {
  const { createInspector } = await inspectorModule();
  const root = inspectorRoot();
  let wall = epoch.getTime(), requestCount = 0;
  const inspector = createInspector({ root, now: () => wall,
    loadProfile: async id => profile(id, `SATCAT ${++requestCount}`) });
  await inspector.select(realItem, catalog, epoch);
  assert.equal(root.get('selected-name').textContent, 'SATCAT 1');
  wall += 24 * 3600000 - 1;
  await inspector.select(realItem, catalog, new Date('2099-01-01T00:00:00Z'));
  assert.equal(root.get('selected-name').textContent, 'SATCAT 1');
  wall += 1;
  await inspector.select(realItem, catalog, epoch);
  assert.equal(root.get('selected-name').textContent, 'SATCAT 2');
  assert.equal(requestCount, 2);
});

test('DEMO는 같은 NORAD의 실제 SATCAT과 섞지 않고 GP 파생 필드를 숨긴다', async () => {
  const { createInspector } = await inspectorModule();
  const root = inspectorRoot();
  let requestCount = 0;
  const inspector = createInspector({ root, loadProfile: async id => {
    requestCount += 1;
    return profile(id, '실제 운용 위성');
  } });
  await inspector.select(realItem, catalog, epoch);
  await inspector.select(Object.freeze({ ...realItem, OBJECT_NAME: 'SAT A (DEMO)', demo: true,
    altitude_km: 420, inclination: 0, phase: 0,
    PERIOD_MINUTES: 0, APOGEE_KM: 0, PERIGEE_KM: 0 }),
  { source: 'demo-fallback', fetched_at: '2026-09-07T00:00:00Z' }, epoch);
  assert.equal(requestCount, 1);
  assert.equal(root.get('selected-name').textContent, 'SAT A (DEMO)');
  assert.match(root.get('selected-model').textContent, /DEMO/);
  assert.match(root.get('satcat-note').textContent, /실제 위성.*혼합하지/);
  assert.equal(root.get('profile-celestrak-link').hidden, true);
  for (const label of ['운용 상태 코드', '소유자 코드', '객체 유형', '발사일']) {
    assert.equal(row(root, 'identity-values', label), '미제공');
  }
  for (const label of ['주기', '근지점', '원지점', '평균 운동', '이심률']) {
    assert.equal(row(root, 'element-values', label), '미제공');
  }
  assert.equal(row(root, 'element-values', '모델 입력 고도'), '420.0<small>km</small>');
  assert.equal(row(root, 'element-values', '모델 입력 경사각'), '0.000<small>°</small>');
  assert.equal(row(root, 'source-values', 'GP Epoch UTC'), '미제공');
  assert.equal(row(root, 'source-values', 'SATCAT 수집 UTC'), '미제공');
});

test('현재 전파는 WGS84 위치와 TEME 속력을 표시하고 실패하면 이전 수치를 지운다', async () => {
  const { createInspector } = await inspectorModule();
  const root = inspectorRoot(), inspector = createInspector({ root });
  await inspector.select(realItem, catalog, epoch);
  inspector.update(Object.freeze({ latitude: 0, longitude: -127.123456, altitude: 420, velocity: 7.6 }), epoch);
  assert.equal(row(root, 'position-values', '위도'), '0.0000<small>°</small>');
  assert.equal(row(root, 'position-values', '경도'), '-127.1235<small>°</small>');
  assert.equal(row(root, 'position-values', '타원체 고도'), '420.0<small>km</small>');
  assert.equal(row(root, 'position-values', '속력 (TEME)'), '7.600<small>km/s</small>');
  assert.equal(row(root, 'position-values', '계산 UTC'), '2026-09-07 00:00:00');
  assert.equal(root.get('propagation-state').dataset.state, 'ok');
  assert.match(root.get('propagation-note').textContent, /WGS84/);
  assert.match(root.get('propagation-note').textContent, /실측.*아닙니다/);
  inspector.update(null, new Date('2026-09-07T01:00:00Z'));
  for (const label of ['위도', '경도', '타원체 고도', '속력 (TEME)']) {
    assert.equal(row(root, 'position-values', label), '미제공');
  }
  assert.equal(root.get('propagation-state').dataset.state, 'error');
  assert.equal(row(root, 'source-values', '분석시각 − Epoch'), '1.0<small>h</small>');
  inspector.update(null, epoch, { libraryAvailable: false });
  assert.match(root.get('propagation-note').textContent, /satellite\.js/);
});

test('유효하지 않은 전파 출력과 계산 시각은 전파 성공으로 표시하지 않는다', async () => {
  const { createInspector } = await inspectorModule();
  const root = inspectorRoot(), inspector = createInspector({ root });
  await inspector.select(realItem, catalog, epoch);
  const valid = { latitude: 0, longitude: 0, altitude: 420, velocity: 7.6 };
  for (const [position, date] of [
    [{ ...valid, latitude: null }, epoch], [{ ...valid, longitude: NaN }, epoch],
    [{ ...valid, latitude: 91 }, epoch], [{ ...valid, altitude: '' }, epoch],
    [{ ...valid, velocity: undefined }, epoch], [valid, new Date(NaN)],
  ]) {
    inspector.update(valid, epoch);
    inspector.update(position, date);
    assert.equal(root.get('propagation-state').dataset.state, 'error');
    for (const label of ['위도', '경도', '타원체 고도', '속력 (TEME)']) {
      assert.equal(row(root, 'position-values', label), '미제공');
    }
  }
});

test('DEMO의 속력을 TEME로 오인하지 않고 라이브러리 없이 계산한 모델로 표시한다', async () => {
  const { createInspector } = await inspectorModule();
  const root = inspectorRoot(), inspector = createInspector({ root });
  await inspector.select({ NORAD_CAT_ID: 1, demo: true, altitude_km: 420, inclination: 0, phase: 0 }, {}, epoch);
  inspector.update({ latitude: 0, longitude: 0, altitude: 420, velocity: 7.657 }, epoch, { libraryAvailable: false });
  assert.equal(root.get('propagation-state').dataset.state, 'ok');
  assert.match(root.get('propagation-note').textContent, /DEMO/);
  assert.equal(row(root, 'position-values', '속력 (모의 관성계)'), '7.657<small>km/s</small>');
  assert.ok(!root.get('position-values').innerHTML.includes('TEME'));
});

test('같은 NORAD의 뒤늦은 응답은 최신 선택과 캐시를 덮어쓰지 않는다', async () => {
  const { createInspector } = await inspectorModule();
  const root = inspectorRoot(), first = deferred(), second = deferred();
  let count = 0;
  const inspector = createInspector({ root, now: () => epoch.getTime(),
    loadProfile: () => ++count === 1 ? first.promise : second.promise });
  const oldSelection = inspector.select(realItem, catalog, epoch);
  const newSelection = inspector.select(realItem, catalog, epoch);
  second.resolve(profile(1, '새 응답'));
  await newSelection;
  first.resolve(profile(1, '과거 응답'));
  await oldSelection;
  await inspector.select(realItem, catalog, epoch);
  assert.equal(root.get('selected-name').textContent, '새 응답');
  assert.equal(count, 2);
});

test('서버 캐시에서 받은 SATCAT도 실제 수집 후 24시간에 재조회한다', async () => {
  const { createInspector } = await inspectorModule();
  const root = inspectorRoot();
  let wall = epoch.getTime() + 23 * 3600000, count = 0;
  const inspector = createInspector({ root, now: () => wall,
    loadProfile: async id => ({ ...profile(id, `응답 ${++count}`),
      fetched_at: count === 1 ? '2026-09-07T00:00:00Z' : '2026-09-08T00:00:00Z' }) });
  await inspector.select(realItem, catalog, epoch);
  wall += 3600000;
  await inspector.select(realItem, catalog, epoch);
  assert.equal(root.get('selected-name').textContent, '응답 2');
  assert.equal(count, 2);
});

test('다른 NORAD의 SATCAT 응답은 선택 위성의 메타데이터로 수용하지 않는다', async () => {
  const { createInspector } = await inspectorModule();
  const root = inspectorRoot();
  const inspector = createInspector({ root, loadProfile: async () => profile(2, '다른 위성') });
  await inspector.select(realItem, catalog, epoch);
  assert.equal(root.get('selected-name').textContent, 'SAT A');
  assert.equal(row(root, 'identity-values', '운용 상태 코드'), '미제공');
  assert.match(root.get('satcat-state').textContent, /미제공/);
});

test('SATCAT 실패와 GP fallback은 운용 상태를 추정하지 않으며 조회 이력을 구분한다', async () => {
  const { createInspector } = await inspectorModule();
  const root = inspectorRoot();
  const inspector = createInspector({ root, loadProfile: async () => { throw new Error('offline'); } });
  await inspector.select(realItem, catalog, epoch);
  assert.equal(row(root, 'identity-values', '운용 상태 코드'), '미제공');
  assert.match(root.get('satcat-note').textContent, /불러오지 못/);
  assert.equal(row(root, 'source-values', 'SATCAT 수집 UTC'), '미제공');
  const fallback = createInspector({ root, loadProfile: async () => ({
    source: 'gp-cache', fetched_at: '2026-09-07T00:00:00Z',
    catalog: { OBJECT_NAME: 'GP 사본', NORAD_CAT_ID: 1, OPS_STATUS_CODE: '', OWNER: '', OBJECT_TYPE: '' },
    gp: realItem, warning: 'SATCAT 미제공',
  }) });
  await fallback.select(realItem, catalog, epoch);
  assert.equal(row(root, 'identity-values', '운용 상태 코드'), '미제공');
  assert.equal(row(root, 'source-values', 'SATCAT 수집 UTC'), '미제공');
  assert.match(root.get('satcat-state').textContent, /미제공/);
});

test('외부 이름과 메타데이터는 안전한 텍스트이고 원문 링크는 고정 출처를 사용한다', async () => {
  const { createInspector } = await inspectorModule();
  const root = inspectorRoot();
  const inspector = createInspector({ root, loadProfile: async id => profile(id, '<img src=x onerror="bad()">', {
    OWNER: '<script>bad()</script>', RCS: null, OPS_STATUS_CODE: '', OBJECT_TYPE: '',
  }) });
  await inspector.select(realItem, catalog, epoch);
  assert.equal(root.get('selected-name').textContent, '<img src=x onerror="bad()">');
  assert.equal(row(root, 'identity-values', '이름'), '&lt;img src=x onerror=&quot;bad()&quot;&gt;');
  assert.equal(row(root, 'identity-values', '소유자 코드'), '&lt;script&gt;bad()&lt;/script&gt;');
  assert.equal(row(root, 'identity-values', '객체 유형'), '미제공');
  assert.equal(row(root, 'identity-values', '레이더 단면적'), '미제공');
  assert.equal(root.get('profile-celestrak-link').href, 'https://celestrak.org/satcat/records.php?CATNR=1&FORMAT=JSON-PRETTY');
});

test('알려진 SATCAT 코드는 한국어 설명과 원문을 병기하고 모르는 코드는 추정하지 않는다', async () => {
  const { createInspector } = await inspectorModule();
  const root = inspectorRoot();
  const cases = [
    ['OPS_STATUS_CODE', '운용 상태 코드', '+', '운용 중 (+)'],
    ['OPS_STATUS_CODE', '운용 상태 코드', '-', '비운용 (-)'],
    ['OPS_STATUS_CODE', '운용 상태 코드', 'P', '부분 운용 (P)'],
    ['OPS_STATUS_CODE', '운용 상태 코드', 'B', '예비 (B)'],
    ['OPS_STATUS_CODE', '운용 상태 코드', 'S', '대기 (S)'],
    ['OPS_STATUS_CODE', '운용 상태 코드', 'X', '연장 임무 (X)'],
    ['OPS_STATUS_CODE', '운용 상태 코드', 'D', '궤도 이탈 (D)'],
    ['OPS_STATUS_CODE', '운용 상태 코드', '?', '미확인 (?)'],
    ['OBJECT_TYPE', '객체 유형', 'PAY', '탑재체 (PAY)'],
    ['OBJECT_TYPE', '객체 유형', 'RB', '로켓 본체 (RB)'],
    ['OBJECT_TYPE', '객체 유형', 'R/B', '로켓 본체 (R/B)'],
    ['OBJECT_TYPE', '객체 유형', 'DEB', '파편 (DEB)'],
    ['OBJECT_TYPE', '객체 유형', 'UNK', '미확인 (UNK)'],
    ['OWNER', '소유자 코드', 'US', '미국 (US)'],
    ['OWNER', '소유자 코드', 'CIS', '러시아/CIS (CIS)'],
    ['OWNER', '소유자 코드', 'PRC', '중국 (PRC)'],
    ['OWNER', '소유자 코드', 'KOR', '한국 (KOR)'],
    ['OWNER', '소유자 코드', 'JPN', '일본 (JPN)'],
    ['OWNER', '소유자 코드', 'IND', '인도 (IND)'],
    ['OWNER', '소유자 코드', 'ESA', '유럽우주국 (ESA)'],
    ['OWNER', '소유자 코드', 'UK', '영국 (UK)'],
    ['OWNER', '소유자 코드', 'FR', '프랑스 (FR)'],
    ['OWNER', '소유자 코드', 'UNKNOWN_OWNER', 'UNKNOWN_OWNER'],
    ['OBJECT_TYPE', '객체 유형', 'UNKNOWN_TYPE', 'UNKNOWN_TYPE'],
    ['OPS_STATUS_CODE', '운용 상태 코드', 'UNKNOWN_STATUS', 'UNKNOWN_STATUS'],
    ['OPS_STATUS_CODE', '운용 상태 코드', '', '미제공'],
    ['OBJECT_TYPE', '객체 유형', null, '미제공'],
    ['OWNER', '소유자 코드', undefined, '미제공'],
  ];
  for (const [field, label, code, expected] of cases) {
    const inspector = createInspector({ root, loadProfile: async id => profile(id, 'SAT A', { [field]: code }) });
    await inspector.select(realItem, catalog, epoch);
    assert.equal(row(root, 'identity-values', label), expected);
  }
});

test('출처의 Epoch 차이는 현재 벽시계가 아니라 분석 시각을 기준으로 부호까지 표시한다', async () => {
  const { createInspector } = await inspectorModule();
  const root = inspectorRoot();
  const inspector = createInspector({ root, now: () => new Date('2099-01-01T00:00:00Z').getTime() });
  await inspector.select(realItem, catalog, new Date('2026-09-06T22:00:00Z'));
  assert.equal(row(root, 'source-values', '분석시각 − Epoch'), '-2.0<small>h</small>');
  inspector.update(null, new Date('2026-09-07T02:00:00Z'));
  assert.equal(row(root, 'source-values', '분석시각 − Epoch'), '2.0<small>h</small>');
});

test('GP Epoch와 분석 시각의 차이가 양방향 120시간을 넘을 때만 정확도 경고를 표시한다', async () => {
  const { createInspector } = await inspectorModule();
  const root = inspectorRoot(), inspector = createInspector({ root });
  const position = { latitude: 0, longitude: 0, altitude: 420, velocity: 7.6 };
  await inspector.select(realItem, catalog, new Date('2026-09-12T01:00:00Z'));
  assert.match(root.get('propagation-note').textContent, /120 h/);
  for (const [date, warning] of [
    ['2026-09-12T00:00:00.001Z', true], ['2026-09-01T23:59:59.999Z', true],
    ['2026-09-12T00:00:00.000Z', false], ['2026-09-02T00:00:00.000Z', false],
    ['2026-09-07T00:00:00.000Z', false],
  ]) {
    inspector.update(position, new Date(date));
    assert.equal(root.get('propagation-state').dataset.state, 'ok');
    assert.equal(root.get('propagation-note').textContent.includes('120 h'), warning);
    if (warning) assert.match(root.get('propagation-note').textContent, /정확도.*보증.*않/);
  }
  inspector.update(null, new Date('2026-09-12T01:00:00Z'));
  assert.match(root.get('propagation-note').textContent, /120 h/);
});

test('Epoch가 없거나 DEMO이면 실제 GP의 시간 차이 경고를 만들지 않는다', async () => {
  const { createInspector } = await inspectorModule();
  const root = inspectorRoot(), inspector = createInspector({ root });
  const farFuture = new Date('2099-01-01T00:00:00Z');
  for (const item of [
    { ...realItem, EPOCH: null },
    { ...realItem, demo: true, altitude_km: 420, inclination: 0, phase: 0 },
  ]) {
    await inspector.select(item, catalog, farFuture);
    inspector.update(null, farFuture);
    assert.ok(!root.get('propagation-note').textContent.includes('120 h'));
    assert.equal(row(root, 'source-values', '분석시각 − Epoch'), '미제공');
  }
  inspector.clear();
  assert.ok(!root.get('propagation-note').textContent.includes('120 h'));
});

test('clear는 지연된 응답과 계산값을 제거하며 출처 갱신은 선택을 유지한다', async () => {
  const { createInspector } = await inspectorModule();
  const root = inspectorRoot(), pending = deferred();
  const inspector = createInspector({ root, loadProfile: () => pending.promise });
  const selection = inspector.select(realItem, catalog, epoch);
  inspector.update({ latitude: 10, longitude: 20, altitude: 300, velocity: 7 }, epoch);
  inspector.refreshSource({ source: 'celestrak-stale', fetched_at: '2026-09-05T12:30:00Z' });
  assert.equal(root.get('selected-name').textContent, 'SAT A');
  assert.match(row(root, 'source-values', 'GP 출처'), /오래된/);
  assert.equal(row(root, 'source-values', 'GP 수집 UTC'), '2026-09-05 12:30:00');
  inspector.clear();
  pending.resolve(profile(1, '오래된 위성'));
  await selection;
  assert.match(root.get('selected-name').textContent, /선택/);
  assert.equal(root.get('identity-values').innerHTML, '');
  assert.equal(root.get('element-values').innerHTML, '');
  assert.equal(root.get('position-values').innerHTML, '');
  assert.equal(root.get('source-values').innerHTML, '');
  assert.equal(root.get('profile-celestrak-link').hidden, true);
});
