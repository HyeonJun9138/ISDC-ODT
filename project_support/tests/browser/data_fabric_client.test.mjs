import test from 'node:test';
import assert from 'node:assert/strict';
import { FABRIC_LINK_ID, INTEGRATION_SETTINGS_KEY, createDataFabricClient, isLocalHost, resolveEndpoint } from '../../../communication/browser/data_fabric.js';

const storageWith = value => ({ getItem: key => (key === INTEGRATION_SETTINGS_KEY && value != null ? JSON.stringify(value) : null) });

test('the endpoint is this server unless the settings tab points link L02 at another host', () => {
  assert.deepEqual(resolveEndpoint({ storage: null }), { base: '', placement: 'server', source: 'server' });
  assert.deepEqual(resolveEndpoint({ storage: storageWith({ links: { [FABRIC_LINK_ID]: { host: '127.0.0.1', port: 5102 } } }) }).placement, 'server');
  assert.deepEqual(resolveEndpoint({ storage: storageWith({ links: { [FABRIC_LINK_ID]: { host: '10.0.0.7', port: 5102, transport: 'TCP' } } }) }), { base: 'http://10.0.0.7:5102', placement: 'remote', source: 'settings' });
  assert.equal(resolveEndpoint({ storage: storageWith({ links: { [FABRIC_LINK_ID]: { host: '10.0.0.7', port: 5102, enabled: false } } }) }).placement, 'server');
  assert.equal(resolveEndpoint({ storage: { getItem: () => '{bad json' } }).placement, 'server');
  assert.ok(isLocalHost('self') && isLocalHost('localhost') && isLocalHost('127.0.0.1') && isLocalHost(''));
  assert.equal(isLocalHost('192.168.0.3'), false);
});

test('requests carry the message, and 503 or network failures are flagged unavailable', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/status')) return { ok: true, status: 200, json: async () => ({ placement: 'embedded' }) };
    if (url.endsWith('/route')) return { ok: false, status: 400, json: async () => ({ detail: '출발지 없음' }) };
    return { ok: false, status: 503, json: async () => ({ detail: '패브릭 응답 없음' }) };
  };
  const client = createDataFabricClient({ fetchImpl, storage: null });
  assert.deepEqual(await client.status(), { placement: 'embedded' });
  assert.equal(calls[0].url, '/api/data-fabric/status');
  await assert.rejects(client.update({ time: 't', nodes: [], links: [] }), error => error.unavailable === true && /응답 없음/.test(error.message));
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), { time: 't', nodes: [], links: [] });
  await assert.rejects(client.route('A', 'B', 'latency'), error => error.status === 400 && !error.unavailable && error.message === '출발지 없음');
  assert.deepEqual(JSON.parse(calls[2].options.body), { source: 'A', target: 'B', objective: 'latency' });
  const offline = createDataFabricClient({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); }, storage: storageWith({ links: { L02: { host: '10.0.0.7', port: 5102 } } }) });
  await assert.rejects(offline.status(), error => error.unavailable === true && error.endpoint.base === 'http://10.0.0.7:5102');
});
