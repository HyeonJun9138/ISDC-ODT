"""Upstream request schedule shared by every process on this machine.

CelesTrak sees an address, not a process. A restart, a second server, a
validation run and another project on the same machine are one client, and this
address was blocked on 2026-09-07 for exactly that: the schedule lived only in a
running process, so every restart was a fresh download and every failure was
retried by each instance and each screen action on its own.

The schedule therefore lives in a file next to the snapshots. Whoever is about
to ask claims the slot first, so a process that dies mid-request still holds it,
and anyone else, including the next run days later, sees the claim. A stop is
kept for the provider as a whole rather than per request, because the usage
policy asks a client to stop querying after an error, not to stop one group.

Storage and arithmetic only. No HTTP, no runtime state.
"""
from __future__ import annotations

import json
import os
import re
import time
from contextlib import contextmanager
from pathlib import Path

# Answers that will not come good by asking again: the address moved, the client
# is not welcome, or the resource is gone.
FATAL_STATUS_CODES = frozenset({301, 302, 303, 307, 308, 400, 401, 403, 404, 410, 451})
RETRY_CEILING_SECONDS = 6 * 60 * 60
RETRY_FLOOR_SECONDS = 60
JOURNAL_LIMIT = 200
_KEY = re.compile(r'[a-zA-Z0-9_:.-]{1,120}')


def retry_delay_seconds(interval_seconds: float, failures: int, status_code: int | None = None) -> float:
    """How long to wait after a failed request.

    Never sooner than the interval the request would have had anyway. Asking a
    provider that is failing more often than one that is answering is backwards,
    and it is how a public service comes to block an address. The wait then
    doubles with each consecutive failure, because a provider that has refused a
    dozen times running will not answer the thirteenth request any sooner. The
    ceiling is eight intervals held between half an hour and six hours, and one
    success clears the count.
    """
    base = max(float(RETRY_FLOOR_SECONDS), float(interval_seconds or RETRY_FLOOR_SECONDS))
    limit = min(float(RETRY_CEILING_SECONDS), max(1800.0, base * 8))
    delay = min(base * 2 ** max(0, min(int(failures) - 1, 16)), limit)
    if status_code == 429:
        delay = max(delay, 600.0)
    return delay


class UpstreamHeldOff(RuntimeError):
    """The provider was not asked: it is not this request's turn, or automatic
    collection is stopped. Not a provider failure, and not counted as one."""


