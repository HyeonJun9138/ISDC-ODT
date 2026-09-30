import test from 'node:test';
import assert from 'node:assert/strict';
import { componentRows, elapsedLabel, eventRow, formatGb, formatSize, gradeOf, mergeEvents, moduleBadge, nodeRow, objectRow, replicaSummary, stageRows, tileRows, percent, deploymentView, acceptsDeploymentReport } from '../../../user_application/web/scripts/data_management/view_model.js';

test('null stability and fractions remain unevaluated, never zero or 100',()=>{
  assert.deepEqual(gradeOf({score:null,grade:'waiting'}),{score:null,label:'평가 대기',tone:'neutral'});
  assert.equal(percent(null),'—');
  assert.equal(componentRows({components:{availability:null}})[0].fraction,null);
  assert.equal(tileRows({capacity:{used_ratio:null}}).find(x=>x.key==='capacity').value,'—');
  assert.equal(nodeRow({id:'N',capacity_gb:0,used_ratio:null,available:false}).ratio,null);
});
test('deployment display distinguishes empty deployment, missing storage and failed module',()=>{
  const empty={deployment:{scope_id:'R:D',nodes:[]},module:{reachable:true},nodes:[],overview:{metrics:{objects:0}}};
  assert.match(deploymentView(empty).message,/배치된 SDC/);
  assert.equal(deploymentView(empty).canOperate,false);
  const noStorage={...empty,deployment:{...empty.deployment,nodes:[{id:'N'}]},nodes:[{id:'N',capacity_gb:0,available:false}]};
  assert.match(deploymentView(noStorage).message,/저장/);
  const ready={...noStorage,nodes:[{id:'N',capacity_gb:2000,available:true}],overview:{metrics:{objects:1}}};
  assert.equal(deploymentView(ready).canOperate,true);
  assert.equal(deploymentView(ready,'동기화 실패').canOperate,false);
  assert.match(deploymentView({...empty,module:{reachable:false}}).message,/실패/);
});
test('older deployment and runtime reports cannot replace the current scope',()=>{
  const expected={scope_id:'R:D2',revision:2};
  const payload={deployment:{scope_id:'R:D1',revision:1},runtime:{run_id:'R'}};
  assert.equal(acceptsDeploymentReport(payload,expected,'R'),false);
  payload.deployment={scope_id:'R:D2',revision:2};
  assert.equal(acceptsDeploymentReport(payload,expected,'R'),true);
  assert.equal(acceptsDeploymentReport(payload,expected,'NEW'),false);
  payload.deployment={scope_id:'R:D3',revision:3};
  assert.equal(acceptsDeploymentReport(payload,expected,'R'),true);
});

test('sizes, capacities and simulation times format with sensible units', () => {
  assert.equal(formatSize(0.02), '20 KB');
  assert.equal(formatSize(12.34), '12.3 MB');
  assert.equal(formatSize(850), '850 MB');
  assert.equal(formatSize(2500), '2.5 GB');
  assert.equal(formatSize(1_500_000), '1.50 PB');
  assert.equal(formatSize('x'), '—');
  assert.equal(formatGb(0.51), '0.5 GB');
  assert.equal(formatGb(2_000_000), '2.00 PB');
  assert.equal(formatGb(200_000), '200.0 TB');
  assert.equal(elapsedLabel(3661.9), 'T+01:01:01');
  assert.equal(elapsedLabel(-4), 'T+00:00:00');
});

test('stability grade and weighted components map to tones', () => {
  assert.deepEqual(gradeOf({ score: 93.2, grade: 'stable' }), { label: '안정', tone: 'ok', score: 93.2 });
  assert.deepEqual(gradeOf(null), { label: '—', tone: 'neutral', score: null });
  const rows = componentRows({ components: { availability: 1, replication: 0.75, integrity: 0.5, service: 0.95 } });
  assert.deepEqual(rows.map(row => [row.key, row.tone]), [['availability', 'ok'], ['replication', 'warning'], ['integrity', 'danger'], ['service', 'ok'], ['headroom', 'neutral']]);
  assert.equal(rows.reduce((sum, row) => sum + row.weight, 0), 1);
});

