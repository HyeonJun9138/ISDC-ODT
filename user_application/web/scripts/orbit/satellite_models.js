// 위성 3D 모델 배정. 매니페스트(/static/assets/models/manifest.json)는 사람이 관리하는 매핑 규칙과
// 대표 치수이며, 이 모듈은 사본을 받아 순수 함수로 판정한다. 결과는 표시용이지 위성 식별의 근거가 아니다.
const MANIFEST_URL = '/static/assets/models/manifest.json';
const ASSET_BASE = '/static/assets/models/';
const DEBRIS_PATTERN = /\bDEB\b|DEBRIS|FRAGMENT/i;
const ROCKET_PATTERN = /\bR\/B\b|ROCKET BODY|\bAKM\b|\bPLAT\b/i;
const STATION_PATTERN = /^ISS\b|TIANGONG|\bCSS\b|SPACE STATION/i;
const CUBESAT_PATTERN = /CUBESAT|\bFLOCK\b|\bLEMUR\b|\bSPACEBEE\b|\bDOVE\b|\b[1-6]U\b/i;
const ORBITS = new Set(['LEO', 'MEO', 'GEO', 'HEO']);
const DEFAULT_CREDIT = 'NASA 3D Resources';

export function objectKind(item = {}, catalog = {}) {
  const name = String(catalog.OBJECT_NAME || item.OBJECT_NAME || '').trim();
  const type = String(catalog.OBJECT_TYPE || '').trim().toUpperCase();
  if (type === 'DEB' || DEBRIS_PATTERN.test(name)) return 'debris';
  if (type === 'R/B' || type === 'RB' || ROCKET_PATTERN.test(name)) return 'rocket';
  if (STATION_PATTERN.test(name)) return 'station';
  if (CUBESAT_PATTERN.test(name)) return 'cubesat';
  return 'payload';
}

function compile(patterns) {
  return (Array.isArray(patterns) ? patterns : []).map(pattern => new RegExp(pattern, 'i'));
}

function idSet(values) {
  return new Set((Array.isArray(values) ? values : []).map(String));
}

function sourcesOf(manifest) {
  if (manifest?.sources && typeof manifest.sources === 'object') return manifest.sources;
  return manifest?.source ? { nasa: manifest.source } : {};
}

export function createModelResolver(manifest, baseUrl = ASSET_BASE) {
  const models = Array.isArray(manifest?.models) ? manifest.models : [];
  const byKey = new Map(models.map(model => [model.key, model]));
  const rules = models.map(model => ({
    model,
    exactNorad: idSet(model.exact?.norad), exactNames: compile(model.exact?.names),
    seriesNorad: idSet(model.series?.norad), seriesNames: compile(model.series?.names),
    familyNames: compile(model.family?.names),
  }));
  const representatives = manifest?.representatives || {};
  const sources = sourcesOf(manifest);
  const minimumPixelSize = Number(manifest?.display?.minimum_pixel_size) || 12;

  const describe = (model, quality, kind, orbit) => {
    const provider = model.provider || 'nasa';
    const source = sources[provider] || {};
    const sizeMeters = Number(model.size_m) > 0 ? Number(model.size_m) : null;
    const extent = Number(model.extent) > 0 ? Number(model.extent) : null;
    return {
      key: model.key, quality, kind, orbit, provider,
      title: model.title, label: model.label || model.title,
      url: baseUrl + model.file, thumbnail: model.thumbnail ? baseUrl + model.thumbnail : null,
      orientation: { heading: 0, pitch: 0, roll: 0, ...(model.orientation || {}) },
      minimumPixelSize,
      sizeMeters,
      scale: sizeMeters && extent ? sizeMeters / extent : 1,
      credit: source.credit || (provider === 'nasa' ? DEFAULT_CREDIT : provider),
      creditUrl: source.repository || '',
    };
  };

  return function resolveSatelliteModel(item = {}, catalog = {}) {
    const kind = objectKind(item, catalog);
    const orbitRaw = String(item.ORBIT_REGIME || '').toUpperCase();
    const orbit = ORBITS.has(orbitRaw) ? orbitRaw : 'LEO';
    // A user-placed node names its model directly; that choice is a display assignment, not a match.
    if (typeof item.model_key === 'string' && byKey.has(item.model_key)) return describe(byKey.get(item.model_key), 'assigned', kind, orbit);
    if (kind === 'rocket' || kind === 'debris') return null;
    const norad = String(item.NORAD_CAT_ID ?? catalog.NORAD_CAT_ID ?? '');
    const name = String(catalog.OBJECT_NAME || item.OBJECT_NAME || '').trim();
    const exact = rules.find(rule => rule.exactNorad.has(norad) || rule.exactNames.some(pattern => pattern.test(name)));
    if (exact) return describe(exact.model, 'exact', kind, orbit);
    const series = rules.find(rule => rule.seriesNorad.has(norad) || rule.seriesNames.some(pattern => pattern.test(name)));
    if (series) return describe(series.model, 'series', kind, orbit);
    const family = rules.find(rule => rule.familyNames.some(pattern => pattern.test(name)));
    if (family) return describe(family.model, 'representative', kind, orbit);
    const key = kind === 'station' ? representatives.station
      : kind === 'cubesat' ? representatives.cubesat
        : representatives[`payload:${orbit}`] || representatives['payload:LEO'];
    const model = byKey.get(key);
    return model ? describe(model, 'representative', kind, orbit) : null;
  };
}

