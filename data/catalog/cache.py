"""Gzip snapshot persistence. No runtime or HTTP dependencies."""
import gzip
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path


class CatalogCache:
    def __init__(self, directory: Path):
        self.directory = Path(directory)

    def path(self, group: str) -> Path:
        if not re.fullmatch(r'[a-zA-Z0-9_-]+', group):
            raise ValueError('카탈로그 그룹에 허용되지 않는 문자가 있습니다.')
        return self.directory / f'{group}.json.gz'

    def load(self, group: str) -> dict | None:
        path = self.path(group)
        if not path.exists():
            return None
        try:
            with gzip.open(path, 'rt', encoding='utf-8') as stream:
                payload = json.load(stream)
            if not isinstance(payload['fetched_at'], str):
                return None
            fetched = datetime.fromisoformat(payload['fetched_at'].replace('Z', '+00:00'))
            age = max(0, (datetime.now(timezone.utc) - fetched).total_seconds())
            return {'loaded_at': time.monotonic() - age,
                    'fetched_at': payload['fetched_at'], 'items': payload['items']}
        except (OSError, EOFError, ValueError, KeyError, TypeError):
            return None

    def save(self, group: str, fetched_at: str, items: list[dict]) -> None:
        path = self.path(group)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix('.tmp.gz')
        with gzip.open(temporary, 'wt', encoding='utf-8') as stream:
            json.dump({'fetched_at': fetched_at, 'items': items}, stream,
                      ensure_ascii=False, separators=(',', ':'))
        temporary.replace(path)
