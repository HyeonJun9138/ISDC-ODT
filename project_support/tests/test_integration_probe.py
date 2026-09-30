"""The settings tab's module connection probe (/api/integration/probe)."""
import asyncio
import socket
from types import SimpleNamespace

from fastapi.testclient import TestClient

from communication.http.integration import is_local_host, probe_tcp, probe_udp, probe_link
from communication.http.schemas import ProbeLink
from digital_twin.contracts.security import SecurityUnavailable
from user_application.web.application import create_app


def test_security_probe_reads_actual_module_status_without_stub_fallback():
    class SecurityReport:
        def status(self):
            return {'reachable': False, 'placement': 'remote', 'endpoint': 'http://security.test:9000',
                    'implementation': 'security-sim', 'contract_version': '1.0'}

    app = create_app()
    app.state.security = SecurityReport()
    request = SimpleNamespace(app=app)
    link = ProbeLink(id='L16', transport='IPC', host='in-process', endpoints=['security-ops', 'framework'])
    result = asyncio.run(probe_link(request, link))
    assert result['state'] == 'down'
    assert 'http://security.test:9000' in result['detail']
    assert '스텁' not in result['detail']


def test_security_probe_reports_unavailable_module_and_missing_injection():
    class UnavailableSecurity:
        def status(self):
            raise SecurityUnavailable('외부 모듈 시간 초과')

    app = create_app()
    link = ProbeLink(id='L16', transport='IPC', host='in-process', endpoints=['security-ops', 'framework'])
    app.state.security = UnavailableSecurity()
    failed = asyncio.run(probe_link(SimpleNamespace(app=app), link))
    assert failed['state'] == 'down' and '시간 초과' in failed['detail']
    del app.state.security
    missing = asyncio.run(probe_link(SimpleNamespace(app=app), link))
    assert missing['state'] == 'down' and '미연동' in missing['detail']
    assert '스텁' not in missing['detail']


def test_external_security_is_not_an_embedded_stub_or_protocol_verification():
    request = SimpleNamespace(app=create_app())
    link = ProbeLink(id='L17', transport='IPC', host='in-process', endpoints=['dt-comm', 'security-external'])
    result = asyncio.run(probe_link(request, link))
    assert result['state'] == 'unverified'
    assert '미연동' in result['detail']


def test_external_security_tcp_reachability_is_not_protocol_success():
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen(1)
    try:
        link = ProbeLink(id='L17', transport='TCP', host='127.0.0.1', port=listener.getsockname()[1],
                         endpoints=['dt-comm', 'security-external'])
        result = asyncio.run(probe_link(SimpleNamespace(app=create_app()), link))
    finally:
        listener.close()
    assert result['method'] == 'tcp-connect'
    assert result['state'] == 'unverified'
    assert '도달 가능' in result['detail'] and '프로토콜 미검증' in result['detail']


def test_security_sw_diagnostic_tcp_does_not_reuse_embedded_module_status():
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen(1)
    try:
        link = ProbeLink(id='L16', transport='TCP', host='127.0.0.1', port=listener.getsockname()[1],
                         endpoints=['security-ops', 'framework'])
        result = asyncio.run(probe_link(SimpleNamespace(app=create_app()), link))
    finally:
        listener.close()
    assert result['method'] == 'tcp-connect'
    assert result['state'] == 'unverified'
    assert '도달 가능' in result['detail']


def test_local_hosts_are_probed_in_process():
    assert all(is_local_host(host) for host in ('', 'self', 'in-process', 'localhost', '127.0.0.1', '127.9.9.9', ' LocalHost '))
    assert not any(is_local_host(host) for host in ('10.0.0.5', 'fabric.remote', '192.168.1.20'))


def test_tcp_probe_reports_a_listener_and_a_closed_port():
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen(1)
    port = listener.getsockname()[1]
    try:
        up = asyncio.run(probe_tcp('127.0.0.1', port, 1.0))
    finally:
        listener.close()
    assert up['state'] == 'up' and up['method'] == 'tcp-connect' and up['latency_ms'] >= 0
    down = asyncio.run(probe_tcp('127.0.0.1', port, 1.0))
    # Windows keeps retrying a closed local port until the timeout; POSIX refuses at once.
    assert down['state'] == 'down' and down['latency_ms'] is None and ('연결 실패' in down['detail'] or '응답 없음' in down['detail'])


def test_udp_probe_can_only_resolve_the_address():
    resolved = asyncio.run(probe_udp('localhost', 5102, 1.0))
    assert resolved['state'] == 'unverified' and resolved['method'] == 'udp-resolve'
    missing = asyncio.run(probe_udp('no-such-host.invalid', 5102, 1.0))
    assert missing['state'] == 'down'


def test_probe_endpoint_checks_embedded_modules_and_remote_endpoints():
    payload = {'links': [
        {'id': 'L06', 'transport': 'IPC', 'host': 'in-process', 'port': 0, 'endpoints': ['framework', 'engine']},
        {'id': 'L02', 'transport': 'UDP', 'host': '127.0.0.1', 'port': 5102, 'endpoints': ['data-fabric', 'framework']},
        {'id': 'L07', 'transport': 'TCP', 'host': 'localhost', 'port': 5107, 'endpoints': ['framework', 'model']},
        {'id': 'L03', 'transport': 'TCP', 'host': 'no-such-host.invalid', 'port': 5103, 'timeout_s': 0.5, 'endpoints': ['orchestrator', 'framework']},
        {'id': 'L11', 'transport': 'UDP', 'host': 'no-such-host.invalid', 'port': 5111, 'timeout_s': 0.5, 'endpoints': ['test-mgr', 'result-db']},
    ]}
    with TestClient(create_app()) as client:
        response = client.post('/api/integration/probe', json=payload)
        assert response.status_code == 200
        body = response.json()
        results = body['results']
        assert body['checked_at'].endswith('+00:00') and set(results) == {'L06', 'L02', 'L07', 'L03', 'L11'}
        assert results['L06']['state'] == 'up' and results['L06']['method'] == 'in-process' and '런타임' in results['L06']['detail']
        assert results['L02']['state'] == 'up' and '데이터 패브릭' in results['L02']['detail']
        assert results['L07']['state'] == 'up' and '모델 노드' in results['L07']['detail'] and '예정 엔드포인트 localhost:5107' in results['L07']['detail']
        assert results['L03']['state'] == 'down' and results['L03']['method'] == 'tcp-connect'
        assert results['L11']['state'] == 'down' and results['L11']['method'] == 'udp-resolve'
        assert client.post('/api/integration/probe', json={'links': [{'id': 'X', 'transport': 'carrier-pigeon'}]}).status_code == 422
        assert client.post('/api/integration/probe', json={'links': []}).json()['results'] == {}
