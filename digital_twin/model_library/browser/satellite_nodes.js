// Model definitions for user-placed satellite nodes: bus presets, mission equipment catalogue with
// OISL terminal characteristics, operating modes, formation presets and the generator that lays a
// formation out as node definitions. Pure data and functions; no DOM, storage or transport.
// Values are representative engineering figures for a sandbox, not manufacturer specifications.
import { catalogElements, orbitElements, EARTH_A_KM } from '/static/simulation/satellite_dynamics.js';

export const NODE_SCHEMA = 1;
export const NODE_CATALOG_BASE = 900000;

export const EQUIPMENT_KINDS = Object.freeze({
  oisl: 'OISL 광 단말', rf: 'RF 링크', payload: '임무 탑재체', storage: '저장 장치', navigation: '항법',
});

export const OISL_ROLES = Object.freeze({
  fore: '앞 (동일 궤도면)', aft: '뒤 (동일 궤도면)', left: '왼쪽 (인접 궤도면)', right: '오른쪽 (인접 궤도면)', auto: '자동 (가장 가까운 가시 위성)',
});

// field_of_regard: azimuth half-angle around the mounting boresight and an elevation range above the
// local horizontal plane. Slew rate, acquisition dwell and jitter drive the terminal sequence.
export const EQUIPMENT_CATALOG = Object.freeze({
  oisl_standard: {
    kind: 'oisl', label: 'OISL 광 단말 (표준)', wavelength_nm: 1550, data_rate_mbps: 10000, max_range_km: 5000, min_range_km: 30,
    slew_rate_deg_s: 2, acquisition_time_s: 20, field_of_regard: { azimuth_half_angle: 180, elevation: [-20, 90] },
    jitter_deg: 0.002, power_w: 120, mass_kg: 20, mount: 'gimbal',
  },
  oisl_long_range: {
    kind: 'oisl', label: 'OISL 광 단말 (장거리, GEO 중계)', wavelength_nm: 1550, data_rate_mbps: 2500, max_range_km: 45000, min_range_km: 500,
    slew_rate_deg_s: 0.5, acquisition_time_s: 60, field_of_regard: { azimuth_half_angle: 180, elevation: [-90, 90] },
    jitter_deg: 0.001, power_w: 180, mass_kg: 35, mount: 'gimbal',
  },
  oisl_mini: {
    kind: 'oisl', label: 'OISL 소형 단말 (큐브샛)', wavelength_nm: 1550, data_rate_mbps: 1000, max_range_km: 1500, min_range_km: 10,
    slew_rate_deg_s: 5, acquisition_time_s: 15, field_of_regard: { azimuth_half_angle: 60, elevation: [-15, 45] },
    jitter_deg: 0.005, power_w: 25, mass_kg: 3, mount: 'gimbal',
  },
  ka_user_link: { kind: 'rf', label: 'Ka 대역 사용자 링크', band: 'Ka', frequency_ghz: 20, data_rate_mbps: 500, cone_half_angle_deg: 45, power_w: 90, mass_kg: 15 },
  x_band_downlink: { kind: 'rf', label: 'X 대역 데이터 다운링크', band: 'X', frequency_ghz: 8.2, data_rate_mbps: 800, cone_half_angle_deg: 60, power_w: 60, mass_kg: 10 },
  s_band_ttc: { kind: 'rf', label: 'S 대역 TT&C', band: 'S', frequency_ghz: 2.2, data_rate_mbps: 2, cone_half_angle_deg: 90, power_w: 8, mass_kg: 3, essential: true },
  eo_camera: { kind: 'payload', label: '광학 관측 카메라', gsd_m: 1.0, swath_km: 15, power_w: 150, mass_kg: 40 },
  dtn_store: { kind: 'storage', label: 'DTN 저장 전달 장치', capacity_gb: 2000, power_w: 30, mass_kg: 5 },
  gnss_receiver: { kind: 'navigation', label: 'GNSS 수신기', power_w: 5, mass_kg: 1, essential: true },
});

