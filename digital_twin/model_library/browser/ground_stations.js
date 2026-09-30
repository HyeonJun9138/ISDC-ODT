// Ground station definitions for the communication console: site presets with real coordinates,
// the antenna and RF bands each site offers, and the functions that create, normalise and validate
// a station the operator places. Pure data and functions; no DOM, storage or transport.
// Antenna figures are representative engineering values, not the specification of any facility.

export const STATION_SCHEMA = 1;
export const BANDS = Object.freeze(['S', 'X', 'Ka']);
export const BAND_LABELS = Object.freeze({ S: 'S 대역 (TT&C)', X: 'X 대역 (데이터)', Ka: 'Ka 대역 (고속 데이터)' });
// System noise temperature per band used for G/T of the station antenna.
const SYSTEM_TEMPERATURE_K = Object.freeze({ S: 150, X: 200, Ka: 300 });
const APERTURE_EFFICIENCY = 0.6;
const SPEED_OF_LIGHT_M_S = 299_792_458;
export const BAND_FREQUENCY_GHZ = Object.freeze({ S: 2.2, X: 8.2, Ka: 20 });

// Site presets. Coordinates are the published locations of the cities or facilities; heights are
// WGS84 ellipsoidal in km (0 where unknown). Bands and dish size are representative.
export const STATION_PRESETS = Object.freeze({
  seoul: { key: 'seoul', name: '서울', region: '대한민국', latitude: 37.5665, longitude: 126.978, altitude_km: 0.04, dish_m: 7.3, bands: ['S', 'X', 'Ka'], min_elevation_deg: 5 },
  daejeon: { key: 'daejeon', name: '대전', region: '대한민국', latitude: 36.3742, longitude: 127.3567, altitude_km: 0.07, dish_m: 13, bands: ['S', 'X', 'Ka'], min_elevation_deg: 5 },
  jeju: { key: 'jeju', name: '제주', region: '대한민국', latitude: 33.4996, longitude: 126.5312, altitude_km: 0.03, dish_m: 7.3, bands: ['S', 'X'], min_elevation_deg: 5 },
  svalbard: { key: 'svalbard', name: '스발바르', region: '노르웨이', latitude: 78.2298, longitude: 15.4078, altitude_km: 0.45, dish_m: 11, bands: ['S', 'X', 'Ka'], min_elevation_deg: 3 },
  tromso: { key: 'tromso', name: '트롬쇠', region: '노르웨이', latitude: 69.6627, longitude: 18.9401, altitude_km: 0.1, dish_m: 11, bands: ['S', 'X'], min_elevation_deg: 5 },
  fairbanks: { key: 'fairbanks', name: '페어뱅크스', region: '미국 알래스카', latitude: 64.8378, longitude: -147.7164, altitude_km: 0.14, dish_m: 11, bands: ['S', 'X', 'Ka'], min_elevation_deg: 5 },
  inuvik: { key: 'inuvik', name: '이누빅', region: '캐나다', latitude: 68.3607, longitude: -133.723, altitude_km: 0.02, dish_m: 13, bands: ['S', 'X'], min_elevation_deg: 5 },
  singapore: { key: 'singapore', name: '싱가포르', region: '싱가포르', latitude: 1.3521, longitude: 103.8198, altitude_km: 0.02, dish_m: 7.3, bands: ['S', 'X'], min_elevation_deg: 7 },
  hawaii: { key: 'hawaii', name: '하와이', region: '미국', latitude: 19.0136, longitude: -155.6634, altitude_km: 0.2, dish_m: 9, bands: ['S', 'X'], min_elevation_deg: 5 },
  atacama: { key: 'atacama', name: '아타카마', region: '칠레', latitude: -23.0229, longitude: -67.753, altitude_km: 2.4, dish_m: 7.3, bands: ['S', 'X'], min_elevation_deg: 5 },
  punta_arenas: { key: 'punta_arenas', name: '푼타아레나스', region: '칠레', latitude: -53.1638, longitude: -70.9171, altitude_km: 0.03, dish_m: 11, bands: ['S', 'X', 'Ka'], min_elevation_deg: 5 },
  hobart: { key: 'hobart', name: '호바트', region: '호주', latitude: -42.8821, longitude: 147.3272, altitude_km: 0.02, dish_m: 7.3, bands: ['S', 'X'], min_elevation_deg: 5 },
});

// The stations a fresh console starts with: the Korean sites plus one polar site for high-latitude passes.
export const DEFAULT_STATION_KEYS = Object.freeze(['daejeon', 'jeju', 'svalbard']);

export function stationIdFor(key) {
  return `GS-${String(key || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_') || 'SITE'}`;
}

