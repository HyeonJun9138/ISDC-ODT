import { finiteNumber, displayNumber, utcMillis, utcLabel, epochAgeHours, escapeMarkup } from './catalog.js';

const MISSING = '미제공';
const SATCAT_TTL_MS = 24 * 60 * 60 * 1000;
const GP_SOURCES = {
  'celestrak-live': 'CelesTrak GP (수집)',
  'celestrak-cache': 'CelesTrak GP (캐시)',
  'celestrak-stale': 'CelesTrak GP (오래된 스냅샷)',
  'upstream-unavailable': '미제공 (상류 접속 불가)',
};
const OPS_LABELS = {
  '+': '운용 중', '-': '비운용', P: '부분 운용', B: '예비',
  S: '대기', X: '연장 임무', D: '궤도 이탈', '?': '미확인',
};
const OBJECT_LABELS = {
  PAY: '탑재체', RB: '로켓 본체', 'R/B': '로켓 본체', DEB: '파편', UNK: '미확인',
};
const OWNER_LABELS = {
  US: '미국', CIS: '러시아/CIS', PRC: '중국', KOR: '한국', JPN: '일본',
  IND: '인도', ESA: '유럽우주국', UK: '영국', FR: '프랑스',
};

function textValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : MISSING;
}

function codeLabel(value, labels) {
  const raw = textValue(value);
  const code = raw.toUpperCase();
  return Object.hasOwn(labels, code) ? `${labels[code]} (${raw})` : raw;
}

function numberValue(value, digits, unit = '') {
  return finiteNumber(value) === null ? [MISSING] : [displayNumber(value, digits), unit];
}

function dateValue(value) {
  const label = utcLabel(value);
  return label === '—' ? MISSING : label;
}