// model_key refers to user_application/web/assets/models/manifest.json.
export const BUS_PRESETS = Object.freeze({
  flat_panel: {
    label: '평판형 통신위성 버스', model_key: 'starlink_flat', mass_kg: 800, generation_w: 4500, bus_w: 400, battery_wh: 8000,
    equipment: [['oisl_standard', 'fore'], ['oisl_standard', 'aft'], ['oisl_standard', 'left'], ['oisl_standard', 'right'], ['ka_user_link'], ['s_band_ttc'], ['gnss_receiver']],
  },
  comms_small: {
    label: '소형 통신위성 버스', model_key: 'oneweb', mass_kg: 150, generation_w: 1200, bus_w: 120, battery_wh: 2000,
    equipment: [['oisl_standard', 'fore'], ['oisl_standard', 'aft'], ['oisl_standard', 'left'], ['oisl_standard', 'right'], ['ka_user_link'], ['s_band_ttc'], ['gnss_receiver']],
  },
  eo_smallsat: {
    label: '지구관측 소형위성', model_key: 'eo_1', mass_kg: 500, generation_w: 900, bus_w: 150, battery_wh: 3000,
    equipment: [['eo_camera'], ['x_band_downlink'], ['oisl_standard', 'auto'], ['dtn_store'], ['s_band_ttc'], ['gnss_receiver']],
  },
  cubesat_3u: {
    label: '3U 큐브샛', model_key: 'cubesat_3u', mass_kg: 4, generation_w: 30, bus_w: 8, battery_wh: 60,
    equipment: [['oisl_mini', 'auto'], ['s_band_ttc'], ['gnss_receiver']],
  },
  geo_relay: {
    label: '정지궤도 중계위성', model_key: 'ssl_1300', mass_kg: 3500, generation_w: 12000, bus_w: 900, battery_wh: 20000,
    equipment: [['oisl_long_range', 'auto'], ['oisl_long_range', 'auto'], ['ka_user_link'], ['s_band_ttc']],
  },
});

export const NODE_MODES = Object.freeze({
  nominal: { label: '정상 운용', note: '모든 장비를 사용하는 모드입니다.' },
  standby: { label: '대기', note: 'OISL 단말을 대기 상태로 두고 링크를 맺지 않는 모드입니다.' },
  safe: { label: '안전 모드', note: 'TT&C와 항법 수신기만 켜고 나머지 장비는 끄는 모드입니다.' },
});

export const FORMATION_PRESETS = Object.freeze({
  single: { label: '단일 위성', note: '위성 한 기를 지정한 궤도에 두는 모드입니다.' },
  train: { label: '열차형 (동일 궤도면)', note: '같은 궤도면에 일정한 위상 간격으로 위성을 줄지어 배치하는 모드입니다.' },
  walker_delta: { label: 'Walker Δ', note: '궤도면을 360°에 고르게 나누고 면 사이에 위상차를 두는 Walker 델타 배치입니다.' },
  walker_star: { label: 'Walker ★ (극궤도)', note: '궤도면을 180°에 나누는 극궤도 배치입니다. 이음매에서는 서로 반대 방향으로 도는 면이 만납니다.' },
});

export const LINK_POLICIES = Object.freeze({
  grid: { label: '앞·뒤 + 좌·우 (4 링크)', roles: ['fore', 'aft', 'left', 'right', 'auto'], help: '같은 궤도면의 앞뒤 위성과 인접 궤도면의 좌우 위성을 향한 단말을 모두 사용합니다.' },
  ring: { label: '앞·뒤만 (동일 궤도면)', roles: ['fore', 'aft', 'auto'], help: '같은 궤도면의 앞뒤 위성을 향한 단말만 사용하고 좌우 단말은 끕니다.' },
  none: { label: 'OISL 사용 안 함', roles: [], help: 'OISL 단말을 모두 끈 채 배치합니다.' },
});

