// OISL link resolution for the node sandbox: every active terminal picks or keeps a target, its
// acquisition sequence is advanced to the analysis time and the directional results are paired
// into displayable links. Pure with respect to the DOM; terminal histories are passed in and out.
import { activeOislTerminals, equipmentSpec } from "/static/model_library/satellite_nodes.js";
import { advanceTerminal, chooseTarget, createTerminalState, linkGeometry, linkMargin, pairState } from "/static/simulation/oisl.js";

export function terminalKey(nodeId, equipmentId) {
  return `${nodeId}/${equipmentId}`;
}

export function pairKey(a, b) {
  return [String(a), String(b)].sort().join("|");
}

// The orbital plane a node belongs to, for the mounting-role preference below; null outside a formation.
export function planeOf(node) {
  return node?.formation ? `${node.formation.id}:${node.formation.plane}` : null;
}

// Fore and aft terminals link along the owner's own orbital plane, left and right terminals link to
// the neighbouring planes; only a node outside any formation, or an `auto` terminal, considers
// every satellite. In a dense grid an adjacent-plane satellite can sit almost straight ahead and
// closer than the in-plane neighbour, which would otherwise capture the fore terminal and break
// the ring the link policy describes.
export function preferredCandidates(candidates, role, ownerPlane) {
  if (!ownerPlane || role === "auto") return candidates;
  if (role === "fore" || role === "aft") return candidates.filter(candidate => candidate.plane === ownerPlane);
  if (role === "left" || role === "right") return candidates.filter(candidate => candidate.plane && candidate.plane !== ownerPlane);
  return candidates;
}

// nodes: node definitions; states: Map node id -> nodeStateAt result (null when unavailable);
// histories: Map terminal key -> terminal state. Returns { terminals, pairs, histories }.
export function resolveLinks(nodes, states, histories, date) {
  const next = new Map();
  const terminals = [];
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const node of nodes) {
    const ownerState = states.get(node.id) || null;
    const ownerPlane = planeOf(node);
    const candidates = nodes.filter(other => other.id !== node.id).map(other => ({ id: other.id, state: states.get(other.id) || null, plane: planeOf(other) }));
    const taken = new Set();
    for (const item of activeOislTerminals(node)) {
      const spec = equipmentSpec(item);
      const key = terminalKey(node.id, item.id);
      const previous = histories.get(key) || createTerminalState();
      let targetId = null;
      let geometry = null;
      if (ownerState) {
        if (item.target && item.target !== "auto") {
          const targetState = states.get(item.target);
          const exists = byId.has(item.target);
          targetId = exists ? item.target : null;
          geometry = targetState ? linkGeometry(ownerState, targetState, spec, item.role) : null;
          if (targetId && !geometry) geometry = { feasible: false, blockedBy: "range", gimbal: { azimuth: 0, elevation: 0, reachable: false } };
        } else {
          // Prefer the previous target while it stays feasible and still fits the role's plane
          // preference, so links do not flap between neighbours.
          const preferred = preferredCandidates(candidates, item.role, ownerPlane);
          const keepable = previous.target && !taken.has(previous.target) && states.get(previous.target) && preferred.some(candidate => candidate.id === previous.target);
          const keep = keepable ? linkGeometry(ownerState, states.get(previous.target), spec, item.role) : null;
          if (keep?.feasible) { targetId = previous.target; geometry = keep; }
          else {
            // Fall back to any satellite in the sector only when the preferred planes offer nothing.
            const choice = chooseTarget(ownerState, preferred, spec, item.role, taken) || (preferred.length !== candidates.length ? chooseTarget(ownerState, candidates, spec, item.role, taken) : null);
            if (choice) { targetId = choice.id; geometry = choice.geometry; }
          }
        }
      }
      if (targetId) taken.add(targetId);
      const state = advanceTerminal(previous, spec, targetId ? { targetId } : null, geometry, date);
      next.set(key, state);
      const margin = geometry?.feasible ? linkMargin(geometry.range_km, spec) : { margin_db: null, quality: null };
      terminals.push({ nodeId: node.id, equipmentId: item.id, role: item.role, spec, targetId, geometry, state, margin,
        dataRateMbps: state.phase === "tracking" ? spec.data_rate_mbps : 0 });
    }
  }
  const pairs = new Map();
  for (const terminal of terminals) {
    if (!terminal.targetId) continue;
    const key = pairKey(terminal.nodeId, terminal.targetId);
    const entry = pairs.get(key) || { key, a: terminal.nodeId, b: terminal.targetId, directions: [] };
    entry.directions.push(terminal);
    pairs.set(key, entry);
  }
  const pairList = [...pairs.values()].map(entry => {
    const forward = entry.directions.find(direction => direction.nodeId === entry.a);
    const backward = entry.directions.find(direction => direction.nodeId === entry.b);
    const state = pairState(forward?.state.phase, backward?.state.phase);
    const range = entry.directions.find(direction => direction.geometry)?.geometry?.range_km ?? null;
    return { key: entry.key, a: entry.a, b: entry.b, state, range_km: range, directions: entry.directions };
  });
  return { terminals, pairs: pairList, histories: next };
}

export function linkSummary(pairs) {
  const counts = { locked: 0, one_way: 0, acquiring: 0, slewing: 0, blocked: 0, idle: 0 };
  for (const pair of pairs || []) if (pair.state in counts) counts[pair.state] += 1;
  return { ...counts, total: (pairs || []).length };
}