// Parabolic dish gain (dBi) at a band frequency with a fixed aperture efficiency.
export function antennaGainDbi(dishMeters, band) {
  const frequency = BAND_FREQUENCY_GHZ[band];
  const dish = Number(dishMeters);
  if (!frequency || !(dish > 0)) return null;
  const wavelength = SPEED_OF_LIGHT_M_S / (frequency * 1e9);
  return 10 * Math.log10(APERTURE_EFFICIENCY * (Math.PI * dish / wavelength) ** 2);
}

// Figure of merit G/T (dB/K) for the station antenna at a band.
export function figureOfMeritDbK(dishMeters, band) {
  const gain = antennaGainDbi(dishMeters, band);
  return gain === null ? null : gain - 10 * Math.log10(SYSTEM_TEMPERATURE_K[band]);
}

export function createStation(partial = {}, { id = null } = {}) {
  const preset = STATION_PRESETS[partial.preset] || null;
  const base = preset || STATION_PRESETS.seoul;
  const bands = Array.isArray(partial.bands) ? partial.bands.filter(band => BANDS.includes(band)) : [...base.bands];
  return {
    schema: STATION_SCHEMA,
    id: id || stationIdFor(partial.preset || partial.name || 'site'),
    preset: preset ? preset.key : null,
    name: String(partial.name ?? base.name).trim() || base.name,
    region: String(partial.region ?? base.region ?? '').trim(),
    latitude: Number.isFinite(Number(partial.latitude)) ? Number(partial.latitude) : base.latitude,
    longitude: Number.isFinite(Number(partial.longitude)) ? Number(partial.longitude) : base.longitude,
    altitude_km: Number.isFinite(Number(partial.altitude_km)) ? Number(partial.altitude_km) : base.altitude_km,
    dish_m: Number.isFinite(Number(partial.dish_m)) ? Number(partial.dish_m) : base.dish_m,
    bands: bands.length ? bands : [...base.bands],
    min_elevation_deg: Number.isFinite(Number(partial.min_elevation_deg)) ? Number(partial.min_elevation_deg) : base.min_elevation_deg,
    enabled: partial.enabled !== false,
  };
}

export function normalizeStation(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  return createStation(raw, { id: raw.id });
}

export function validateStation(station) {
  const errors = [];
  if (!station || typeof station !== 'object') return ['지상국 정의가 없습니다.'];
  const name = String(station.name ?? '').trim();
  if (!name || name.length > 40) errors.push('지상국 이름은 1~40자여야 합니다.');
  if (!(Number(station.latitude) >= -90 && Number(station.latitude) <= 90)) errors.push('위도는 -90~90°여야 합니다.');
  if (!(Number(station.longitude) >= -180 && Number(station.longitude) <= 180)) errors.push('경도는 -180~180°여야 합니다.');
  if (!(Number(station.altitude_km) >= -0.5 && Number(station.altitude_km) <= 9)) errors.push('고도는 -0.5~9 km여야 합니다.');
  if (!(Number(station.dish_m) >= 0.5 && Number(station.dish_m) <= 70)) errors.push('안테나 지름은 0.5~70 m여야 합니다.');
  if (!(Number(station.min_elevation_deg) >= 0 && Number(station.min_elevation_deg) < 90)) errors.push('최소 고각은 0° 이상 90° 미만이어야 합니다.');
  if (!Array.isArray(station.bands) || !station.bands.length || station.bands.some(band => !BANDS.includes(band))) errors.push('대역을 하나 이상 선택하세요 (S, X, Ka).');
  return errors;
}

// Great-circle distance between two stations on a sphere of the WGS84 equatorial radius (km).
export function surfaceDistanceKm(a, b) {
  const toRadians = degrees => degrees * Math.PI / 180;
  const phi1 = toRadians(a.latitude); const phi2 = toRadians(b.latitude);
  const dPhi = toRadians(b.latitude - a.latitude); const dLambda = toRadians(b.longitude - a.longitude);
  const h = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * 6378.137 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Ground range (km along the surface) inside which a satellite at the altitude is above the mask:
// the central angle acos(Re / (Re + h) · cos(mask)) − mask on a spherical Earth.
export function coverageRadiusKm(altitudeKm, maskDegrees) {
  const earth = 6378.137;
  const mask = Math.max(0, Number(maskDegrees) || 0) * Math.PI / 180;
  const ratio = earth / (earth + Math.max(0, Number(altitudeKm) || 0));
  const central = Math.acos(Math.min(1, ratio * Math.cos(mask))) - mask;
  return Math.max(0, central) * earth;
}