// Slider specification for the formation panel. `presets` limits a control to some presets and
// `help` is the short guide shown when the pointer rests on the control.
export const FORMATION_CONTROLS = Object.freeze([
  { key: 'planes', label: '궤도면 수', min: 1, max: 12, step: 1, unit: '면', presets: ['walker_delta', 'walker_star'], help: 'Walker 배치에서 승교점 적경을 나눠 갖는 궤도면의 개수입니다.' },
  { key: 'per_plane', label: '면당 위성 수', min: 1, max: 16, step: 1, unit: '기', presets: ['train', 'walker_delta', 'walker_star'], help: '한 궤도면 안에 두는 위성 수입니다. Walker는 360°를 이 수로 균등하게 나눕니다.' },
  { key: 'altitude_km', label: '고도', min: 200, max: 2000, step: 10, unit: 'km', inputMax: 60000, help: '평균 고도입니다. 장반경에서 적도 반지름을 뺀 값이며 숫자 칸에는 2,000 km 이상도 입력할 수 있습니다.' },
  { key: 'inclination', label: '경사각', min: 0, max: 120, step: 0.5, unit: '°', help: '궤도면과 적도면 사이의 각입니다. 53°는 저궤도 통신망, 97~98°는 태양동기, 0°는 적도 궤도에 해당합니다.' },
  { key: 'phasing', label: '위상 계수 F', min: 0, max: 11, step: 1, unit: '', presets: ['walker_delta', 'walker_star'], help: '인접 궤도면 사이의 위상차를 F × 360° / 전체 위성 수로 둡니다. 0이면 모든 면의 위성이 같은 위상에 놓입니다.' },
  { key: 'spacing_deg', label: '위성 간 위상 간격', min: 1, max: 180, step: 1, unit: '°', presets: ['train'], help: '열차형에서 앞뒤 위성 사이의 평균 근점 이각 차이입니다. 550 km에서 10°는 직선 거리 약 1,200 km입니다.' },
  { key: 'raan_start', label: '첫 궤도면 승교점 적경', min: 0, max: 360, step: 1, unit: '°', help: '첫 궤도면이 적도를 북쪽으로 지나는 점의 적경입니다. 나머지 면은 분포 폭을 면 수로 나눈 간격으로 이어집니다.' },
  { key: 'raan_spread', label: '궤도면 분포 폭', min: 30, max: 360, step: 5, unit: '°', presets: ['walker_delta'], help: '궤도면을 펼치는 적경 범위입니다. Walker Δ는 360°, Walker ★(극궤도)는 180°로 고정됩니다.' },
  { key: 'anomaly_start', label: '첫 위성 평균 근점 이각', min: 0, max: 360, step: 1, unit: '°', help: '첫 위성의 궤도상 위상입니다. 편대 전체의 위상을 통째로 돌립니다.' },
]);

// Ten satellites per plane keep same-plane neighbours 36 degrees apart, inside the 5000 km rated
// range and the Earth-limb line of sight of the standard terminal at 550 km.
export const FORMATION_DEFAULTS = Object.freeze({
  preset: 'walker_delta', planes: 4, per_plane: 10, altitude_km: 550, inclination: 53, phasing: 1, spacing_deg: 30,
  raan_start: 0, raan_spread: 360, anomaly_start: 0, eccentricity: 0, prefix: 'ODT', bus: 'comms_small', link_policy: 'grid',
});

let equipmentSequence = 0;

export function equipmentSpec(instance) {
  const base = EQUIPMENT_CATALOG[instance?.catalog];
  return base ? { ...base, ...instance, field_of_regard: instance?.field_of_regard || base.field_of_regard } : null;
}

export function createEquipment(catalogKey, overrides = {}) {
  if (!EQUIPMENT_CATALOG[catalogKey]) throw new RangeError(`알 수 없는 장비 ${catalogKey}`);
  equipmentSequence += 1;
  const role = EQUIPMENT_CATALOG[catalogKey].kind === 'oisl' ? (overrides.role || 'auto') : null;
  return { id: overrides.id || `EQ-${Date.now().toString(36)}-${equipmentSequence}`, catalog: catalogKey, role, target: overrides.target || 'auto', enabled: overrides.enabled !== false };
}

