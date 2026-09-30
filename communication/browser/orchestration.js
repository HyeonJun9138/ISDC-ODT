// Browser client for the constellation operations ICD (ICD-03). The mission console sends one
// mission request with the windows the twin computed and receives the assigned tasks and verdict.
// The endpoint is this server by default (embedded stand-in or a module the server forwards to);
// an operator may point link L03 in the settings tab at another host, in which case the console
// talks to that host directly. Unreachable endpoints raise errors flagged `unavailable`.
import { INTEGRATION_SETTINGS_KEY, isLocalHost } from "/static/communication/data_fabric.js";

export const ORCHESTRATION_LINK_ID = "L03";
const PLAN_PATH = "/api/orchestration/plan";
const COMMIT_PATH = "/api/orchestration/commit";
const STATUS_PATH = "/api/orchestration/status";

export function resolveEndpoint({ storage = null, protocol = "http:" } = {}) {
  let override = null;
  try {
    const raw = storage?.getItem?.(INTEGRATION_SETTINGS_KEY);
    override = raw ? JSON.parse(raw)?.links?.[ORCHESTRATION_LINK_ID] || null : null;
  } catch { override = null; }
  if (override && override.enabled !== false && !isLocalHost(override.host) && Number(override.port) > 0) {
    const scheme = String(override.transport || "").toLowerCase() === "websocket" ? protocol : "http:";
    return { base: `${scheme}//${override.host}:${Number(override.port)}`, placement: "remote", source: "settings" };
  }
  return { base: "", placement: "server", source: "server" };
}

export function createOrchestrationClient({ fetchImpl = globalThis.fetch?.bind(globalThis), storage = globalThis.localStorage || null, protocol = globalThis.location?.protocol || "http:" } = {}) {
  const endpoint = () => resolveEndpoint({ storage, protocol });
  async function request(path, options = {}) {
    const target = endpoint();
    let response;
    try {
      response = await fetchImpl(target.base + path, { cache: "no-store", ...options });
    } catch (error) {
      throw Object.assign(new Error(`군집 운용 모듈 ${target.base || "(이 서버)"} 연결 실패: ${error.message}`), { unavailable: true, endpoint: target });
    }
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (response.status === 503) throw Object.assign(new Error(payload?.detail || "군집 운용 모듈 응답 없음"), { unavailable: true, endpoint: target });
    if (!response.ok) {
      const detail = Array.isArray(payload?.detail) ? payload.detail.map(item => item.msg || JSON.stringify(item)).join("; ") : payload?.detail;
      throw Object.assign(new Error(detail || `군집 운용 요청 실패 (${response.status})`), { status: response.status, endpoint: target });
    }
    return payload;
  }
  return {
    endpoint,
    plan: body => request(PLAN_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    // OR-03: the operator's commit or abort of a plan, so the module holds the assigned intervals.
    commit: body => request(COMMIT_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    status: () => request(STATUS_PATH),
  };
}
