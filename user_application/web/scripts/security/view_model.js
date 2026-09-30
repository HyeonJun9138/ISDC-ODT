// Presentation only: authentication decisions belong to the operations SW.
const numberText = (value, digits, max = Infinity) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value.toFixed(digits) : '—';
export function transportView(protocol) {
  return protocol === 'https:'
    ? {protocol:'HTTPS / WSS',detail:'브라우저와 서버 구간의 TLS 연결입니다. 위성 구간과 사용자 인증을 검증하지 않습니다.'}
    : {protocol:'HTTP / WS',detail:'브라우저와 서버 구간이 암호화되지 않았습니다. 신뢰할 수 있는 네트워크에서만 사용하세요.'};
}
export function securityView(report, {now = Date.now(), receivedAt = null, telemetryAt = null, socket = 'connecting', error = ''} = {}) {
  const observation = report?.overview?.observation;
  const stale = receivedAt == null || now - receivedAt >= 10000;
  const streamStale = telemetryAt == null || now - telemetryAt >= 10000;
  const available = !!observation && report?.module?.reachable === true && !error;
  const live = available && !stale && !streamStale && socket === 'open';
  const throughput = numberText(observation?.throughput_mbps,1);
  const verdict = report?.overview?.verdict?.authentication;
  const device = Array.isArray(observation?.devices) ? observation.devices.find(item => item?.id === 'PQC-TEE') : null;
  return {
    stale, live,
    state:error ? '조회 오류' : !report ? '수신 대기' : !available ? '모듈 미연결' : stale ? '모듈 보고 지연' : socket !== 'open' ? '스트림 단절' : streamStale ? '스트림 수신 지연' : 'SIM 보고 수신',
    animate:live && observation.running === true && report.runtime?.running !== false && throughput !== '—' && observation.throughput_mbps > 0,
    authentication:!available || stale ? '미확인' : ({nominal:'SIM 기준 충족',warning:'SIM 기준 미달',unknown:'미확인'}[verdict] || '미확인'),
    tone:!live ? 'unknown' : verdict === 'warning' ? 'warning' : verdict === 'nominal' ? 'nominal' : 'unknown',
    integrity:'검증 입력 없음',
    mockDevice:device?.connected === true ? 'MOCK 연결' : device?.connected === false ? 'MOCK 연결 끊김' : 'MOCK 상태 미제공',
    auth:numberText(observation?.auth_percent,2,100),
    throughput, loss:numberText(observation?.loss_percent,2,100),
  };
}