function busEquipment(busKey, linkPolicy = 'grid') {
  const bus = BUS_PRESETS[busKey] || BUS_PRESETS.comms_small;
  const allowed = new Set((LINK_POLICIES[linkPolicy] || LINK_POLICIES.grid).roles);
  return bus.equipment.map(([catalog, role]) => {
    const item = createEquipment(catalog, { role });
    if (EQUIPMENT_CATALOG[catalog].kind === 'oisl' && !allowed.has(item.role)) item.enabled = false;
    return item;
  });
}

export function defaultOrbit(epoch, overrides = {}) {
  return { altitude_km: 550, eccentricity: 0, inclination: 53, raan: 0, argp: 0, mean_anomaly: 0, epoch, ...overrides };
}

// A complete node definition. Missing fields come from the bus preset; ids are supplied by the caller.
export function createNode(partial = {}, { epoch = Date.now(), id = 'NODE-0000', catalogNumber = NODE_CATALOG_BASE + 1, linkPolicy = 'grid' } = {}) {
  const busKey = BUS_PRESETS[partial.bus] ? partial.bus : 'comms_small';
  const bus = BUS_PRESETS[busKey];
  const created = new Date(epoch).toISOString();
  return {
    schema: NODE_SCHEMA,
    id,
    catalog_number: catalogNumber,
    name: partial.name || id,
    bus: busKey,
    model_key: partial.model_key || bus.model_key,
    mode: NODE_MODES[partial.mode] ? partial.mode : 'nominal',
    mass_kg: Number.isFinite(Number(partial.mass_kg)) ? Number(partial.mass_kg) : bus.mass_kg,
    power: { generation_w: bus.generation_w, bus_w: bus.bus_w, battery_wh: bus.battery_wh, ...(partial.power || {}) },
    orbit: { ...defaultOrbit(epoch), ...(partial.orbit || {}) },
    equipment: Array.isArray(partial.equipment) ? partial.equipment.map(item => ({ ...item })) : busEquipment(busKey, linkPolicy),
    formation: partial.formation ? { ...partial.formation } : null,
    notes: partial.notes || '',
    created_at: partial.created_at || created,
    updated_at: created,
  };
}

export function cloneNode(node, { id, catalogNumber, name, epoch = Date.now() }) {
  return {
    ...structuredClone(node), id, catalog_number: catalogNumber, name: name || `${node.name} 사본`, formation: null,
    equipment: (node.equipment || []).map(item => createEquipment(item.catalog, { ...item, id: undefined })),
    created_at: new Date(epoch).toISOString(), updated_at: new Date(epoch).toISOString(),
  };
}

// Storage may hold older or hand-edited definitions; fill defaults without inventing an orbit.
export function normalizeNode(raw, fallbackEpoch = Date.now()) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const node = createNode({ ...raw, equipment: Array.isArray(raw.equipment) ? raw.equipment : undefined }, {
    epoch: fallbackEpoch, id: raw.id, catalogNumber: Number(raw.catalog_number) || NODE_CATALOG_BASE + 1,
  });
  node.orbit = { ...defaultOrbit(fallbackEpoch), ...(raw.orbit || {}) };
  node.equipment = node.equipment.filter(item => EQUIPMENT_CATALOG[item.catalog]).map(item => ({
    id: item.id || createEquipment(item.catalog).id, catalog: item.catalog,
    role: EQUIPMENT_CATALOG[item.catalog].kind === 'oisl' ? (OISL_ROLES[item.role] ? item.role : 'auto') : null,
    target: item.target || 'auto', enabled: item.enabled !== false,
  }));
  node.created_at = raw.created_at || node.created_at;
  node.updated_at = raw.updated_at || node.updated_at;
  return node;
}

