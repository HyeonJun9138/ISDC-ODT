import os
from pathlib import Path
import socket
import subprocess
import sys
import time

import httpx

ROOT = Path(__file__).resolve().parents[2]


def test_main_starts_from_an_unrelated_working_directory(tmp_path):
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    output = tmp_path / 'server.log'
    with output.open('w', encoding='utf-8') as log:
        process = subprocess.Popen([sys.executable, str(ROOT / 'main.py'), '--host', '127.0.0.1',
                                    '--port', str(port), '--no-browser'], cwd=tmp_path,
                                   stdout=log, stderr=subprocess.STDOUT,
                                   env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
        try:
            with httpx.Client(trust_env=False, timeout=1) as client:
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    assert process.poll() is None, output.read_text(encoding='utf-8')
                    try:
                        response = client.get(f'http://127.0.0.1:{port}/api/health')
                        break
                    except httpx.TransportError:
                        time.sleep(.1)
                else:
                    raise AssertionError('Server did not become ready')
                assert response.json()['status'] == 'ok'
                assert client.get(f'http://127.0.0.1:{port}/static/scripts/app.js').status_code == 200
        finally:
            process.terminate()
            process.wait(timeout=10)


def test_busy_port_is_reported_without_terminating_its_owner(tmp_path):
    with socket.socket() as owner:
        owner.bind(('127.0.0.1', 0))
        owner.listen()
        port = owner.getsockname()[1]
        result = subprocess.run([sys.executable, str(ROOT / 'main.py'), '--host', '127.0.0.1',
                                 '--port', str(port), '--no-browser'], cwd=tmp_path,
                                capture_output=True, timeout=15)
        assert result.returncode != 0
        assert b'bind' in result.stderr.lower() or b'address' in result.stderr.lower()
        assert owner.getsockname()[1] == port
