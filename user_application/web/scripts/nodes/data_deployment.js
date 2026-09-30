// The accepted server configuration drives data operations. The local constellation remains a
// browser display copy; requests carry only equipment identities, never expanded model values.
const ENDPOINT = '/api/data-management/deployment';
const clone = value => structuredClone(value);

function deploymentNodes(nodes) {
  return nodes.map(node => ({
    id: node.id, name: node.name, mode: node.mode,
    equipment: (node.equipment || []).map(item => ({ id: item.id, catalog: item.catalog, enabled: item.enabled !== false })),
  }));
}

function signature(nodes) {
  return JSON.stringify(deploymentNodes(nodes).sort((a, b) => a.id.localeCompare(b.id)).map(node => ({
    ...node, equipment: node.equipment.sort((a, b) => a.id.localeCompare(b.id)),
  })));
}

export function createDataDeployment({
  constellation, fetchImpl = (...args) => globalThis.fetch(...args),
  // randomUUID is unavailable on the trusted-network HTTP origin used by this app.
  createId = () => globalThis.crypto?.randomUUID?.()
    || `DEP-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`,
  emit = () => {}, onChange = () => {},
} = {}) {
  let server = null, error = null, syncRequired = false;
  let queue = Promise.resolve(), queued = 0, initialized = false, initializing = null;
  let pending = null;
  const listeners = new Set();
  const state = () => ({ server: clone(server), error, syncRequired, busy: queued > 0 });
  const changed = () => { const snapshot = state(); onChange(snapshot); listeners.forEach(listener => listener(snapshot)); };

  function serial(action) {
    queued++; changed();
    const result = queue.then(async () => {
      error = null; changed();
      try { return await action(); }
      catch (failure) { error = failure.message || '서버 배치 동기화 실패'; throw failure; }
      finally { queued--; changed(); }
    });
    queue = result.catch(() => {});
    return result;
  }

  async function request(method, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetchImpl(ENDPOINT, {
        method, signal: controller.signal, cache: 'no-store',
        ...(payload ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}),
      });
      const contentType = response.headers?.get('content-type') || '';
      if(contentType.includes('text/html')) {
        throw new Error(`현재 접속 서버가 배치 API 대신 HTML 화면을 반환했습니다 (${ENDPOINT}, HTTP ${response.status}). 이 서버에 배치 API가 등록되어 있는지 확인해야 합니다.`);
      }
      let body;
      try { body = await response.json(); }
      catch { throw new Error(`배치 API의 JSON 응답을 읽을 수 없습니다 (${ENDPOINT}, HTTP ${response.status}). 서버 응답을 확인해야 합니다.`); }
      if (!response.ok) {
        const failure = new Error(typeof body.detail === 'string' ? body.detail : `서버 배치 동기화 실패 (${response.status})`);
        failure.status = response.status;
        throw failure;
      }
      if (!Number.isInteger(body.revision) || body.revision < 0 || !Array.isArray(body.nodes)
        || typeof body.run_id !== 'string' || typeof body.scope_id !== 'string'
        || !(body.deployment_id === null || typeof body.deployment_id === 'string')) {
        throw new Error('서버 배치 응답 형식이 올바르지 않습니다.');
      }
      return body;
    } finally { clearTimeout(timer); }
  }

  async function read() {
    const response = await request('GET');
    server = clone(response);
    syncRequired = signature(server.nodes) !== signature(constellation.deployed);
    emit('data:deployment', clone(server)); changed();
    return clone(server);
  }

  async function apply(nodes, kind) {
    if (!server) {
      await read();
      // A first failed GET must not turn the next button click into an unconfirmed overwrite.
      if (syncRequired && server.revision !== 0) {
        throw new Error('서버에 다른 배치가 있습니다. 현재 구성을 확인한 후 다시 배치해 주세요.');
      }
    }
    const projected = deploymentNodes(nodes);
    const key = signature(projected);
    if (!pending || pending.key !== key || pending.kind !== kind) {
      pending = {
        key, kind,
        payload: {
          deployment_id: server.deployment_id && signature(server.nodes) === key ? server.deployment_id : createId(),
          expected_revision: server.revision, nodes: projected,
        },
      };
    }
    let response;
    try { response = await request('POST', pending.payload); }
    catch (failure) {
      if (failure.status === 409) {
        pending = null;
        try { await read(); } catch { server = null; }
        syncRequired = true;
      }
      throw failure;
    }
    if (response.deployment_id !== pending.payload.deployment_id || signature(response.nodes) !== key) {
      throw new Error('서버가 수락한 배치와 요청한 구성이 다릅니다. 다시 동기화해 주세요.');
    }
    server = clone(response); pending = null; syncRequired = false;
    if (kind === 'recall') constellation.recall();
    else constellation.deploy(nodes);
    emit('nodes:deployed', { nodes: clone(constellation.deployed), items: constellation.deployedItems() });
    emit('data:deployment', clone(server));
    return clone(server);
  }

  return {
    get state() { return state(); },
    initialize() {
      if (initialized) return Promise.resolve(clone(server));
      if (initializing) return initializing;
      initializing = serial(async () => {
        await read();
        if (server.revision === 0 && server.deployment_id === null && constellation.deployed.length) {
          await apply(clone(constellation.deployed), 'restore');
        }
        initialized = true;
        return clone(server);
      }).finally(() => { initializing = null; });
      return initializing;
    },
    refresh: () => serial(read),
    deploy() { const nodes = clone(constellation.drafts); return serial(() => apply(nodes, 'deploy')); },
    recall: () => serial(() => apply([], 'recall')),
    // Several owners (the node tab, the scenario player) watch one client; each gets state copies.
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
