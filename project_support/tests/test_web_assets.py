import hashlib
import json
import re
import struct
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from html.parser import HTMLParser

from fastapi.testclient import TestClient

MODELS_DIR = Path(__file__).resolve().parents[2] / 'user_application' / 'web' / 'assets' / 'models'


def test_unknown_api_paths_never_fall_back_to_html():
    from user_application.web.application import create_app

    with TestClient(create_app()) as client:
        for path in ('/api', '/api/not-registered', '/api/data-management/not-registered'):
            response = client.get(path)
            assert response.status_code == 404
            assert response.headers['content-type'].startswith('application/json')
            assert response.json()['detail']
        assert client.get('/nodes').headers['content-type'].startswith('text/html')


def test_all_three_globes_expose_accessible_zoom_focus_and_lighting_controls():
    from user_application.web.application import create_app

    class Elements(HTMLParser):
        def __init__(self):
            super().__init__()
            self.elements = []

        def handle_starttag(self, tag, attrs):
            self.elements.append((tag, dict(attrs)))

    with TestClient(create_app()) as client:
        parser = Elements()
        parser.feed(client.get('/').text)
        for prefix, focus_id in [('orbit', 'orbit-locate'), ('node', 'node-map-locate'), ('comm', 'comm-map-locate')]:
            for suffix in ['zoom', 'zoom-in', 'zoom-out', 'lighting']:
                matches = [(tag, attrs) for tag, attrs in parser.elements if attrs.get('id') == f'{prefix}-{suffix}']
                assert len(matches) == 1, f'{prefix}-{suffix} must be available exactly once'
                tag, attrs = matches[0]
                assert attrs.get('aria-label'), f'{prefix}-{suffix} needs an accessible label'
                if suffix == 'zoom':
                    assert tag == 'input' and attrs.get('type') == 'range'
                    assert attrs.get('aria-orientation') == 'vertical'
            focus = [attrs for tag, attrs in parser.elements if tag == 'button' and attrs.get('id') == focus_id]
            assert len(focus) == 1 and focus[0].get('aria-label')
        groups = [attrs for _, attrs in parser.elements if 'map-controls' in attrs.get('class', '').split()]
        assert len(groups) == 3
        assert client.get('/static/styles/map_controls.css').status_code == 200


def test_loading_background_images_are_served_as_png():
    from user_application.web.application import create_app

    with TestClient(create_app()) as client:
        for name in ('loading_1.png', 'loading_2.png'):
            response = client.get(f'/static/assets/loading/{name}')
            assert response.status_code == 200
            assert response.headers['content-type'].startswith('image/png')
            assert response.content.startswith(b'\x89PNG\r\n\x1a\n')


def test_every_local_script_import_and_stylesheet_is_served():
    from user_application.web.application import create_app

    with TestClient(create_app()) as client:
        html = client.get('/').text
        roots = re.findall(r'(?:src|href)="(/static/[^"?]+)(?:\?[^" ]*)?"', html)
        pending, seen = list(roots), set()
        while pending:
            url = pending.pop()
            if url in seen:
                continue
            seen.add(url)
            result = client.get(url)
            assert result.status_code == 200, url
            assert 'text/html' not in result.headers['content-type'], url
            if url.endswith('.js'):
                for imported in re.findall(r'from\s+["\']([^"\']+)["\']', result.text):
                    pending.append(urlsplit(urljoin(url, imported)).path)
        assert len(seen) >= 15
        # The node sandbox pulls the browser model library and node dynamics through the shell.
        for required in ('/static/model_library/satellite_nodes.js', '/static/simulation/satellite_dynamics.js',
                         '/static/simulation/oisl.js', '/static/visualization/node_scene.js', '/static/styles/nodes.css',
                         '/static/scripts/data_management/view_model.js', '/static/styles/data_management.css'):
            assert required in seen, required


def test_shell_exposes_exactly_the_eight_console_tabs():
    from user_application.web.application import create_app

    with TestClient(create_app()) as client:
        html = client.get('/').text
        tabs = re.findall(r'class="nav-tab[^"]*" data-tab-target="([a-z]+)"', html)
        assert tabs == ['orbit', 'nodes', 'communication', 'data', 'security', 'mission', 'status', 'settings']
        views = re.findall(r'class="tab-view[^"]*" id="view-([a-z]+)"', html)
        assert views == ['orbit', 'nodes', 'communication', 'data', 'security', 'mission', 'status', 'settings']
        assert 'data-tab-target="data"><span>데이터</span>' in html
        assert 'id="security-flow"' in html
        assert '실제 보안 검증이 아닙니다' in html
        assert client.get('/static/styles/security.css').status_code == 200
        assert 'view-analysis' not in html and 'view-hil' not in html
        for removed in ('/static/scripts/tabs/analysis.js', '/static/scripts/tabs/hil.js'):
            assert client.get(removed).status_code == 404


