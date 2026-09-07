import re
from urllib.parse import urljoin, urlsplit

from fastapi.testclient import TestClient


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


def test_python_source_and_generated_data_are_not_published():
    from user_application.web.application import create_app

    with TestClient(create_app()) as client:
        for path in ['/static/application.py', '/static/../application.py',
                     '/data/workspace/catalog_cache/active.json.gz', '/main.py']:
            result = client.get(path)
            assert result.status_code == 404 or '<html' in result.text.lower()
            assert 'import FastAPI' not in result.text
