// Reference ground-station sites for the orbit console: the communication console's site presets
// plus representative sites of the main public tracking networks. Coordinates are the published
// (approximate) locations of the facilities or cities, antenna and band figures are representative
// engineering values, and nothing here is fetched live: the console derives look angles, visibility
// and passes for a site from the GP catalogue itself. Pure data and functions; no DOM or transport.
import { STATION_PRESETS } from '/static/model_library/ground_stations.js';

export const SITE_GROUPS = Object.freeze([
  { key: 'korea', label: '대한민국' },
  { key: 'asia_oceania', label: '아시아·오세아니아' },
  { key: 'europe_africa', label: '유럽·아프리카' },
  { key: 'americas', label: '북미·남미' },
  { key: 'polar', label: '극지' },
]);

// Affiliation and role notes for the communication console presets, keyed by preset key.
const PRESET_NOTES = Object.freeze({
  seoul: { group: 'korea', operator: '도시 기준 대표 관측점', network: '기준점', role: '관측 기준 (도시 좌표)' },
  daejeon: { group: 'korea', operator: '한국항공우주연구원 (KARI)', network: '위성운영센터', role: '국가 위성 관제·추적' },
  jeju: { group: 'korea', operator: '한국항공우주연구원 (KARI)', network: '제주 추적소', role: '저궤도 위성 추적·수신' },
  svalbard: { group: 'polar', operator: 'KSAT', network: 'SvalSat', role: '극궤도 위성 다중 패스 수신' },
  tromso: { group: 'polar', operator: 'KSAT', network: 'TrollSat·SvalSat 연계', role: '고위도 추적' },
  fairbanks: { group: 'americas', operator: 'NASA / 알래스카대 ASF', network: 'NASA Near Space Network', role: '극궤도 지구관측 수신' },
  inuvik: { group: 'polar', operator: '캐나다 NRCan / DLR·SSC 공동', network: 'Inuvik Satellite Station Facility', role: '고위도 지구관측 수신' },
  singapore: { group: 'asia_oceania', operator: '상용 지상국 사업자 (대표)', network: '적도 부근 상용 지상국', role: '저경사 궤도 수신' },
  hawaii: { group: 'asia_oceania', operator: 'SSC', network: 'South Point', role: '태평양 중계·추적' },
  atacama: { group: 'americas', operator: '고지대 대표 관측점', network: '기준점', role: '남반구 고지대 관측' },
  punta_arenas: { group: 'americas', operator: 'SSC / KSAT', network: '남미 남단 지상국', role: '극궤도 남반구 수신' },
  hobart: { group: 'asia_oceania', operator: '도시 기준 대표 관측점', network: '기준점', role: '남반구 고위도 관측' },
});

