// Assembly of a PoC scenario definition into the twin's model objects: the satellite nodes of the
// constellation with their roles and equipment, the ground stations, the mission requests and the
// resolution of `@role` references. Pure functions of the definition and an id factory; no DOM,
// storage or transport. The definition itself is operational configuration served by the
// application (/api/scenarios/{id}); the node, station and mission models are the existing ones.
import { createEquipment, generateFormation, normalizeFormationParams, EQUIPMENT_CATALOG } from '/static/model_library/satellite_nodes.js';
import { STATION_PRESETS, createStation, stationIdFor } from '/static/model_library/ground_stations.js';
import { DEFAULT_PARAMS, TARGET_PRESETS } from '/static/model_library/mission_types.js';

export const ROLE_PREFIX = '@';

function roleKeyOf(value) {
  const text = String(value ?? '');
  if (text.startsWith(`satellite:${ROLE_PREFIX}`)) return { prefix: 'satellite:', role: text.slice(`satellite:${ROLE_PREFIX}`.length) };
  if (text.startsWith(ROLE_PREFIX)) return { prefix: '', role: text.slice(ROLE_PREFIX.length) };
  return null;
}

// Replace every `@role` (also inside `satellite:@role`) with the node id that holds the role.
export function resolveReference(value, roles) {
  const ref = roleKeyOf(value);
  if (!ref) return value;
  const node = roles?.[ref.role];
  if (!node) throw new RangeError(`시나리오 역할 ${ref.role}에 해당하는 위성이 없습니다.`);
  return `${ref.prefix}${node.id}`;
}

export function resolveDeep(value, roles) {
  if (Array.isArray(value)) return value.map(item => resolveDeep(item, roles));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveDeep(item, roles)]));
  return resolveReference(value, roles);
}

function modelKeyOf(value, where) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value) throw new RangeError(`${where}의 표시 모델(model_key)이 비어 있습니다.`);
  return value;
}

// Lay the constellation out with the shared formation generator, then apply the scenario's display
// model, role labels and equipment additions. The definition's model_key replaces the bus preset's
// model on every satellite and a role's model_key replaces it on that satellite; without either the
// bus model stays. Returns { nodes, roles } where roles maps role key → node.
export function assembleConstellation(definition, { epoch = Date.now(), idFactory, formationId = 'FRM-SCENARIO' } = {}) {
  const spec = definition?.constellation;
  if (!spec) throw new RangeError('시나리오에 군집 정의가 없습니다.');
  if (typeof idFactory !== 'function') throw new TypeError('idFactory is required');
  const params = normalizeFormationParams(spec);
  const nodes = generateFormation(params, { epoch, idFactory, formationId });
  const modelKey = modelKeyOf(spec.model_key, '군집');
  if (modelKey) for (const node of nodes) node.model_key = modelKey;
  const byPlace = new Map(nodes.map(node => [`${node.formation.plane}:${node.formation.index}`, node]));
  const roles = {};
  for (const [key, role] of Object.entries(spec.roles || {})) {
    const node = byPlace.get(`${Number(role.plane)}:${Number(role.index)}`);
    if (!node) throw new RangeError(`역할 ${key}의 위치(면 ${role.plane}, ${role.index}번)에 위성이 없습니다.`);
    node.role = { key, label: role.label || key };
    const roleModel = modelKeyOf(role.model_key, `역할 ${key}`);
    if (roleModel) node.model_key = roleModel;
    roles[key] = node;
  }
  const additions = spec.equipment || {};
  const addTo = (node, catalogKeys) => {
    for (const catalog of catalogKeys || []) {
      if (!EQUIPMENT_CATALOG[catalog]) throw new RangeError(`알 수 없는 장비 ${catalog}`);
      if (node.equipment.some(item => item.catalog === catalog)) continue;
      node.equipment.push(createEquipment(catalog));
    }
  };
  for (const node of nodes) addTo(node, additions.all);
  for (const [key, catalogKeys] of Object.entries(additions.roles || {})) {
    if (!roles[key]) throw new RangeError(`장비를 추가할 역할 ${key}이(가) 없습니다.`);
    addTo(roles[key], catalogKeys);
  }
  return { nodes, roles, formationId };
}

// Ground stations as the station model creates them; unknown preset keys are an error, not a default.
export function assembleStations(definition) {
  return (definition?.stations || []).map(key => {
    const preset = STATION_PRESETS[key];
    if (!preset) throw new RangeError(`알 수 없는 지상국 프리셋 ${key}`);
    return createStation({ preset: key }, { id: stationIdFor(key) });
  });
}

// Mission request partials for the mission store with `@role` references resolved and the
// deadline placed relative to the scenario start. `key` is kept so the player can find the mission.
export function assembleMissions(definition, roles, { now = Date.now() } = {}) {
  return (definition?.missions || []).map(spec => {
    const explicit = resolveDeep(spec.params || {}, roles);
    const params = { ...(DEFAULT_PARAMS[spec.kind] || {}), ...explicit };
    if (spec.kind === 'observe' && explicit.target) {
      // A named target preset supplies the coordinates the definition did not spell out.
      const preset = TARGET_PRESETS.find(item => item.key === explicit.target);
      if (preset) {
        if (!explicit.target_name) params.target_name = preset.name;
        if (explicit.latitude == null) params.latitude = preset.latitude;
        if (explicit.longitude == null) params.longitude = preset.longitude;
      }
    }
    const hours = Number(spec.deadline_hours) > 0 ? Number(spec.deadline_hours) : 6;
    return {
      key: spec.key, kind: spec.kind, name: spec.name, requester: spec.requester, priority: spec.priority,
      window_start: new Date(now).toISOString(), deadline: new Date(now + hours * 3600_000).toISOString(),
      params, commit: spec.commit === true, notes: `[scenario:${definition.id}:${spec.key}] 시나리오 재생기가 등록한 임무입니다.`,
      scenario: { id: definition.id, key: spec.key },
    };
  });
}

// Name of the role a node holds inside the scenario, for guidance text; null when it has none.
export function roleLabel(node) {
  return node?.role?.label || null;
}

// Fill `{a.b}` placeholders from a nested context; unknown paths stay visible as "—" so a missing
// value never silently reads as a fact.
export function fillTemplate(text, context) {
  return String(text ?? '').replace(/\{([a-zA-Z0-9_.]+)\}/g, (_, path) => {
    const value = path.split('.').reduce((current, key) => (current == null ? undefined : current[key]), context);
    return value == null || value === '' ? '—' : String(value);
  });
}