function sizeSentence(match) {
  return match.sizeMeters ? ` 대표 치수 약 ${match.sizeMeters} m 기준의 실제 축척으로 표시합니다.` : '';
}

export function describeMatch(match) {
  if (!match) {
    return {
      state: '미배정', label: '3D 모델 없음',
      note: '로켓 본체, 파편 및 매핑되지 않은 객체는 3D 모델을 배정하지 않고 지구 위에 점으로만 표시합니다.',
      alt: '', credit: '', creditUrl: '',
    };
  }
  const alt = `${match.credit} 렌더링 · ${match.title}`;
  const credit = { credit: match.credit, creditUrl: match.creditUrl || '' };
  if (match.quality === 'assigned') {
    return {
      state: '사용자 지정 모델', label: match.label,
      note: `노드 탭에서 이 위성에 지정한 ${match.credit} 모델(${match.title})입니다. 표시용 형상이며 실제 기체나 촬영 이미지가 아닙니다.${sizeSentence(match)}`,
      alt, ...credit,
    };
  }
  if (match.provider === 'spacetwin') {
    return {
      state: '자체 제작 대표 형상', label: match.label,
      note: `공개 3D 자료가 없어 SpaceTwin이 만든 단순 대표 형상(${match.title})입니다. 제조사 형상이 아니며 실제 촬영 이미지가 아닙니다.${sizeSentence(match)}`,
      alt, ...credit,
    };
  }
  if (match.quality === 'exact') {
    return {
      state: '3D 모델 (해당 기체)', label: match.label,
      note: `해당 기체의 ${match.credit} 모델(${match.title})입니다. 렌더링 이미지이며 실제 촬영 이미지나 현재 자세가 아닙니다.${sizeSentence(match)}`,
      alt, ...credit,
    };
  }
  if (match.quality === 'series') {
    return {
      state: '동일 계열 모델', label: match.label,
      note: `같은 계열 기체의 ${match.credit} 모델(${match.title})로 표시합니다. 세부 형상은 실제 기체와 다를 수 있으며 실제 촬영 이미지가 아닙니다.${sizeSentence(match)}`,
      alt, ...credit,
    };
  }
  const scope = match.kind === 'station' ? '우주정거장' : match.kind === 'cubesat' ? '큐브샛' : `${match.orbit} 탑재체`;
  return {
    state: '대표 형상', label: match.label,
    note: `${scope} 대표 형상으로 ${match.credit}의 ${match.title} 모델을 사용합니다. 실제 기체 외형이 아니며 렌더링 이미지입니다.${sizeSentence(match)}`,
    alt, ...credit,
  };
}

export async function loadSatelliteModels(fetchImpl = globalThis.fetch, url = MANIFEST_URL) {
  if (typeof fetchImpl !== 'function') return null;
  try {
    const response = await fetchImpl(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = await response.json();
    return Array.isArray(manifest?.models) ? manifest : null;
  } catch (error) {
    console.warn('satellite model manifest unavailable; points only', error);
    return null;
  }
}
