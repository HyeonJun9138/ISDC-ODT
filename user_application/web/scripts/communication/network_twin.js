// The console's single owner of the digital twin's network state: satellite states, OISL terminal
// histories and pairs, the ICD-02 network message and the data fabric's last answer. The
// communication tab drives it while it is visible; the scenario player drives it while another tab
// is visible. Both call tick() with the analysis time and exchange() to send the message, so the
// terminal acquisition history advances once per instant and the fabric receives one message per
// second. The twin computes the state (satellite_dynamics, oisl, ground_links); the fabric judges
// it. Nothing here invents a fabric verdict when the module does not answer.
import { nodeStateAt } from "/static/simulation/satellite_dynamics.js";
import { buildNetworkSnapshot } from "/static/simulation/network_snapshot.js";
import { createDataFabricClient } from "/static/communication/data_fabric.js";
import { resolveLinks } from "../nodes/links.js?v=20260908-planes1";

// The OISL acquisition sequence is deterministic in analysis time, so a fresh history is advanced
// from two minutes back in two steps; without this the mesh reads as empty for ~25 s at start.
export const PRIME_STEPS_S = [120, 60];
export const MIN_EXCHANGE_INTERVAL_MS = 900;

export function createNetworkTwin({ fabric = null, clock = () => performance.now() } = {}) {
  const client = fabric || createDataFabricClient();
  const listeners = new Set();
  let histories = new Map();
  let last = { at: null, key: "", nodes: [], states: new Map(), links: { terminals: [], pairs: [], histories }, snapshot: null, twinLinks: new Map() };
  let report = null;
  let fabricLinks = new Map();
  let fabricNodes = new Map();
  let fabricState = { placement: null, endpoint: "", implementation: null, version: null, reachable: null, rtt: null, error: null, sequence: null, lastSentAt: null };
  let inFlight = null;
  let lastSentAt = null;

  const notify = event => listeners.forEach(listener => listener(event, api));

  function prime(nodes, date) {
    if (!nodes.length || histories.size) return;
    for (const seconds of PRIME_STEPS_S) {
      const at = new Date(date.getTime() - seconds * 1000);
      const states = new Map(nodes.map(node => [node.id, nodeStateAt(node.orbit, at)]));
      histories = resolveLinks(nodes, states, histories, at).histories;
    }
  }

  // Advance the twin to `date`. The same instant with the same inputs returns the cached result so
  // two drivers in the same second do not advance the acquisition history twice.
  function tick(date, { nodes = [], stations = [], faults = [] } = {}) {
    const at = date instanceof Date ? date.getTime() : Number(date);
    const key = `${at}|${nodes.map(node => `${node.id}:${node.updated_at}`).join(",")}|${stations.map(station => station.id).join(",")}|${faults.map(fault => `${fault.id}:${fault.active}`).join(",")}`;
    if (last.at === at && last.key === key) return last;
    const when = new Date(at);
    prime(nodes, when);
    const states = new Map(nodes.map(node => [node.id, nodeStateAt(node.orbit, when)]));
    const links = resolveLinks(nodes, states, histories, when);
    histories = links.histories;
    const snapshot = buildNetworkSnapshot({ date: when, nodes, states, pairs: links.pairs, stations, faults });
    last = { at, key, nodes, states, links, snapshot, twinLinks: new Map(snapshot.links.map(link => [link.id, link])) };
    notify("tick");
    return last;
  }

  // Send the last message to the fabric (DF-01) and keep its answer (DF-02). At most one message is
  // in flight and consecutive sends are at least MIN_EXCHANGE_INTERVAL_MS apart.
  function exchange({ force = false } = {}) {
    if (!last.snapshot) return Promise.resolve(report);
    if (inFlight) return inFlight;
    if (!force && lastSentAt !== null && clock() - lastSentAt < MIN_EXCHANGE_INTERVAL_MS) return Promise.resolve(report);
    const started = clock();
    lastSentAt = started;
    inFlight = (async () => {
      try {
        const answer = await client.update(last.snapshot);
        report = answer;
        fabricLinks = new Map((answer.links || []).map(link => [link.id, link]));
        fabricNodes = new Map((answer.nodes || []).map(node => [node.id, node]));
        fabricState = { ...fabricState, reachable: true, rtt: Math.round(clock() - started), error: null, sequence: answer.sequence, implementation: answer.implementation, version: answer.version, lastSentAt: started };
      } catch (error) {
        report = null; fabricLinks = new Map(); fabricNodes = new Map();
        fabricState = { ...fabricState, reachable: false, rtt: null, error: error.message, lastSentAt: started };
      } finally {
        inFlight = null;
      }
      notify("report");
      return report;
    })();
    return inFlight;
  }

  async function route(source, target, objective = "balanced") {
    return client.route(source, target, objective);
  }

  async function pollStatus() {
    try {
      const status = await client.status();
      const endpoint = client.endpoint();
      fabricState = { ...fabricState, placement: endpoint.placement === "remote" ? "remote" : status.placement, endpoint: endpoint.placement === "remote" ? endpoint.base : status.endpoint,
        implementation: status.implementation, version: status.version, reachable: status.reachable !== false ? fabricState.reachable ?? true : false, error: status.reachable === false ? status.detail : fabricState.error };
    } catch (error) {
      fabricState = { ...fabricState, reachable: false, error: error.message, endpoint: client.endpoint().base || fabricState.endpoint };
    }
    notify("status");
    return fabricState;
  }

  // Drop the terminal histories of nodes that left the deployed set (or of one node after an edit).
  function pruneHistories(keep) {
    const ids = keep instanceof Set ? keep : new Set(keep || []);
    for (const key of [...histories.keys()]) if (!ids.has(key.split("/")[0])) histories.delete(key);
  }

  function resetHistories() { histories = new Map(); last = { ...last, at: null, key: "" }; }

  const api = {
    tick, exchange, route, pollStatus, pruneHistories, resetHistories, fabric: client,
    get last() { return last; }, get histories() { return histories; }, get report() { return report; },
    get fabricLinks() { return fabricLinks; }, get fabricNodes() { return fabricNodes; }, get fabricState() { return fabricState; },
    reachable: () => fabricState.reachable === true,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return api;
}

export const networkTwin = createNetworkTwin();
