"""계층 분리 후에도 실행과 상태 경계가 실제로 동작해야 한다."""
from fastapi.testclient import TestClient


def test_application_instances_do_not_share_current_state():
    from user_application.web.application import create_app

    with TestClient(create_app()) as first, TestClient(create_app()) as second:
        first.post('/api/runtime/speed', json={'speed': 17})
        assert first.get('/api/health').json()['runtime']['speed'] == 17
        assert second.get('/api/health').json()['runtime']['speed'] == 1


def test_snapshots_are_detached_from_current_state():
    from user_application.bootstrap import create_runtime

    state = create_runtime()
    snap = state.snapshot()
    snap.missions[0]['tasks'][0]['name'] = 'modified outside runtime'
    snap.current_telemetry['power'] = -1
    assert state.missions[0]['tasks'][0]['name'] == 'Target Sweep'
    assert state.current_telemetry['power'] > 0


def test_pure_telemetry_preserves_baseline_and_fault_effects():
    from digital_twin.simulation.telemetry import calculate_telemetry

    normal = calculate_telemetry(124.5, [])
    faulted = calculate_telemetry(124.5, [{'kind': 'power_drop'}])
    assert faulted['power'] == round(normal['power'] - 24, 1)
    assert faulted['temperature'] == normal['temperature']


def test_main_is_callable_without_launching_on_import():
    import main

    assert callable(getattr(main, 'main', None))
