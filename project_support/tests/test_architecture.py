"""Enforce actual import edges rather than relying on folder names alone."""
import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LAYERS = {'communication', 'data', 'digital_twin', 'user_application'}


def imports(path):
    module = path.relative_to(ROOT).with_suffix('').parts
    package = module[:-1]
    for node in ast.walk(ast.parse(path.read_text(encoding='utf-8-sig'))):
        if isinstance(node, ast.Import):
            yield from (item.name for item in node.names)
        elif isinstance(node, ast.ImportFrom):
            prefix = '.'.join(package[:len(package) - node.level + 1]) if node.level else ''
            yield '.'.join(part for part in [prefix, node.module] if part)


def test_python_dependency_boundaries():
    violations = []
    policies = {
        'digital_twin/runtime': ('digital_twin.runtime', 'digital_twin.contracts', 'digital_twin.simulation'),
        'digital_twin/simulation': ('digital_twin.simulation', 'digital_twin.model_library'),
        'digital_twin/model_library': ('digital_twin.model_library',),
        'digital_twin/contracts': ('digital_twin.contracts',),
        'digital_twin/verification': ('digital_twin.contracts', 'digital_twin.verification'),
        'communication/http': ('communication.http', 'digital_twin.contracts', 'data.catalog.contracts', 'data.exports'),
        'communication/external': ('communication.external',),
        'data': ('data', 'digital_twin.contracts', 'digital_twin.simulation', 'digital_twin.model_library'),
    }
    for folder, allowed in policies.items():
        for path in (ROOT / folder).rglob('*.py'):
            for dependency in imports(path):
                if dependency.split('.')[0] in LAYERS | {'backend', 'frontend', 'project_support'}:
                    if not any(dependency == prefix or dependency.startswith(prefix + '.') for prefix in allowed):
                        violations.append(f'{path.relative_to(ROOT)} -> {dependency}')
    assert violations == []


def test_renderer_has_no_application_state_or_transport_dependency():
    import re

    for path in (ROOT / 'digital_twin/visualization').rglob('*.js'):
        for dependency in re.findall(r'from\s+["\']([^"\']+)["\']', path.read_text(encoding='utf-8')):
            assert not any(forbidden in dependency for forbidden in ('/scripts/', '/communication/', 'state.js')), (path, dependency)


def test_all_application_source_lives_in_framework_layers():
    assert not (ROOT / 'backend').exists()
    assert not (ROOT / 'frontend').exists()
