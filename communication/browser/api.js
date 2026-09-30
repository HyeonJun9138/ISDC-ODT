const jsonHeaders = { "Content-Type": "application/json" };

async function request(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options });
  if (!response.ok) {
    let message = `요청 실패 (${response.status})`;
    try {
      const data = await response.json();
      message = data.detail || message;
    } catch (_) {}
    throw new Error(message);
  }
  return response.json();
}

export const api = {
  bootstrap: () => request("/api/bootstrap"),
  health: () => request("/api/health"),
  satelliteGroups: () => request("/api/satellite-groups"),
  satellites: ({ group = "active", limit = 0, offset = 0, query = "", orbit = "all" } = {}) => request(`/api/satellites?group=${encodeURIComponent(group)}&limit=${limit}&offset=${offset}&q=${encodeURIComponent(query)}&orbit=${encodeURIComponent(orbit)}`),
  satelliteProfile: (catalogNumber) => request(`/api/satellites/${encodeURIComponent(catalogNumber)}`),
  runtimeControl: (action, speed = undefined) => request("/api/runtime/control", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ action, speed }) }),
  runtimeSpeed: (speed) => request("/api/runtime/speed", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ speed: Number(speed) }) }),
  selectScenario: (scenarioId) => request("/api/scenario/select", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ scenario_id: scenarioId }) }),
  // PoC scenario catalogue (VF-01) and the forward-only clock skip of the scenario player.
  scenarios: () => request("/api/scenarios"),
  scenario: (scenarioId) => request(`/api/scenarios/${encodeURIComponent(scenarioId)}`),
  scenarioAdvance: (seconds) => request("/api/scenario/advance", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ seconds: Number(seconds) }) }),
  securityDashboard: (after = 0) => request(`/api/security/dashboard?after=${after}`),
  injectFault: (payload) => request("/api/faults", { method: "POST", headers: jsonHeaders, body: JSON.stringify(payload) }),
  linkBudget: (payload) => request("/api/communication/link-budget", { method: "POST", headers: jsonHeaders, body: JSON.stringify(payload) }),
  route: (source, target, objective = "balanced") => request("/api/communication/route", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ source, target, objective }) }),
  contacts: (hours = 12) => request(`/api/communication/contacts?hours=${hours}`),
  missionAction: (missionId, action) => request("/api/missions/action", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ mission_id: missionId, action }) }),
  missionTask: (payload) => request("/api/missions/tasks", { method: "POST", headers: jsonHeaders, body: JSON.stringify(payload) }),
  validateMission: (missionId) => request(`/api/missions/${encodeURIComponent(missionId)}/validate`),
  integrationProbe: (links) => request("/api/integration/probe", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ links }) }),
  replanMission: (missionId, apply = true) => request("/api/missions/replan", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ mission_id: missionId, apply }) }),
  // Data management module (ICD-01). The dashboard route stamps the ICD time fields on the twin side.
  dataManagementDashboard: ({ limit = 200, after = 0, ...filters } = {}) => request(`/api/data-management/dashboard?${new URLSearchParams({ limit, after, ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) })}`),
  dataManagementRequest: (payload) => request("/api/data-management/console/request", { method: "POST", headers: jsonHeaders, body: JSON.stringify(payload) }),
  dataManagementAction: (payload) => request("/api/data-management/console/action", { method: "POST", headers: jsonHeaders, body: JSON.stringify(payload) }),
  dataManagementSnapshot: () => request("/api/data-management/console/snapshot", { method: "POST", headers: jsonHeaders }),
};

export function telemetrySocket(onMessage, onStatus) {
  let socket;
  let closedByUser = false;
  let retryTimer;

  const connect = () => {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${protocol}://${location.host}/ws/telemetry`);
    onStatus?.("connecting");
    socket.onopen = () => onStatus?.("open");
    socket.onmessage = (event) => {
      try { onMessage(JSON.parse(event.data)); } catch (error) { console.error("telemetry parse", error); }
    };
    socket.onerror = () => onStatus?.("error");
    socket.onclose = () => {
      onStatus?.("closed");
      if (!closedByUser) retryTimer = setTimeout(connect, 1800);
    };
  };
  connect();
  return () => {
    closedByUser = true;
    clearTimeout(retryTimer);
    socket?.close();
  };
}