// 분석 시각은 전달받은 사본만 사용한다. 캐시 수명은 별도의 벽시계로 판단한다.
export function createInspector({ root, loadProfile, now = () => Date.now() }) {
  const cache = new Map();
  let selected = null;
  let source = {};
  let profile = null;
  let analysisDate = null;
  let selectionToken = 0;

  const node = id => root?.querySelector(`#${id}`);
  const setText = (id, value) => { const target = node(id); if (target) target.textContent = value; };
  const rows = (id, values) => {
    const target = node(id);
    if (!target) return;
    target.innerHTML = values.map(([label, value, unit]) => `<div><dt>${escapeMarkup(label)}</dt><dd>${escapeMarkup(value)}${unit ? `<small>${escapeMarkup(unit)}</small>` : ''}</dd></div>`).join('');
  };
  const isDemo = () => selected?.demo === true;
  // A user-placed node from the node tab: explicit Kepler + J2 definition, no GP and no SATCAT.
  const isNode = () => selected?.dynamics === 'kepler_j2';
  const satcat = () => !isDemo() && !isNode() && profile?.source === 'celestrak-satcat' ? profile.catalog : {};

  function renderIdentity() {
    const record = satcat();
    const name = textValue(record.OBJECT_NAME || selected.OBJECT_NAME);
    const id = textValue(selected.NORAD_CAT_ID);
    const cospar = isDemo() ? MISSING : textValue(record.OBJECT_ID || selected.OBJECT_ID);
    setText('selected-name', name);
    setText('selected-id', isDemo() ? `모델 참조 ID ${id}` : isNode() ? `노드 참조 ${id}` : `NORAD ${id}`);
    setText('selected-cospar', isNode() ? `노드 ${textValue(selected.OBJECT_ID)}` : `COSPAR ${cospar}`);
    setText('selected-model', isDemo() ? 'DEMO / 원형 2체 모델' : isNode() ? '내 위성 / Kepler + J2' : 'GP / SGP4');
    rows('identity-values', [
      ['이름', name],
      [isDemo() ? '모델 참조 ID' : isNode() ? '노드 참조' : 'NORAD', id],
      [isNode() ? '노드 ID' : 'COSPAR', isNode() ? textValue(selected.OBJECT_ID) : cospar],
      ['객체 유형', codeLabel(record.OBJECT_TYPE, OBJECT_LABELS)],
      ['운용 상태 코드', codeLabel(record.OPS_STATUS_CODE, OPS_LABELS)],
      ['소유자 코드', codeLabel(record.OWNER, OWNER_LABELS)],
      ['발사일', textValue(record.LAUNCH_DATE)],
      ['발사장 코드', textValue(record.LAUNCH_SITE)],
      ['궤도 이탈일', textValue(record.DECAY_DATE)],
      ['레이더 단면적', ...numberValue(record.RCS, 3, 'm²')],
    ]);
  }

  function renderElements() {
    const gp = isDemo() ? {} : selected;
    const meanMotion = finiteNumber(gp.MEAN_MOTION);
    const eccentricity = finiteNumber(gp.ECCENTRICITY);
    const hasPeriod = meanMotion !== null && meanMotion > 0;
    const hasShape = hasPeriod && eccentricity !== null && eccentricity >= 0 && eccentricity < 1;
    const elements = [
      ['궤도군', isDemo() ? MISSING : textValue(gp.ORBIT_REGIME)],
      ['경사각', ...numberValue(gp.INCLINATION, 3, '°')],
      ['이심률', ...numberValue(gp.ECCENTRICITY, 7)],
      ['승교점 적경', ...numberValue(gp.RA_OF_ASC_NODE, 3, '°')],
      ['근지점 편각', ...numberValue(gp.ARG_OF_PERICENTER, 3, '°')],
      ['평균 근점 이각', ...numberValue(gp.MEAN_ANOMALY, 3, '°')],
      ['평균 운동', ...numberValue(hasPeriod ? meanMotion : null, 8, 'rev/day')],
      ['주기', ...numberValue(hasPeriod ? gp.PERIOD_MINUTES : null, 2, 'min')],
      ['궤도 장반경', ...numberValue(hasPeriod ? gp.SEMI_MAJOR_AXIS_KM : null, 2, 'km')],
      ['근지점', ...numberValue(hasShape ? gp.PERIGEE_KM : null, 1, 'km')],
      ['원지점', ...numberValue(hasShape ? gp.APOGEE_KM : null, 1, 'km')],
    ];
    if (isDemo()) elements.push(
      ['모델 입력 고도', ...numberValue(selected.altitude_km, 1, 'km')],
      ['모델 입력 경사각', ...numberValue(selected.inclination, 3, '°')],
    );
    rows('element-values', elements);
    setText('element-note', isDemo()
      ? 'DEMO에는 GP 평균 요소가 없습니다. 입력 고도는 궤도 반지름에서 지구 적도 반지름을 뺀 값으로, WGS84 타원체 고도와 다를 수 있습니다.'
      : isNode()
        ? '노드 탭에서 정의한 Kepler 요소이며 정의 시각 기준값입니다. 승교점과 근지점은 J2 섭동으로 시간에 따라 이동합니다.'
        : '근지점과 원지점, 주기는 GP 평균 운동에서 유도한 근사값입니다. 순간 궤도요소가 아닙니다.');
  }

  function analysisEpochHours() {
    return !selected || isDemo() || !(analysisDate instanceof Date)
      ? null : finiteNumber(epochAgeHours(selected, analysisDate.getTime()));
  }

  function renderSource() {
    if (!selected) return;
    const age = analysisEpochHours();
    const hasSatcat = !isDemo() && profile?.source === 'celestrak-satcat';
    rows('source-values', [
      ['GP 출처', isDemo() ? 'DEMO (GP 아님)' : isNode() ? '노드 탭 정의 (GP 아님)' : GP_SOURCES[source.source] || textValue(source.source)],
      [isDemo() ? '데이터 생성 UTC' : isNode() ? '카탈로그 적용 UTC' : 'GP 수집 UTC', dateValue(source.fetched_at)],
      [isNode() ? '정의 시각 UTC' : 'GP Epoch UTC', isDemo() ? MISSING : dateValue(selected.EPOCH)],
      ['분석시각 − Epoch', ...numberValue(age, 1, 'h')],
      ['SATCAT 출처', hasSatcat ? 'CelesTrak SATCAT' : MISSING],
      ['SATCAT 수집 UTC', hasSatcat ? dateValue(profile.fetched_at) : MISSING],
    ]);
  }

  function renderPosition(position, date) {
    analysisDate = date instanceof Date ? new Date(date.getTime()) : null;
    rows('position-values', [
      ['위도', ...numberValue(position?.latitude, 4, '°')],
      ['경도', ...numberValue(position?.longitude, 4, '°')],
      ['타원체 고도', ...numberValue(position?.altitude, 1, 'km')],
      [isDemo() ? '속력 (모의 관성계)' : '속력 (TEME)', ...numberValue(position?.velocity, 3, 'km/s')],
      ['계산 UTC', dateValue(analysisDate)],
    ]);
    renderSource();
  }

  function setPropagation(state, label, note) {
    setText('propagation-state', label);
    if (node('propagation-state')) node('propagation-state').dataset.state = state;
    const age = analysisEpochHours();
    const warning = age !== null && Math.abs(age) > 120
      ? ' Epoch와의 시간 차가 120 h를 넘습니다. 전파 정확도는 보증되지 않습니다.' : '';
    setText('propagation-note', note + warning);
  }

  function update(position, date, { libraryAvailable = true } = {}) {
    if (!selected) return;
    const valid = position && date instanceof Date && Number.isFinite(date.getTime())
      && [position.latitude, position.longitude, position.altitude, position.velocity].every(Number.isFinite)
      && Math.abs(position.latitude) <= 90 && Math.abs(position.longitude) <= 180
      && position.altitude >= 0 && position.velocity >= 0;
    renderPosition(valid ? position : null, date);
    if (valid) {
      setPropagation('ok', isDemo() ? 'DEMO 계산' : isNode() ? '노드 계산' : '전파 완료', isDemo()
        ? '원형 2체 운동과 지구 자전을 반영한 DEMO 계산입니다. 위치는 WGS84이며 속력은 모의 관성계 값입니다. 실제 GP나 실측 텔레메트리가 아닙니다.'
        : isNode()
          ? '노드 탭에서 정의한 Kepler 궤도에 J2 영년 섭동을 적용한 계산입니다. 위치는 WGS84이며 속력은 관성계 값입니다. 실제 GP나 실측 텔레메트리가 아닙니다.'
          : 'GP를 SGP4로 전파한 계산입니다. 위치는 WGS84이며 속력은 TEME 속도벡터의 크기입니다. 지상 속력이나 실측 텔레메트리가 아닙니다.');
    } else {
      setPropagation('error', '미제공', isDemo()
        ? 'DEMO 모델 입력 또는 계산 시각을 사용할 수 없어 위치를 제공하지 않습니다. 실측 텔레메트리가 아닙니다.'
        : libraryAvailable
          ? '현재 GP 또는 분석 시각에서 SGP4 전파를 완료하지 못했습니다. 임의 궤도로 대체하지 않습니다. 실측 텔레메트리가 아닙니다.'
          : 'satellite.js를 사용할 수 없어 SGP4 위치를 제공하지 않습니다. 임의 궤도로 대체하지 않습니다. 실측 텔레메트리가 아닙니다.');
    }
  }

  function refreshSource(catalog = {}) {
    source = { source: catalog.source, fetched_at: catalog.fetched_at };
    renderSource();
  }

  function setLink(id) {
    const link = node('profile-celestrak-link');
    if (!link) return;
    link.hidden = isDemo() || !Number.isSafeInteger(id) || id <= 0;
    if (link.hidden) link.removeAttribute('href');
    else link.href = `https://celestrak.org/satcat/records.php?CATNR=${encodeURIComponent(id)}&FORMAT=JSON-PRETTY`;
  }

  function applyProfile(payload) {
    profile = payload;
    renderIdentity();
    renderSource();
    const available = payload.source === 'celestrak-satcat';
    setText('satcat-state', available ? 'SATCAT' : 'SATCAT 미제공');
    setText('satcat-note', available
      ? '식별 정보와 운용 상태 코드는 SATCAT 기록입니다. 현재 장비 상태를 측정하거나 판정한 결과가 아닙니다.'
      : 'SATCAT을 사용할 수 없어 GP 식별 정보만 표시합니다. 운용 상태는 추정하지 않습니다.');
  }

  async function select(item, catalog = {}, date = new Date(now())) {
    if (!item) { clear(); return; }
    const token = ++selectionToken;
    selected = { ...item };
    profile = null;
    source = { source: catalog.source, fetched_at: catalog.fetched_at };
    renderIdentity();
    renderElements();
    renderPosition(null, date);
    setPropagation('waiting', '대기', isDemo()
      ? 'DEMO 원형 2체 모델의 계산 대기 상태입니다. 실제 GP나 실측 텔레메트리가 아닙니다.'
      : 'GP 기반 계산 대기 상태입니다. 실측 텔레메트리가 아닙니다.');
    const id = finiteNumber(selected.NORAD_CAT_ID);
    setLink(id);
    if (isDemo()) {
      setText('satcat-state', 'DEMO');
      setText('satcat-note', '모델 참조 번호가 실제 위성과 같더라도 SATCAT을 조회하거나 실제 위성의 식별 정보와 혼합하지 않습니다.');
      return;
    }
    if (isNode()) {
      setText('satcat-state', '내 위성');
      setText('satcat-note', '노드 탭에서 배치한 위성입니다. 실제 카탈로그 객체가 아니므로 SATCAT을 조회하지 않습니다.');
      return;
    }
    if (typeof loadProfile !== 'function' || !Number.isSafeInteger(id) || id <= 0) {
      setText('satcat-state', 'SATCAT 미제공');
      setText('satcat-note', 'SATCAT 조회를 사용할 수 없어 GP 식별 정보만 표시합니다.');
      return;
    }
    const cached = cache.get(id);
    if (cached && now() < cached.expiresAt) { applyProfile(cached.payload); return; }
    setText('satcat-state', '조회 중');
    setText('satcat-note', 'SATCAT 식별 정보를 조회하고 있습니다. GP 전파와 별도로 제공됩니다.');
    try {
      const payload = await loadProfile(id);
      if (token !== selectionToken) return;
      if (!payload?.catalog || finiteNumber(payload.catalog.NORAD_CAT_ID) !== id) {
        throw new Error('선택 위성의 SATCAT 응답이 아닙니다.');
      }
      if (payload.source === 'celestrak-satcat') {
        const receivedAt = now();
        const fetchedAt = utcMillis(payload.fetched_at);
        cache.set(id, { payload, expiresAt: Math.min(receivedAt + SATCAT_TTL_MS, (fetchedAt ?? receivedAt) + SATCAT_TTL_MS) });
      }
      applyProfile(payload);
    } catch {
      if (token !== selectionToken) return;
      setText('satcat-state', 'SATCAT 미제공');
      setText('satcat-note', 'SATCAT 메타데이터를 불러오지 못했습니다. GP 식별 정보만 표시하며 운용 상태는 추정하지 않습니다.');
    }
  }

  function clear() {
    selectionToken += 1;
    selected = null;
    profile = null;
    source = {};
    analysisDate = null;
    setText('selected-name', '위성을 선택하세요');
    setText('selected-id', 'NORAD —');
    setText('selected-cospar', 'COSPAR —');
    setText('selected-model', '미선택');
    setText('satcat-state', 'SATCAT');
    setText('satcat-note', '');
    setText('element-note', '평균 궤도요소는 위성을 선택한 뒤 표시됩니다.');
    setPropagation('waiting', '대기', 'GP 기반 계산이며 실측 텔레메트리가 아닙니다.');
    for (const id of ['identity-values', 'element-values', 'position-values', 'source-values']) rows(id, []);
    setLink(null);
  }

  clear();
  return { select, update, refreshSource, clear };
}