def test_python_source_and_generated_data_are_not_published():
    from user_application.web.application import create_app

    with TestClient(create_app()) as client:
        for path in ['/static/application.py', '/static/../application.py',
                     '/data/workspace/catalog_cache/active.json.gz', '/main.py']:
            result = client.get(path)
            assert result.status_code == 404 or '<html' in result.text.lower()
            assert 'import FastAPI' not in result.text


def test_model_manifest_matches_shipped_assets():
    """Every mapped model must ship as a verified glTF binary with a JPEG preview, a provider and a real size."""
    manifest = json.loads((MODELS_DIR / 'manifest.json').read_text(encoding='utf-8'))
    assert manifest['schema'] == 2
    keys = [model['key'] for model in manifest['models']]
    assert keys and len(keys) == len(set(keys))
    assert set(manifest['representatives'].values()) <= set(keys)
    nasa = manifest['sources']['nasa']
    assert nasa['commit'] in nasa['raw_base']
    claimed = {}
    for model in manifest['models']:
        assert model['provider'] in manifest['sources'], model['key']
        assert manifest['sources'][model['provider']]['credit'], model['key']
        assert float(model['size_m']) > 0 and float(model['extent']) > 0, model['key']
        data = (MODELS_DIR / model['file']).read_bytes()
        assert data[:4] == b'glTF', model['key']
        assert struct.unpack_from('<II', data, 4) == (2, len(data)), model['key']
        assert hashlib.sha256(data).hexdigest() == model['sha256'], model['key']
        assert len(data) == model['bytes'], model['key']
        if model['provider'] == 'spacetwin':
            assert model['origin'] is None and b'SpaceTwin' in data[20:2048], model['key']
        assert (MODELS_DIR / model['thumbnail']).read_bytes()[:3] == b'\xff\xd8\xff', model['key']
        for scope in ('exact', 'series'):
            for norad in model[scope]['norad']:
                assert norad not in claimed, (norad, model['key'], claimed.get(norad))
                claimed[norad] = model['key']
        for scope in ('exact', 'series', 'family'):
            for pattern in model[scope]['names']:
                re.compile(pattern)


def test_generated_representative_models_are_reproducible():
    """The self-built shapes on disk must equal what the generator produces from source."""
    import importlib.util

    tool = Path(__file__).resolve().parents[1] / 'tools' / 'build_generic_models.py'
    spec = importlib.util.spec_from_file_location('build_generic_models', tool)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.main(['--check']) == 0


def test_nasa_models_are_served_with_gltf_media_type():
    from user_application.web.application import create_app

    with TestClient(create_app()) as client:
        manifest = client.get('/static/assets/models/manifest.json')
        assert manifest.status_code == 200
        assert manifest.headers['content-type'].startswith('application/json')
        first = manifest.json()['models'][0]
        model = client.get(f"/static/assets/models/{first['file']}")
        assert model.status_code == 200
        assert model.headers['content-type'].startswith('model/gltf-binary')
        assert model.content[:4] == b'glTF'
        thumbnail = client.get(f"/static/assets/models/{first['thumbnail']}")
        assert thumbnail.status_code == 200
        assert thumbnail.headers['content-type'].startswith('image/jpeg')


def test_settings_view_hosts_the_module_topology():
    html = (MODELS_DIR.parents[1] / 'index.html').read_text(encoding='utf-8')
    assert 'id="settings-topology"' in html and 'id="settings-mode-bar"' in html
    assert 'id="settings-link-rows"' in html and 'id="settings-icd-rows"' in html
    assert 'id="icd-dialog"' in html
    for removed in ('settings-scenario-list', 'settings-runtime-toggle', 'settings-fault-open'):
        assert removed not in html


def test_shell_and_static_modules_are_revalidated_not_heuristically_cached():
    # The HTML shell carries the ?v= cache versions and the browser modules import each other by
    # bare relative paths, so both must be revalidated (no-cache) after every code update.
    from user_application.web.application import create_app

    with TestClient(create_app()) as client:
        for path in ('/', '/mission', '/static/scripts/app.js', '/static/styles/scenario.css'):
            assert client.get(path).headers.get('cache-control') == 'no-cache', path
        assert 'cache-control' not in {k.lower() for k in client.get('/api/system').headers} or client.get('/api/system').headers.get('cache-control') != 'no-cache'