test('tiles and pipeline stages summarise the overview without inventing counts', () => {
  const overview = { metrics: { ingest_mbps: 12.345, objects: 40, replicas: 100, verified_replicas: 97, damaged_replicas: 1, healing_jobs: 2 },
    capacity: { used_ratio: 0.82 }, objects_by_status: { degraded: 3, critical: 0 }, stages: { ingested: 20, filtered: 2, stored: 18, replicated: 15, served: 9, failed: 1 } };
  const tiles = tileRows(overview);
  assert.equal(tiles.find(tile => tile.key === 'ingest').value, '12.3 Mbps');
  assert.equal(tiles.find(tile => tile.key === 'capacity').value, '82.0 %');
  assert.equal(tiles.find(tile => tile.key === 'capacity').tone, 'warning');
  assert.equal(tiles.find(tile => tile.key === 'degraded').value, '3 · 0');
  assert.equal(tiles.find(tile => tile.key === 'healing').tone, 'warning');
  const stages = stageRows(overview);
  assert.deepEqual(stages.map(stage => stage.count), [20, 18, 18, 15, 9]);
  assert.equal(stages[0].note, '2건 필터링');
  assert.equal(stages[4].note, '1건 실패');
  assert.deepEqual(stageRows(null).map(stage => stage.count), [0, 0, 0, 0, 0]);
});

test('object and node rows classify replication and integrity', () => {
  const obj = { id: 'OBJ-1', label: 'SAT-01 imagery #3', class: 'imagery', source: 'SAT-01', size_mb: 620, tier: 'hot', status: 'degraded', created_s: 90,
    replicas: [{ node: 'SAT-01', state: 'verified' }, { node: 'DC-SEOUL', state: 'corrupt' }, { node: 'DC-JEJU', state: 'syncing' }] };
  assert.deepEqual(replicaSummary(obj), { verified: 1, total: 3, damaged: 1, pending: 1, unreachable: 0 });
  const row = objectRow(obj, 3);
  assert.equal(row.classLabel, '관측 영상');
  assert.equal(row.replicas, '1 / 3');
  assert.equal(row.replicaTone, 'danger');
  assert.equal(row.integrity, '손상 1');
  assert.equal(row.statusLabel, '복제 부족');
  assert.equal(row.created, 'T+00:01:30');
  const healthy = objectRow({ ...obj, status: 'healthy', replicas: [{ state: 'verified' }, { state: 'verified' }] }, 2);
  assert.equal(healthy.integrity, '검증됨');
  assert.equal(healthy.replicaTone, 'ok');
  const node = nodeRow({ id: 'DC-SEOUL', name: '서울', kind: 'core', used_gb: 1500, capacity_gb: 2000, used_ratio: 0.75, objects: 12, state: 'ok', available: true });
  assert.equal(node.kind, '지상 코어');
  assert.equal(node.used, '1.5 TB');
  assert.equal(node.tone, 'ok');
  assert.equal(nodeRow({ id: 'X', kind: 'edge', state: 'down', available: false, reason: 'power_drop (high)' }).tone, 'danger');
});

test('events merge newest first without duplicates and the module badge reads placement', () => {
  const existing = [{ sequence: 3, kind: 'heal_started' }, { sequence: 2, kind: 'ingest_completed' }];
  const incoming = [{ sequence: 3, kind: 'heal_started' }, { sequence: 4, kind: 'heal_completed' }];
  assert.deepEqual(mergeEvents(existing, incoming).map(event => event.sequence), [4, 3, 2]);
  assert.equal(mergeEvents(existing, incoming, 2).length, 2);
  assert.equal(eventRow({ sequence: 4, kind: 'heal_completed', severity: 'info', message: 'ok', time_s: 61 }).kind, '자가복구 완료');
  assert.equal(eventRow({ sequence: 5, kind: 'custom', message: 'x', time_s: 0 }).severity, 'info');
  assert.deepEqual(moduleBadge({ placement: 'embedded', reachable: true }), { label: '내장 임시 구현 · ICD-01', tone: 'ok' });
  assert.deepEqual(moduleBadge({ placement: 'remote', reachable: false }), { label: '외부 모듈 응답 없음', tone: 'danger' });
  assert.equal(moduleBadge({ placement: 'remote', reachable: true, endpoint: 'http://dm:8793' }).label, '외부 · http://dm:8793');
  assert.equal(moduleBadge(null).tone, 'neutral');
});
