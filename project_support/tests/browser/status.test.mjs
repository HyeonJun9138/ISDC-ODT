import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCatalog, formatElapsed, telemetryRows } from '../../../user_application/web/scripts/tabs/status.js';

test('the simulation clock formats as T+hh:mm:ss and never goes negative', () => {
  assert.equal(formatElapsed(0), 'T+00:00:00');
  assert.equal(formatElapsed(124.9), 'T+00:02:04');
  assert.equal(formatElapsed(3661), 'T+01:01:01');
  assert.equal(formatElapsed(-5), 'T+00:00:00');
  assert.equal(formatElapsed('abc'), 'T+00:00:00');
});

test('telemetry rows label known SIM fields with units and keep unknown fields verbatim', () => {
  const rows = telemetryRows({ power: 86.24, temperature: 24, ber: 0.0000012, loss_percent: 0.3, extra_metric: 7, note: 'x' });
  assert.deepEqual(rows, [
    ['전력', '86.2 %'], ['온도', '24.0 °C'], ['패킷 손실', '0.30 %'], ['BER', '1.2e-6'], ['extra_metric', '7'], ['note', 'x'],
  ]);
  assert.deepEqual(telemetryRows(null), []);
  assert.deepEqual(telemetryRows({ power: 'bad' }), [['전력', '—']]);
});

test('catalog provenance is described with a tone that reflects freshness', () => {
  assert.deepEqual(describeCatalog(null), { label: '카탈로그 미조회', detail: '—', tone: 'neutral' });
  const live = describeCatalog({ source: 'celestrak-cache', fetched_at: '2026-09-07T10:57:00Z', total: 16510 });
  assert.equal(live.label, 'CelesTrak GP 캐시');
  assert.equal(live.detail, '16,510개 · 수집 UTC 2026-09-07 10:57');
  assert.equal(live.tone, 'success');
  const stale = describeCatalog({ source: 'celestrak-stale', total: 'n/a' });
  assert.equal(stale.tone, 'warning');
  assert.equal(stale.detail, '—개 · 수집 UTC —');
  assert.equal(describeCatalog({ source: 'custom' }).label, 'custom');
});
