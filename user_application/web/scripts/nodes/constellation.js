// Working set and deployment record of user-placed satellite nodes. The draft set is what the node
// tab edits; deploying copies it into the deployed set that the dashboard visualises. Both live in
// the browser's localStorage (a per-browser display configuration, not server runtime state).
import { createNode, cloneNode, normalizeNode, validateNode, nodeCatalogItem, NODE_CATALOG_BASE } from "/static/model_library/satellite_nodes.js";

export const DRAFT_KEY = "spacetwin-nodes-draft-v1";
export const DEPLOYED_KEY = "spacetwin-nodes-deployed-v1";
export const MAX_NODES = 240;

function readJson(storage, key) {
  try {
    const raw = storage?.getItem?.(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeJson(storage, key, value) {
  try { storage?.setItem?.(key, JSON.stringify(value)); return true; } catch { return false; }
}

function strip(node) {
  // Comparison ignores bookkeeping timestamps so a save without changes does not read as a change.
  const { updated_at, ...rest } = node;
  return rest;
}

export function createConstellationStore({ storage = null, now = () => Date.now() } = {}) {
  const listeners = new Set();
  let drafts = [];
  let deployed = [];
  let deployedAt = null;
  let sequence = 0;
  let selectedId = null;

  const notify = event => listeners.forEach(listener => listener(event, api));

  function nextIds() {
    sequence += 1;
    return { id: `NODE-${String(sequence).padStart(4, "0")}`, catalogNumber: NODE_CATALOG_BASE + sequence };
  }

  function persist() {
    writeJson(storage, DRAFT_KEY, { schema: 1, sequence, selectedId, nodes: drafts });
    writeJson(storage, DEPLOYED_KEY, { schema: 1, deployedAt, nodes: deployed });
  }

  function load() {
    const draft = readJson(storage, DRAFT_KEY);
    const live = readJson(storage, DEPLOYED_KEY);
    const epoch = now();
    drafts = (Array.isArray(draft?.nodes) ? draft.nodes : []).map(node => normalizeNode(node, epoch)).filter(Boolean).slice(0, MAX_NODES);
    deployed = (Array.isArray(live?.nodes) ? live.nodes : []).map(node => normalizeNode(node, epoch)).filter(Boolean).slice(0, MAX_NODES);
    deployedAt = typeof live?.deployedAt === "string" ? live.deployedAt : null;
    // Ids and catalog numbers must stay unique across drafts and the deployed record, so the
    // sequence resumes after the highest of the stored sequence, catalog numbers and id suffixes.
    const highest = [...drafts, ...deployed].reduce((max, node) => Math.max(max,
      Number(node.catalog_number) - NODE_CATALOG_BASE || 0, Number(/^NODE-(\d+)$/.exec(node.id)?.[1]) || 0), 0);
    sequence = Math.max(Number(draft?.sequence) || 0, highest);
    selectedId = drafts.some(node => node.id === draft?.selectedId) ? draft.selectedId : drafts[0]?.id || null;
    notify("load");
  }

  function find(id) {
    return drafts.find(node => node.id === id) || null;
  }

  function add(partial = {}, options = {}) {
    if (drafts.length >= MAX_NODES) throw new RangeError(`노드는 최대 ${MAX_NODES}개까지 둘 수 있습니다.`);
    const ids = nextIds();
    const node = createNode({ ...partial, name: partial.name || ids.id }, { epoch: now(), id: ids.id, catalogNumber: ids.catalogNumber, ...options });
    drafts = [...drafts, node];
    selectedId = node.id;
    persist(); notify("add");
    return node;
  }

  function addMany(nodes) {
    if (drafts.length + nodes.length > MAX_NODES) throw new RangeError(`노드는 최대 ${MAX_NODES}개까지 둘 수 있습니다.`);
    drafts = [...drafts, ...nodes];
    if (nodes.length) selectedId = nodes[0].id;
    persist(); notify("add");
    return nodes;
  }

  function duplicate(id) {
    const source = find(id);
    if (!source) return null;
    const ids = nextIds();
    const copy = cloneNode(source, { id: ids.id, catalogNumber: ids.catalogNumber, epoch: now() });
    drafts = [...drafts, copy];
    selectedId = copy.id;
    persist(); notify("add");
    return copy;
  }

  // Replace a node with an updated definition; validation errors are returned, not thrown.
  function update(id, next) {
    const index = drafts.findIndex(node => node.id === id);
    if (index < 0) return ["노드를 찾을 수 없습니다."];
    const candidate = { ...next, id, catalog_number: drafts[index].catalog_number, updated_at: new Date(now()).toISOString() };
    const errors = validateNode(candidate);
    if (errors.length) return errors;
    drafts = drafts.map(node => (node.id === id ? candidate : node));
    persist(); notify("update");
    return [];
  }

  function remove(id) {
    const before = drafts.length;
    drafts = drafts.filter(node => node.id !== id);
    if (drafts.length === before) return false;
    if (selectedId === id) selectedId = drafts[0]?.id || null;
    persist(); notify("remove");
    return true;
  }

  // Remove every member of a formation group; detached members are left alone.
  function removeFormation(formationId) {
    const removed = drafts.filter(node => node.formation?.id === formationId).map(node => node.id);
    if (!removed.length) return [];
    drafts = drafts.filter(node => node.formation?.id !== formationId);
    if (!find(selectedId)) selectedId = drafts[0]?.id || null;
    persist(); notify("remove");
    return removed;
  }

  // Swap the members of a formation for a regenerated set in one change; ids are kept by the
  // caller's id factory so the selection and terminal histories survive a slider move.
  function replaceFormation(formationId, nodes) {
    if (drafts.filter(node => node.formation?.id !== formationId).length + nodes.length > MAX_NODES) throw new RangeError(`노드는 최대 ${MAX_NODES}개까지 둘 수 있습니다.`);
    const others = drafts.filter(node => node.formation?.id !== formationId);
    const firstIndex = drafts.findIndex(node => node.formation?.id === formationId);
    drafts = firstIndex < 0 ? [...others, ...nodes] : [...others.slice(0, firstIndex), ...nodes, ...others.slice(firstIndex)];
    if (!find(selectedId)) selectedId = nodes[0]?.id || drafts[0]?.id || null;
    persist(); notify("update");
    return nodes;
  }

  function clear() {
    drafts = []; selectedId = null;
    persist(); notify("remove");
  }

  function select(id) {
    selectedId = find(id) ? id : null;
    persist(); notify("select");
    return selectedId;
  }

  function deploy(nodes = drafts) {
    deployed = structuredClone(nodes);
    deployedAt = new Date(now()).toISOString();
    persist(); notify("deploy");
    return deployed;
  }

  function recall() {
    deployed = []; deployedAt = null;
    persist(); notify("deploy");
  }

  function isDirty() {
    if (drafts.length !== deployed.length) return true;
    const live = new Map(deployed.map(node => [node.id, JSON.stringify(strip(node))]));
    return drafts.some(node => live.get(node.id) !== JSON.stringify(strip(node)));
  }

  const api = {
    load, add, addMany, duplicate, update, remove, removeFormation, replaceFormation, clear, select, deploy, recall, isDirty, find, nextIds,
    get drafts() { return drafts; },
    get deployed() { return deployed; },
    get deployedAt() { return deployedAt; },
    get selectedId() { return selectedId; },
    get selected() { return find(selectedId); },
    draftItems: () => drafts.map(nodeCatalogItem),
    deployedItems: () => deployed.map(nodeCatalogItem),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return api;
}

// The shared browser instance: one store for the node tab (drafts) and the dashboard (deployed).
export const constellation = createConstellationStore({ storage: globalThis.localStorage || null });