class RequestGuard:
    def __init__(self, path: Path, clock=time.time, journal_limit: int = JOURNAL_LIMIT):
        self.path = Path(path)
        self._clock = clock
        self._journal_limit = journal_limit

    # -- reading -------------------------------------------------------------

    def _read(self) -> dict:
        try:
            content = json.loads(self.path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return {'schema_version': 1, 'stopped_reason': '', 'requests': {}, 'journal': []}
        if not isinstance(content, dict) or not isinstance(content.get('requests'), dict):
            return {'schema_version': 1, 'stopped_reason': '', 'requests': {}, 'journal': []}
        content.setdefault('journal', [])
        content.setdefault('stopped_reason', '')
        return content

    def stopped(self) -> str | None:
        """Why automatic collection from this provider is stopped, or None. One
        answer for the whole provider: a refusal on GP is not a reason to keep
        asking SATCAT from the same address."""
        return self._read().get('stopped_reason') or None

    def state(self, key: str) -> dict:
        return dict(self._read()['requests'].get(key, {}))

    def journal(self, limit: int = JOURNAL_LIMIT) -> list[dict]:
        """The most recent requests, oldest first. This is the record that could
        not be produced when the address was blocked."""
        return list(self._read()['journal'])[-max(0, int(limit)):]

    def seconds_until_allowed(self, key: str) -> float:
        if self.stopped():
            return float('inf')
        return max(0.0, float(self.state(key).get('next_allowed', 0)) - self._clock())

    # -- writing -------------------------------------------------------------

    @contextmanager
    def _locked(self):
        """A short exclusive hold so two processes cannot both read the old
        schedule and write over each other's claim. A lock older than the
        timeout is treated as abandoned: a crashed holder must never stop
        collection for good."""
        lock = self.path.with_suffix('.lock')
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle, deadline = None, time.monotonic() + 2.0
        while handle is None:
            try:
                handle = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                if time.monotonic() > deadline:
                    try:
                        lock.unlink()
                    except OSError:
                        pass
                    continue
                time.sleep(0.01)
            except OSError:
                break
        try:
            yield
        finally:
            if handle is not None:
                os.close(handle)
                try:
                    lock.unlink()
                except OSError:
                    pass

    def _write(self, key: str | None, changes: dict, *, outcome: str = '',
               code: int | None = None, stopped: str | None = None) -> None:
        if key is not None and not _KEY.fullmatch(key):
            raise ValueError('요청 식별자에 허용되지 않는 문자가 있습니다.')
        with self._locked():
            content = self._read()
            if key is not None:
                entry = dict(content['requests'].get(key, {}))
                entry.update(changes)
                content['requests'][key] = entry
            if stopped is not None:
                content['stopped_reason'] = stopped
            if outcome:
                content['journal'] = (content['journal'] + [{
                    'at': round(self._clock(), 3), 'key': key or '', 'outcome': outcome,
                    **({'code': code} if code else {}),
                }])[-self._journal_limit:]
            temporary = self.path.with_suffix('.tmp')
            try:
                temporary.write_text(json.dumps(content, ensure_ascii=False, allow_nan=False),
                                     encoding='utf-8')
                temporary.replace(self.path)
            except OSError:
                # The schedule is a guard, not catalog data. If it cannot be
                # written the caller still works; it only loses the memory.
                pass

    def claim(self, key: str, interval_seconds: float) -> bool:
        """Take the next slot, or refuse. Written before the request, so a
        process that dies mid-request still holds the interval."""
        if self.seconds_until_allowed(key) > 0:
            return False
        now = self._clock()
        self._write(key, {'last_attempt': round(now, 3),
                          'next_allowed': round(now + max(0.0, float(interval_seconds)), 3)},
                    outcome='attempt')
        return True

    def record_success(self, key: str, interval_seconds: float) -> None:
        now = self._clock()
        self._write(key, {'last_success': round(now, 3), 'failures': 0,
                          'next_allowed': round(now + max(0.0, float(interval_seconds)), 3)},
                    outcome='success', stopped='')

    def record_failure(self, key: str, interval_seconds: float, code: int | None = None) -> str | None:
        """Hold this request off, or stop the provider when the answer is one
        that will not change by asking again. Returns the stop reason, if any."""
        now = self._clock()
        failures = int(self.state(key).get('failures', 0)) + 1
        delay = retry_delay_seconds(interval_seconds, failures, code)
        reason = f'HTTP {code}' if code in FATAL_STATUS_CODES else None
        self._write(key, {'failures': failures, 'last_failure': round(now, 3),
                          'last_code': code or 0, 'next_allowed': round(now + delay, 3)},
                    outcome='failure', code=code, stopped=reason)
        return reason

    def stop(self, reason: str) -> None:
        self._write(None, {}, outcome='stopped', stopped=str(reason)[:200])

    def resume(self) -> None:
        """The operator has looked and wants collection to start again."""
        with self._locked():
            content = self._read()
            content['stopped_reason'] = ''
            for entry in content['requests'].values():
                entry['failures'] = 0
                entry['next_allowed'] = 0
            content['journal'] = (content['journal'] + [{'at': round(self._clock(), 3),
                                                         'key': '', 'outcome': 'resumed'}])[-self._journal_limit:]
            temporary = self.path.with_suffix('.tmp')
            try:
                temporary.write_text(json.dumps(content, ensure_ascii=False, allow_nan=False),
                                     encoding='utf-8')
                temporary.replace(self.path)
            except OSError:
                pass

    def validator(self, key: str) -> str:
        """The value to send back as If-Modified-Since, or empty."""
        return str(self.state(key).get('last_modified') or '')

    def record_validator(self, key: str, last_modified: str) -> None:
        if last_modified:
            self._write(key, {'last_modified': str(last_modified)[:100]})
