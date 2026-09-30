// Browser client for the data fabric ICD (ICD-02). The twin console sends its network state and
// receives link quality, ground paths and store-and-forward state. The endpoint is this server by
// default (which embeds the stand-in or forwards to a module configured on the server); an operator
// may point link L02 in the settings tab at another host, in which case the console talks to that
// host directly. Unreachable endpoints raise errors flagged `unavailable`; nothing is faked.
export const INTEGRATION_SETTINGS_KEY = "spacetwin-integration-settings";
export const FABRIC_LINK_ID = "L02";
const NETWORK_PATH = "/api/data-fabric/network";
const ROUTE_PATH = "/api/data-fabric/route";
const STATUS_PATH = "/api/data-fabric/status";

export function isLocalHost(host) {
  const value = String(host ?? "").trim().toLowerCase();
  if (!value || value === "self" || value === "in-process" || value === "localhost" || value === "::1") return true;
  return value.startsWith("127.");
}

// Resolve where ICD-02 requests go. storage: the browser localStorage (settings tab overrides).
export function resolveEndpoint({ storage = null, protocol = "http:" } = {}) {
  let override = null;
  try {
    const raw = storage?.getItem?.(INTEGRATION_SETTINGS_KEY);
    override = raw ? JSON.parse(raw)?.links?.[FABRIC_LINK_ID] || null : null;
  } catch { override = null; }
  if (override && override.enabled !== false && !isLocalHost(override.host) && Number(override.port) > 0) {
    const scheme = String(override.transport || "").toLowerCase() === "websocket" ? protocol : "http:";
    return { base: `${scheme}//${override.host}:${Number(override.port)}`, placement: "remote", source: "settings" };
  }
  return { base: "", placement: "server", source: "server" };
}

export function createDataFabricClient({ fetchImpl = globalThis.fetch?.bind(globalThis), storage = globalThis.localStorage || null, protocol = globalThis.location?.protocol || "http:" } = {}) {
  const endpoint = () => resolveEndpoint({ storage, protocol });
  async function request(path, options = {}) {
    const target = endpoint();
    let response;
    try {
      response = await fetchImpl(target.base + path, { cache: "no-store", ...options });
    } catch (error) {
      throw Object.assign(new Error(`데이터 패브릭 ${target.base || "(이 서버)"} 연결 실패: ${error.message}`), { unavailable: true, endpoint: target });
    }
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (response.status === 503) throw Object.assign(new Error(payload?.detail || "데이터 패브릭 응답 없음"), { unavailable: true, endpoint: target });
    if (!response.ok) throw Object.assign(new Error(payload?.detail || `데이터 패브릭 요청 실패 (${response.status})`), { status: response.status, endpoint: target });
    return payload;
  }
  const json = body => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return {
    endpoint,
    update: snapshot => request(NETWORK_PATH, json(snapshot)),
    route: (source, target, objective = "balanced") => request(ROUTE_PATH, json({ source, target, objective })),
    status: () => request(STATUS_PATH),
  };
}
