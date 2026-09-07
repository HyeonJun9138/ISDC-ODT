import json
from pathlib import Path

from user_application.web.application import create_app


def test_openapi_matches_pre_refactoring_contract():
    # Captured from the verified original ZIP using an isolated Python process.
    baseline = json.loads((Path(__file__).parent / 'fixtures/original_openapi.json').read_text(encoding='utf-8'))
    assert create_app().openapi() == baseline
