import test from 'node:test';
import assert from 'node:assert/strict';
import { securityView, transportView } from '../../../user_application/web/scripts/security/view_model.js';

const report = {module:{reachable:true}, overview:{observation:{source:'SIM',running:true,auth_percent:99.8,throughput_mbps:42,loss_percent:0.3},verdict:{authentication:'nominal',integrity:'unknown',encryption:'unknown'},threshold:99}};
const live = {now:2000,receivedAt:1000,telemetryAt:1000,socket:'open'};
test('security display starts unknown, never animates missing evidence',()=>{
  assert.equal(securityView(null,{}).animate,false);
  assert.equal(securityView(null,{}).authentication,'미확인');
});
test('display consumes module verdict, not a duplicate authentication rule',()=>{
  const input=structuredClone(report); input.overview.observation.auth_percent=10;
  assert.equal(securityView(input,live).authentication,'SIM 기준 충족');
  assert.equal(securityView(input,live).integrity,'검증 입력 없음');
  assert.equal(securityView(input,live).animate,true);
  assert.equal(input.overview.observation.auth_percent,10);
});
test('disconnection, stale data, errors, pause and missing throughput stop animation',()=>{
  for(const patch of [{now:12000},{socket:'closed'},{error:'실패'},{telemetryAt:null}]) assert.equal(securityView(report,{...live,...patch}).animate,false);
  for(const patch of [{running:false},{throughput_mbps:0},{throughput_mbps:null},{throughput_mbps:NaN}]){
    const input=structuredClone(report); Object.assign(input.overview.observation,patch);
    assert.equal(securityView(input,live).animate,false);
  }
  assert.equal(securityView(report,{...live,now:11000}).stale,true);
  assert.equal(securityView({...report,runtime:{running:false}},live).animate,false);
});
test('invalid metrics are not displayed as zero',()=>{
  const input=structuredClone(report); Object.assign(input.overview.observation,{auth_percent:null,loss_percent:101,throughput_mbps:-3});
  const view=securityView(input,live);
  assert.equal(view.auth,'—');assert.equal(view.loss,'—');assert.equal(view.throughput,'—');
});
test('MOCK device connectivity is distinct from real security verification',()=>{
  const input=structuredClone(report);input.overview.observation.devices=[{id:'PQC-TEE',connected:true}];
  assert.equal(securityView(input,live).mockDevice,'MOCK 연결');
  input.overview.observation.devices[0].connected=false;
  assert.equal(securityView(input,live).mockDevice,'MOCK 연결 끊김');
  input.overview.observation.devices=[];
  assert.equal(securityView(input,live).mockDevice,'MOCK 상태 미제공');
  for(const devices of [{},[null],['invalid']]) {
    input.overview.observation.devices=devices;
    assert.equal(securityView(input,live).mockDevice,'MOCK 상태 미제공');
  }
});
test('transport labels only describe browser segment, not end-to-end assurance',()=>{
  assert.equal(transportView('https:').protocol,'HTTPS / WSS');
  assert.match(transportView('https:').detail,/브라우저/);
  assert.match(transportView('https:').detail,/검증하지/);
  assert.equal(transportView('http:').protocol,'HTTP / WS');
});
