// The UI consumes ICD-08 reports. It does not decide security policy or mutate DT state.
import { securityView, transportView } from '../security/view_model.js';
import { escapeMarkup } from './fault_dialog.js';

const $ = id => document.getElementById(id);
let initialized = false, active = false, report = null, receivedAt = null, telemetryAt = null;
let socket = 'connecting', error = '', timer, freshnessTimer, request, generation = 0;
let runtimeRun = null, runtimeRunning = null;
const utc = value => { const date = new Date(value); return value != null && Number.isFinite(date.getTime()) ? date.toISOString().slice(11,19) + ' UTC' : '—'; };
const put = (id,value) => { const el=$(id); if(el && el.textContent !== String(value)) el.textContent = value; };

function render() {
  if (!initialized) return;
  const view = securityView(report,{receivedAt,telemetryAt,socket,error});
  const observation = report?.overview?.observation;
  const module = report?.module;
  const moving = active && !document.hidden && view.animate && runtimeRunning !== false;
  $('security-flow').dataset.moving = String(moving);
  $('security-flow').dataset.tone = view.tone;
  $('security-health').dataset.tone = view.tone;
  put('security-health',view.state);
  put('security-auth',view.auth); put('security-auth-state',view.authentication);
  put('security-throughput',view.throughput); put('security-loss',view.loss);
  put('security-integrity',view.integrity);
  put('security-mock-device',view.mockDevice);
  put('security-received',utc(receivedAt));
  put('security-observed',utc(observation?.observed_at));
  put('security-sim-time', typeof observation?.sim_elapsed_s === 'number' ? `T+${observation.sim_elapsed_s.toFixed(1)} s` : '—');
  put('security-run',observation?.run_id || '—');
  put('security-module-state',module?.reachable === true && !error ? '응답 수신' : '미확인');
  put('security-placement',module?.placement === 'remote' ? '외부 HTTP 모듈' : module?.placement === 'embedded' ? '내장 SIM 모듈' : '—');
  put('security-implementation',module?.implementation || '—');
  put('security-version',module?.contract_version ? `ICD-08 / v${module.contract_version}` : 'ICD-08 / 수신 대기');
  put('security-endpoint',module?.endpoint || (module?.placement === 'embedded' ? '동일 프로세스 / 계약 호출' : '—'));
  put('security-socket',({open:'연결됨',connecting:'연결 중',closed:'연결 끊김',error:'연결 오류'}[socket] || '미확인'));
  put('security-flow-state',moving ? '모의 흐름 표시 중' : '흐름 표시 정지');
  put('security-evidence',error || (!view.live && report ? '마지막 수신값입니다. 최신 상태를 확인할 수 없습니다.' : '모듈 보고에 따른 SIM 지표입니다. 실제 보안 보증이 아닙니다.'));
  put('security-threshold', typeof report?.overview?.threshold === 'number' ? `모듈 인증 기준 ≥ ${report.overview.threshold}%` : '모듈 판정 수신 대기');
  const events = report?.events?.events || [];
  const markup = events.slice(-40).reverse().map(event => `<tr><td>${escapeMarkup(utc(event.observed_at))}</td><td><span class="sec-tag">SIM</span></td><td>${escapeMarkup(event.message || event.authentication || '상태 전환')}</td></tr>`).join('') || '<tr><td colspan="3" class="sec-empty">모듈 관측 이력 없음</td></tr>';
  if($('security-events').innerHTML !== markup) $('security-events').innerHTML = markup;
}

async function poll() {
  if (!active || document.hidden || request) return;
  const token = generation, expectedRun = runtimeRun;
  const controller = new AbortController(); request = controller;
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch('/api/security/dashboard',{cache:'no-store',signal:controller.signal});
    const payload = await response.json();
    if (token !== generation || !active) return;
    if (!response.ok) {
      if(payload.module) report = {...report,module:payload.module};
      throw new Error(payload.module?.detail || payload.detail || '보안 모듈 응답을 확인할 수 없습니다.');
    }
    // Do not paint an old run over a newer WebSocket update.
    if (expectedRun !== runtimeRun || (runtimeRun && payload.runtime?.run_id !== runtimeRun)) return;
    report = payload; receivedAt = Date.now(); error = '';
  } catch (failure) {
    if (token === generation && active) error = failure.name === 'AbortError' ? '보안 모듈 응답 시간 초과' : failure.message;
  } finally {
    clearTimeout(timeout);
    if (request === controller) request = null;
    if(token === generation && active && !document.hidden) { render(); timer = setTimeout(poll,2000); }
  }
}

function cancel() {
  generation++; clearTimeout(timer); request?.abort(); request = null;
}
export function setSecurityActive(value) {
  active = value;
  if(!initialized) return;
  cancel(); render();
  if(active && !document.hidden) poll();
}
export function updateSecurityTelemetry(payload) {
  telemetryAt = Date.now();
  if(payload?.runtime) {
    runtimeRunning = payload.runtime.running;
    const nextRun = payload.runtime.run_id;
    if(runtimeRun && nextRun && nextRun !== runtimeRun) {
      report = null; receivedAt = null; error = ''; cancel();
      runtimeRun = nextRun;
      if(initialized && active && !document.hidden) poll();
    }
    if(nextRun) runtimeRun = nextRun;
  }
  if(active) render();
}
export function updateSecuritySocket(value) { socket = value; if(active) render(); }
export function initSecurity() {
  if(initialized) return;
  initialized = true;
  const transport = transportView(location.protocol);
  put('security-transport',transport.protocol); put('security-transport-detail',transport.detail);
  document.addEventListener('visibilitychange',() => { cancel(); render(); if(active && !document.hidden) poll(); });
  window.addEventListener('pagehide',() => { cancel(); clearInterval(freshnessTimer); });
  freshnessTimer = setInterval(() => { if(active) render(); },1000);
  render(); if(active) poll();
}
