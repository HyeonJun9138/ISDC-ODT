import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);
const librarySource = (await readFile(new URL('digital_twin/model_library/browser/satellite_nodes.js', root), 'utf8'))
  .replace(/\/static\/simulation\/satellite_dynamics\.js(?:\?[^'\"]*)?/, new URL('digital_twin/simulation/browser/satellite_dynamics.js', root).href);
const libraryUrl = `data:text/javascript;base64,${Buffer.from(librarySource).toString('base64')}`;
const storeSource = (await readFile(new URL('user_application/web/scripts/nodes/constellation.js', root), 'utf8'))
  .replace(/\/static\/model_library\/satellite_nodes\.js(?:\?[^'\"]*)?/, libraryUrl);
const { createConstellationStore } = await import(`data:text/javascript;base64,${Buffer.from(storeSource).toString('base64')}`);
const module = await import('../../../user_application/web/scripts/nodes/data_deployment.js');
const empty = () => ({ deployment_id: null, revision: 0, nodes: [], run_id: 'RUN-1', scope_id: 'RUN-1:none' });
const ok = body => ({ ok: true, status: 200, json: async () => body });
const reply = payload => ({ ...payload, revision: payload.expected_revision + 1, run_id: 'RUN-1', scope_id: `RUN-1:${payload.deployment_id}` });

test('HTML fallback is reported as a missing deployment API and preserves the draft', async () => {
  const { client, constellation } = fixture(async () => new Response('<!doctype html><html>SpaceTwin</html>', {status:200,headers:{'Content-Type':'text/html'}}));
  constellation.add({name:'Keep me'});
  await assert.rejects(client.initialize(), error => /배치 API/.test(error.message) && /HTML/.test(error.message) && !/Unexpected token/.test(error.message));
  assert.equal(constellation.drafts.length,1);
  assert.equal(constellation.deployed.length,0);
});

test('malformed JSON is a response error rather than a JavaScript parsing exception', async () => {
  const {client}=fixture(async()=>new Response('{broken', {headers:{'Content-Type':'application/json'}}));
  await assert.rejects(client.initialize(),/배치 API.*JSON 응답/);
});
function fixture(fetchImpl) {
  assert.equal(typeof module.createDataDeployment, 'function', '서버 수락 흐름 클라이언트가 있어야 한다');
  const constellation = createConstellationStore();
  const events = [];
  let ids = 0;
  const client = module.createDataDeployment({ constellation, fetchImpl, createId: () => `DEP-${++ids}`, emit: (type, data) => events.push({ type, data }) });
  return { client, constellation, events };
}

test('deployment waits for server acceptance and commits the sent snapshot rather than later draft edits', async () => {
  let accept, sent;
  const { client, constellation, events } = fixture(async (_url, options) => {
    if (options.method === 'GET') return ok(empty());
    sent = JSON.parse(options.body);
    return new Promise(resolve => { accept = () => resolve(ok(reply(sent))); });
  });
  await client.initialize();
  const node = constellation.add({ name: 'Accepted', bus: 'eo_small' });
  const pending = client.deploy();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.state.busy, true);
  assert.deepEqual(constellation.deployed, []);
  assert.equal(events.filter(event => event.type === 'nodes:deployed').length, 0);
  assert.deepEqual(Object.keys(sent.nodes[0]), ['id', 'name', 'mode', 'equipment']);
  assert.deepEqual(Object.keys(sent.nodes[0].equipment[0]), ['id', 'catalog', 'enabled']);
  constellation.update(node.id, { ...node, name: 'Later draft' });
  accept();
  await pending;
  assert.equal(constellation.deployed[0].name, 'Accepted');
  assert.equal(constellation.drafts[0].name, 'Later draft');
  assert.equal(client.state.busy, false);
  assert.equal(events.filter(event => event.type === 'nodes:deployed').length, 1);
  assert.equal(events.at(-1).type, 'data:deployment');
});

test('network failure preserves deployed nodes and drafts and retries the identical deployment command', async () => {
  const bodies = [];
  const { client, constellation } = fixture(async (_url, options) => {
    if (options.method === 'GET') return ok(empty());
    const body = JSON.parse(options.body); bodies.push(body);
    if (bodies.length === 1) throw new TypeError('offline');
    return ok(reply(body));
  });
  await client.initialize();
  const old = constellation.add({ name: 'Before' }); constellation.deploy();
  constellation.update(old.id, { ...old, name: 'After' });
  await assert.rejects(client.deploy(), /offline/);
  assert.equal(client.state.busy, false);
  assert.equal(constellation.deployed[0].name, 'Before');
  assert.equal(constellation.drafts[0].name, 'After');
  await client.deploy();
  assert.deepEqual(bodies[1], bodies[0]);
  assert.equal(constellation.deployed[0].name, 'After');
});

test('initial restoration uses the deployed record only and runs only against a pristine server', async () => {
  const bodies = [];
  const { client, constellation } = fixture(async (_url, options) => {
    if (options.method === 'GET') return ok(empty());
    const body = JSON.parse(options.body); bodies.push(body); return ok(reply(body));
  });
  const node = constellation.add({ name: 'Stored deployment' }); constellation.deploy();
  constellation.update(node.id, { ...node, name: 'Unapplied edit' });
  await client.initialize(); await client.initialize();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].nodes[0].name, 'Stored deployment');
  assert.equal(constellation.drafts[0].name, 'Unapplied edit');
});

test('an existing server configuration is not automatically replaced by this browser', async () => {
  const requests = [];
  const { client, constellation } = fixture(async (_url, options) => {
    requests.push(options.method);
    return ok({ ...empty(), deployment_id: 'OTHER', revision: 4, nodes: [{ id: 'REMOTE', name: 'Other browser', mode: 'active', equipment: [] }] });
  });
  constellation.add({ name: 'Local' }); constellation.deploy();
  await client.initialize();
  assert.deepEqual(requests, ['GET']);
  assert.equal(client.state.syncRequired, true);
  assert.equal(client.state.server.revision, 4);
  assert.equal(constellation.deployed[0].name, 'Local');
});

test('recall failure keeps the local deployment and success removes only the deployed record', async () => {
  let fail = true;
  const { client, constellation } = fixture(async (_url, options) => {
    if (options.method === 'GET') return ok(empty());
    if (fail) return { ok: false, status: 503, json: async () => ({ detail: '모듈 동기화 실패' }) };
    return ok(reply(JSON.parse(options.body)));
  });
  await client.initialize(); constellation.add({ name: 'Keep draft' }); constellation.deploy();
  await assert.rejects(client.recall(), /모듈 동기화 실패/);
  assert.equal(constellation.deployed.length, 1);
  fail = false; await client.recall();
  assert.equal(constellation.deployed.length, 0);
  assert.equal(constellation.drafts.length, 1);
});

test('version conflict refreshes the server version without silently retrying or mutating local nodes', async () => {
  let gets = 0, posts = 0;
  const { client, constellation } = fixture(async (_url, options) => {
    if (options.method === 'GET') return ok({ ...empty(), revision: gets++ ? 7 : 0, deployment_id: gets > 1 ? 'REMOTE' : null });
    posts++;
    return { ok: false, status: 409, json: async () => ({ detail: 'version conflict' }) };
  });
  await client.initialize(); constellation.add({ name: 'Draft' });
  await assert.rejects(client.deploy(), error => error.status === 409);
  assert.equal(posts, 1);
  assert.equal(client.state.server.revision, 7);
  assert.equal(client.state.syncRequired, true);
  assert.equal(constellation.deployed.length, 0);
  assert.equal(constellation.drafts.length, 1);
});

test('overlapping deploy and recall requests run in order using the accepted revision', async () => {
  const posts = [];
  const { client, constellation } = fixture(async (_url, options) => {
    if (options.method === 'GET') return ok(empty());
    const body = JSON.parse(options.body); posts.push(body);
    await new Promise(resolve => setImmediate(resolve));
    return ok(reply(body));
  });
  await client.initialize(); constellation.add({ name: 'A' });
  await Promise.all([client.deploy(), client.recall()]);
  assert.deepEqual(posts.map(item => item.expected_revision), [0, 1]);
  assert.deepEqual(posts.map(item => item.nodes.length), [1, 0]);
  assert.deepEqual(constellation.deployed, []);
});

test('deployment identifiers remain available on non-secure HTTP origins without crypto.randomUUID', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
  try {
    const constellation = createConstellationStore();
    constellation.add({ name: 'HTTP origin' });
    const client = module.createDataDeployment({ constellation, fetchImpl: async (_url, options) => options.method === 'GET'
      ? ok(empty()) : ok(reply(JSON.parse(options.body))) });
    await client.initialize();
    const response = await client.deploy();
    assert.equal(typeof response.deployment_id, 'string');
    assert.ok(response.deployment_id.length > 10);
    assert.equal(constellation.deployed.length, 1);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else delete globalThis.crypto;
  }
});