// Additional representative sites. Bands are shown as published (C/Ku for commercial teleports).
const EXTRA_SITES = Object.freeze({
  kumsan: { name: '금산', region: '대한민국', group: 'korea', operator: 'KT SAT', network: '금산 위성지구국 (텔레포트)', role: '정지궤도 통신위성 관제·중계', latitude: 36.108, longitude: 127.487, altitude_km: 0.1, dish_m: 30, bands: ['C', 'Ku', 'Ka'], min_elevation_deg: 5 },
  usuda: { name: '우스다', region: '일본', group: 'asia_oceania', operator: 'JAXA', network: '우스다 심우주 관측소', role: '심우주 탐사선 추적', latitude: 36.133, longitude: 138.362, altitude_km: 1.45, dish_m: 64, bands: ['S', 'X'], min_elevation_deg: 5 },
  byalalu: { name: '비얄랄루', region: '인도', group: 'asia_oceania', operator: 'ISRO ISTRAC', network: 'Indian Deep Space Network', role: '심우주·달 탐사 추적', latitude: 12.9, longitude: 77.37, altitude_km: 0.85, dish_m: 32, bands: ['S', 'X'], min_elevation_deg: 5 },
  new_norcia: { name: '뉴노샤', region: '호주', group: 'asia_oceania', operator: 'ESA', network: 'ESTRACK 심우주 안테나 DSA-1', role: '심우주 추적', latitude: -31.048, longitude: 116.191, altitude_km: 0.25, dish_m: 35, bands: ['S', 'X'], min_elevation_deg: 5 },
  dongara: { name: '동가라', region: '호주', group: 'asia_oceania', operator: 'SSC', network: 'Western Australian Space Centre', role: '저궤도 상용 수신', latitude: -29.046, longitude: 115.349, altitude_km: 0.24, dish_m: 13, bands: ['S', 'X'], min_elevation_deg: 5 },
  canberra: { name: '캔버라', region: '호주', group: 'asia_oceania', operator: 'NASA / CSIRO', network: 'Deep Space Network (Tidbinbilla)', role: '심우주 추적', latitude: -35.4014, longitude: 148.9819, altitude_km: 0.7, dish_m: 70, bands: ['S', 'X', 'Ka'], min_elevation_deg: 6 },
  kiruna: { name: '키루나', region: '스웨덴', group: 'europe_africa', operator: 'ESA / SSC', network: 'ESTRACK · Esrange', role: '극궤도 수신·추적', latitude: 67.857, longitude: 20.964, altitude_km: 0.4, dish_m: 15, bands: ['S', 'X'], min_elevation_deg: 5 },
  weilheim: { name: '바일하임', region: '독일', group: 'europe_africa', operator: 'DLR', network: 'GSOC 지상국', role: '위성 관제·추적', latitude: 47.881, longitude: 11.085, altitude_km: 0.6, dish_m: 15, bands: ['S', 'X'], min_elevation_deg: 5 },
  madrid: { name: '마드리드', region: '스페인', group: 'europe_africa', operator: 'NASA / INTA', network: 'Deep Space Network (Robledo)', role: '심우주 추적', latitude: 40.4314, longitude: -4.2481, altitude_km: 0.8, dish_m: 70, bands: ['S', 'X', 'Ka'], min_elevation_deg: 6 },
  maspalomas: { name: '마스팔로마스', region: '스페인 카나리아', group: 'europe_africa', operator: 'ESA / INTA', network: 'ESTRACK', role: '저궤도·발사 추적', latitude: 27.763, longitude: -15.634, altitude_km: 0.2, dish_m: 15, bands: ['S', 'X'], min_elevation_deg: 5 },
  kourou: { name: '쿠루', region: '프랑스령 기아나', group: 'americas', operator: 'ESA / CNES', network: 'ESTRACK · 기아나 우주센터', role: '발사·초기 궤도 추적', latitude: 5.2515, longitude: -52.8047, altitude_km: 0.0, dish_m: 15, bands: ['S', 'X'], min_elevation_deg: 5 },
  hartebeesthoek: { name: '하르테비스훅', region: '남아프리카공화국', group: 'europe_africa', operator: 'SANSA', network: 'Hartebeesthoek 지상국', role: '저궤도·발사 추적', latitude: -25.887, longitude: 27.707, altitude_km: 1.55, dish_m: 12, bands: ['S', 'X'], min_elevation_deg: 5 },
  goldstone: { name: '골드스톤', region: '미국 캘리포니아', group: 'americas', operator: 'NASA JPL', network: 'Deep Space Network', role: '심우주 추적', latitude: 35.4267, longitude: -116.89, altitude_km: 1.0, dish_m: 70, bands: ['S', 'X', 'Ka'], min_elevation_deg: 6 },
  wallops: { name: '월롭스', region: '미국 버지니아', group: 'americas', operator: 'NASA', network: 'Near Space Network', role: '저궤도 수신·발사 추적', latitude: 37.925, longitude: -75.476, altitude_km: 0.0, dish_m: 11, bands: ['S', 'X'], min_elevation_deg: 5 },
  malargue: { name: '말라르궤', region: '아르헨티나', group: 'americas', operator: 'ESA', network: 'ESTRACK 심우주 안테나 DSA-3', role: '심우주 추적', latitude: -35.776, longitude: -69.398, altitude_km: 1.55, dish_m: 35, bands: ['X', 'Ka'], min_elevation_deg: 5 },
  troll: { name: '트롤', region: '남극 (노르웨이 기지)', group: 'polar', operator: 'KSAT', network: 'TrollSat', role: '극궤도 남극 수신', latitude: -72.012, longitude: 2.535, altitude_km: 1.3, dish_m: 7.3, bands: ['S', 'X'], min_elevation_deg: 5 },
  mcmurdo: { name: '맥머도', region: '남극 (미국 기지)', group: 'polar', operator: 'NASA / NSF', network: 'Near Space Network', role: '극궤도 남극 수신', latitude: -77.846, longitude: 166.668, altitude_km: 0.15, dish_m: 10, bands: ['S', 'X'], min_elevation_deg: 5 },
});

const upperKey = key => String(key).toUpperCase();

function site(key, definition, notes = {}) {
  const KEY = upperKey(key);
  return Object.freeze({
    key: KEY,
    name: definition.name,
    region: definition.region || '',
    group: definition.group || notes.group || 'asia_oceania',
    operator: definition.operator || notes.operator || '',
    network: definition.network || notes.network || '',
    role: definition.role || notes.role || '',
    latitude: Number(definition.latitude),
    longitude: Number(definition.longitude),
    altitudeKm: Number(definition.altitude_km) || 0,
    dishMeters: Number(definition.dish_m) || null,
    bands: Object.freeze([...(definition.bands || [])]),
    minElevationDeg: Number.isFinite(Number(definition.min_elevation_deg)) ? Number(definition.min_elevation_deg) : 5,
    presetKey: notes === PRESET_NOTES[key] && STATION_PRESETS[key] ? key : null,
  });
}

function buildSites() {
  const sites = {};
  for (const [key, preset] of Object.entries(STATION_PRESETS)) sites[upperKey(key)] = site(key, preset, PRESET_NOTES[key] || {});
  for (const [key, extra] of Object.entries(EXTRA_SITES)) sites[upperKey(key)] = site(key, extra);
  return Object.freeze(sites);
}

// Keyed by upper-case site key (SEOUL, DAEJEON, …), which is what the observer selector and the
// globe use. Observer geometry only needs latitude/longitude; the rest is shown on the site card.
export const GROUND_STATIONS = buildSites();

// Sites grouped for a selector: groups in SITE_GROUPS order, sites by name inside each group.
export function stationGroups(sites = GROUND_STATIONS) {
  return SITE_GROUPS.map(group => ({
    key: group.key,
    label: group.label,
    sites: Object.values(sites).filter(s => s.group === group.key).sort((a, b) => a.name.localeCompare(b.name, 'ko')),
  })).filter(group => group.sites.length);
}

export function stationsIn(groupKey, sites = GROUND_STATIONS) {
  return Object.values(sites).filter(s => s.group === groupKey);
}
