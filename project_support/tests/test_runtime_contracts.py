import asyncio
from dataclasses import replace

from fastapi.testclient import TestClient

from user_application.bootstrap import create_runtime
from user_application.web.application import create_app


def test_query_implementation_cannot_modify_authoritative_faults():
    app = create_app()

    def route(source, target, objective, faults):
        faults.clear()
        return {'status': 'unavailable'}

    app.state.queries = replace(app.state.queries, calculate_route=route)
    with TestClient(app) as client:
        client.post('/api/faults', json={'target': 'L01', 'kind': 'link_loss', 'severity': 'high', 'duration_seconds': 30})
        assert client.post('/api/communication/route', json={'source': 'SAT-01', 'target': 'SAT-02', 'objective': 'balanced'}).status_code == 200
        assert len(client.get('/api/health').json()['runtime']['active_faults']) == 1


def test_simulation_clock_stops_and_read_payloads_do_not_alias_state():
    state = create_runtime()

    async def scenario():
        await state.start()
        await asyncio.sleep(.25)
        assert state.sequence >= 1
        await state.shutdown()
        elapsed = state.elapsed_seconds
        await asyncio.sleep(.25)
        assert state.elapsed_seconds == elapsed
        payload = state.telemetry()
        payload['events'][0]['message'] = 'external mutation'
        payload['devices'][0]['health'] = 0
        assert state.events[0]['message'] != 'external mutation'
        assert state.devices[0]['health'] == 98

    asyncio.run(scenario())


def test_telemetry_numeric_baseline_and_fault_expiry_order():
    state = create_runtime()
    assert state.current_telemetry == {
        'power': 82.9, 'temperature': 25.7, 'attitude_error': .114, 'storage': 69.2,
        'link_quality': 97.5, 'delay_ms': 33.6, 'loss_percent': .12,
        'throughput_mbps': 45.3, 'ber': 1.183685307778816e-6, 'auth_percent': 99.81,
    }

    async def scenario():
        await state.inject_fault({'target': 'L01', 'kind': 'link_loss', 'severity': 'high', 'duration_seconds': 1})
        await state.control('step')
        state._expire_faults()
        assert state.faults == []
        assert state.events[0]['type'] == 'fault.cleared'
        assert state.events[0]['payload']['active'] is False

    asyncio.run(scenario())


def test_websocket_and_command_errors_preserve_wire_behavior():
    with TestClient(create_app()) as client:
        assert client.post('/api/runtime/control', json={'action': 'unknown'}).status_code == 422
        assert client.post('/api/runtime/speed', json={'speed': 0}).status_code == 422
        assert client.post('/api/scenario/select', json={'scenario_id': 'missing'}).status_code == 400
        assert client.post('/api/hil/device', json={'device_id': 'missing', 'action': 'connect'}).status_code == 400
        assert client.post('/api/hil/device', json={'device_id': 'KRS-HIL', 'action': 'sync'}).status_code == 400
        with client.websocket_connect('/ws/telemetry') as socket:
            payload = socket.receive_json()
            assert payload['type'] == 'telemetry'
            assert payload['runtime']['run_id'] == payload['analytics']['run_id']
            assert payload['data_quality']['mode'] == 'SIM'


def test_hil_preflight_sequence_and_recording_are_still_mock():
    with TestClient(create_app()) as client:
        assert client.get('/api/hil/preflight').json()['status'] == 'BLOCKED'
        client.post('/api/hil/device', json={'device_id': 'KRS-HIL', 'action': 'connect'})
        for device in client.get('/api/bootstrap').json()['devices']:
            assert client.post('/api/hil/device', json={'device_id': device['id'], 'action': 'sync'}).status_code == 200
        assert client.get('/api/hil/preflight').json()['status'] == 'READY'
        result = client.post('/api/hil/sequence', json={'sequence_id': 'closed_loop'}).json()
        assert result['status'] == 'completed'
        assert result['preflight']['mode'] == 'MOCK-HIL'
        assert client.post('/api/hil/recording', json={'enabled': False}).json()['recording'] is False
        assert client.get('/api/hil/preflight').json()['status'] == 'BLOCKED'

