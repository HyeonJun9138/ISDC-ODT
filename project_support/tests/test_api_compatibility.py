import json
from pathlib import Path

from user_application.web.application import create_app


def test_openapi_keeps_every_pre_refactoring_operation_and_schema():
    # Captured from the verified original ZIP using an isolated Python process. Every original path,
    # operation and schema must survive unchanged; new ICD paths (e.g. /api/data-fabric) may be added.
    baseline = json.loads((Path(__file__).parent / 'fixtures/original_openapi.json').read_text(encoding='utf-8'))
    current = create_app().openapi()
    for path, operations in baseline['paths'].items():
        assert current['paths'].get(path) == operations, path
    for name, schema in baseline['components']['schemas'].items():
        assert current['components']['schemas'].get(name) == schema, name
    assert current['info'] == baseline['info']