export function validateNode(node) {
  const errors = [];
  if (!node || typeof node !== 'object') return ['노드 정의가 없습니다.'];
  const name = String(node.name ?? '').trim();
  if (!name || name.length > 40) errors.push('위성 이름은 1~40자여야 합니다.');
  if (!BUS_PRESETS[node.bus]) errors.push('알 수 없는 버스 프리셋입니다.');
  if (typeof node.model_key !== 'string' || !node.model_key) errors.push('3D 모델을 선택하세요.');
  if (!NODE_MODES[node.mode]) errors.push('알 수 없는 운용 모드입니다.');
  if (!orbitElements(node.orbit)) errors.push('궤도 정의가 허용 범위를 벗어났습니다. 근지점 고도 120 km 이상, 원지점 고도 200,000 km 이하, 이심률 0~0.95, 경사각 0~180°가 필요합니다.');
  for (const key of ['generation_w', 'bus_w', 'battery_wh']) {
    if (!(Number(node.power?.[key]) >= 0)) errors.push(`전력 항목 ${key}는 0 이상이어야 합니다.`);
  }
  if (!Array.isArray(node.equipment)) errors.push('장비 목록이 필요합니다.');
  else {
    node.equipment.forEach((item, index) => {
      if (!EQUIPMENT_CATALOG[item?.catalog]) errors.push(`${index + 1}번 장비의 종류를 알 수 없습니다.`);
      else if (EQUIPMENT_CATALOG[item.catalog].kind === 'oisl' && !OISL_ROLES[item.role]) errors.push(`${index + 1}번 OISL 단말의 장착 방향을 선택하세요.`);
    });
  }
  return errors;
}

export function equipmentOf(node) {
  return (node?.equipment || []).map(equipmentSpec).filter(Boolean);
}

// Whether an equipment item is switched on under the node's operating mode.
export function equipmentActive(node, item) {
  const spec = equipmentSpec(item);
  if (!spec || item.enabled === false) return false;
  if (node.mode === 'safe') return spec.essential === true;
  if (node.mode === 'standby' && spec.kind === 'oisl') return false;
  return true;
}

export function activeOislTerminals(node) {
  return (node?.equipment || []).filter(item => equipmentSpec(item)?.kind === 'oisl' && equipmentActive(node, item));
}

// Instantaneous power balance; battery state of charge is not integrated over time.
export function powerBudget(node, { sunlit = true, activeTerminals = null } = {}) {
  const generation = sunlit ? Number(node.power?.generation_w) || 0 : 0;
  let consumption = Number(node.power?.bus_w) || 0;
  const items = [];
  for (const item of node.equipment || []) {
    const spec = equipmentSpec(item);
    if (!spec) continue;
    let active = equipmentActive(node, item);
    if (active && spec.kind === 'oisl' && activeTerminals instanceof Set) active = activeTerminals.has(item.id);
    const draw = active ? Number(spec.power_w) || 0 : 0;
    consumption += draw;
    items.push({ id: item.id, label: spec.label, kind: spec.kind, active, power_w: draw });
  }
  return { generation_w: generation, consumption_w: consumption, margin_w: generation - consumption, sunlit, items };
}

export function nodeMass(node) {
  return (Number(node.mass_kg) || 0) + equipmentOf(node).reduce((sum, spec) => sum + (Number(spec.mass_kg) || 0), 0);
}

// Catalog-style item for the globe and the dashboard list. GP-like fields let the shared list,
// inspector and trajectory code read the definition; `dynamics` selects the node propagator.
export function nodeCatalogItem(node) {
  const elements = catalogElements(node.orbit) || {};
  return {
    NORAD_CAT_ID: node.catalog_number,
    OBJECT_NAME: node.name,
    OBJECT_ID: node.id,
    OBJECT_TYPE: 'PAY',
    dynamics: 'kepler_j2',
    node: true,
    node_id: node.id,
    model_key: node.model_key,
    bus: node.bus,
    mode: node.mode,
    orbit: { ...node.orbit },
    source: 'node-sandbox',
    ...elements,
  };
}

function planeLetter(index) {
  return index < 26 ? String.fromCharCode(65 + index) : `P${index + 1}`;
}

