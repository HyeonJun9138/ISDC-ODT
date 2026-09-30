import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);
const fabricUrl = new URL('communication/browser/data_fabric.js', root).href;
const source = (await readFile(new URL('communication/browser/orchestration.js', root), 'utf8')).replace('/static/communication/data_fabric.js', fabricUrl);
const { ORCHESTRATION_LINK_ID, createOrchestrationClient, resolveEndpoint } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const storageWith = value => ({ getItem: key => (key === 'spacetwin-integration-settings' && value != null ? JSON.stringify(value) : null) });

test('the endpoint is this server unless link L03 points elsewhere', () => {
  assert.equal(ORCHESTRATION_LINK_ID, 'L03');
  assert.deepEqual(resolveEndpoint({ storage: null }), { base: '', placement: 'server', source: 'server' });
  assert.deepEqual(resolveEndpoint({ storage: storageWith({ links: { L03: { host: '10.0.0.9', port: 5103 } } }) }), { base: 'http://10.0.0.9:5103', placement: 'remote', source: 'settings' });
  assert.equal(resolveEndpoint({ storage: storageWith({ links: { L02: { host: '10.0.0.9', port: 5102 } } }) }).placement, 'server', 'the fabric link does not move the orchestration endpoint');
});

test('plan posts the request and errors are typed', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/status')) return { ok: true, status: 200, json: async () => ({ placement: 'embedded' }) };
    if (url.endsWith('/plan') && JSON.parse(options.body).mission.kind === 'nap') return { ok: false, status: 422, json: async () => ({ detail: [{ msg: 'kind must be observe' }] }) };
    if (url.endsWith('/plan')) return { ok: false, status: 503, json: async () => ({ detail: '모듈 응답 없음' }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const client = createOrchestrationClient({ fetchImpl, storage: null });
  assert.deepEqual(await client.status(), { placement: 'embedded' });
  await assert.rejects(client.plan({ time: 't', mission: { kind: 'nap' } }), error => error.status === 422 && error.message === 'kind must be observe');
  await assert.rejects(client.plan({ time: 't', mission: { kind: 'observe' } }), error => error.unavailable === true);
  assert.equal(calls[1].url, '/api/orchestration/plan');
  assert.equal(calls[1].options.method, 'POST');
});