export function normalizeFormationParams(params = {}) {
  const merged = { ...FORMATION_DEFAULTS, ...params };
  const preset = FORMATION_PRESETS[merged.preset] ? merged.preset : 'walker_delta';
  const clamp = (value, control) => Math.min(control.inputMax ?? control.max, Math.max(control.min, Number(value)));
  for (const control of FORMATION_CONTROLS) {
    merged[control.key] = Number.isFinite(Number(merged[control.key])) ? clamp(merged[control.key], control) : FORMATION_DEFAULTS[control.key];
  }
  if (preset === 'single') { merged.planes = 1; merged.per_plane = 1; }
  if (preset === 'train') merged.planes = 1;
  if (preset === 'walker_star') merged.raan_spread = 180;
  merged.planes = Math.round(merged.planes); merged.per_plane = Math.round(merged.per_plane);
  merged.phasing = Math.min(Math.max(0, Math.round(merged.phasing)), Math.max(0, merged.planes - 1));
  merged.preset = preset;
  merged.prefix = String(merged.prefix || 'ODT').trim().slice(0, 12) || 'ODT';
  merged.bus = BUS_PRESETS[merged.bus] ? merged.bus : FORMATION_DEFAULTS.bus;
  merged.link_policy = LINK_POLICIES[merged.link_policy] ? merged.link_policy : 'grid';
  return merged;
}

export function formationSummary(params) {
  const p = normalizeFormationParams(params);
  const total = p.planes * p.per_plane;
  const orbit = { altitude_km: p.altitude_km, eccentricity: p.eccentricity, inclination: p.inclination, epoch: 0 };
  const elements = orbitElements(orbit);
  const anomalyStep = p.preset === 'train' ? p.spacing_deg : 360 / p.per_plane;
  const a = EARTH_A_KM + p.altitude_km;
  const chord = p.per_plane > 1 || p.preset === 'train' ? 2 * a * Math.sin(anomalyStep / 2 * Math.PI / 180) : null;
  return {
    preset: p.preset, total, planes: p.planes, perPlane: p.per_plane,
    periodMinutes: elements ? elements.period / 60 : null,
    raanStep: p.planes > 1 ? p.raan_spread / p.planes : 0,
    anomalyStep: total > 1 ? anomalyStep : 0,
    phaseOffset: p.planes > 1 ? p.phasing * 360 / total : 0,
    intraPlaneRangeKm: chord,
    regime: catalogElements(orbit)?.ORBIT_REGIME || null,
    valid: !!elements,
  };
}

// Lay the formation out as node definitions. idFactory returns { id, catalogNumber } per node.
export function generateFormation(params, { epoch = Date.now(), idFactory, formationId = `FRM-${Date.now().toString(36)}`, base = null } = {}) {
  const p = normalizeFormationParams(params);
  if (typeof idFactory !== 'function') throw new TypeError('idFactory is required');
  const total = p.planes * p.per_plane;
  const nodes = [];
  for (let plane = 0; plane < p.planes; plane += 1) {
    for (let index = 0; index < p.per_plane; index += 1) {
      const raan = p.raan_start + (p.planes > 1 ? plane * p.raan_spread / p.planes : 0);
      const anomaly = p.anomaly_start
        + index * (p.preset === 'train' ? p.spacing_deg : 360 / p.per_plane)
        + (p.planes > 1 ? plane * p.phasing * 360 / total : 0);
      const name = p.preset === 'single' ? p.prefix
        : p.planes > 1 ? `${p.prefix}-${planeLetter(plane)}${index + 1}` : `${p.prefix}-${index + 1}`;
      const ids = idFactory();
      const seed = base ? { ...base, name, formation: undefined, equipment: undefined, orbit: undefined } : { bus: p.bus, name };
      const node = createNode(seed, { epoch, id: ids.id, catalogNumber: ids.catalogNumber, linkPolicy: p.link_policy });
      node.orbit = defaultOrbit(epoch, {
        altitude_km: p.altitude_km, eccentricity: p.eccentricity, inclination: p.inclination,
        raan: ((raan % 360) + 360) % 360, argp: 0, mean_anomaly: ((anomaly % 360) + 360) % 360,
      });
      node.formation = { id: formationId, preset: p.preset, plane, index, params: { ...p } };
      nodes.push(node);
    }
  }
  return nodes;
}
