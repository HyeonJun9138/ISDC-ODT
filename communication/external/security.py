"""Lazy HTTP boundary for ICD-08. Invalid upstream data never becomes SIM fallback."""
from copy import deepcopy
from datetime import datetime, timedelta
from math import isfinite
from threading import RLock
from urllib.parse import urlsplit

import httpx

from digital_twin.contracts.security import SecurityUnavailable


def _text(value):
    return isinstance(value, str) and bool(value.strip())


def _number(value, upper=None):
    try:
        return (type(value) in (int, float) and isfinite(value) and value >= 0
                and (upper is None or value <= upper))
    except OverflowError:
        return False


def _utc(value):
    try:
        return _text(value) and datetime.fromisoformat(value.replace("Z", "+00:00")).utcoffset() == timedelta(0)
    except ValueError:
        return False


def _valid_report(body, kind):
    if not isinstance(body, dict) or body.get("contract_version") != "1.0" or body.get("source") != "SIM":
        return False
    if kind == "status":
        return (body.get("module") == "security" and all(_text(body.get(key)) for key in ("implementation", "version"))
            and body.get("placement") in ("embedded", "remote") and body.get("reachable") is True
            and "endpoint" in body and (body["endpoint"] is None or _text(body["endpoint"]))
            and "run_id" in body and (body["run_id"] is None or _text(body["run_id"]))
            and "observed_at" in body and (body["observed_at"] is None or _utc(body["observed_at"])))
    if kind == "events":
        events = body.get("events")
        if not (isinstance(events, list) and len(events) <= 200 and type(body.get("latest")) is int
                and body["latest"] >= 0 and "run_id" in body):
            return False
        previous = 0
        for event in events:
            if not (isinstance(event, dict) and type(event.get("sequence")) is int
                    and previous < event["sequence"] <= body["latest"]
                    and _utc(event.get("observed_at")) and _text(event.get("message"))
                    and _text(event.get("run_id")) and event["run_id"] == body["run_id"]
                    and event.get("authentication") in ("nominal", "warning", "unknown")):
                return False
            previous = event["sequence"]
        return body["run_id"] is None or _text(body["run_id"])
    verdict = body.get("verdict")
    if not (isinstance(verdict, dict) and verdict.get("authentication") in ("nominal", "warning", "unknown")
            and verdict.get("integrity") == "unknown" and verdict.get("encryption") == "unknown"
            and _number(body.get("threshold"), 100) and "observation" in body):
        return False
    observation = body["observation"]
    if observation is None:
        return verdict["authentication"] == "unknown"
    if not (isinstance(observation, dict) and observation.get("source") == "SIM"
            and observation.get("contract_version") == "1.0"
            and _text(observation.get("run_id")) and _text(observation.get("sample_id"))
            and _utc(observation.get("observed_at")) and _number(observation.get("sim_elapsed_s"))
            and type(observation.get("running")) is bool):
        return False
    for key, upper in (("auth_percent", 100), ("throughput_mbps", None), ("loss_percent", 100)):
        if key not in observation or (observation[key] is not None and not _number(observation[key], upper)):
            return False
    devices = observation.get("devices", [])
    if not isinstance(devices, list) or not all(
            isinstance(device, dict) and _text(device.get("id")) and type(device.get("connected")) is bool
            for device in devices):
        return False
    return True


class RemoteSecurity:
    implementation = "remote"

    def __init__(self, base_url: str, *, timeout_s: float = 2.5, client: httpx.Client | None = None):
        parsed = urlsplit(base_url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("보안 모듈 주소는 자격 증명이 없는 HTTP 또는 HTTPS URL이어야 합니다.")
        if parsed.query or parsed.fragment:
            raise ValueError("보안 모듈 주소에는 query나 fragment를 사용할 수 없습니다.")
        self.base_url = base_url.rstrip("/")
        self._timeout_s = timeout_s
        self._client = client
        self._lock = RLock()
        self._closed = False

    def _call(self, method, path, kind, **kwargs):
        with self._lock:
            if self._closed:
                raise SecurityUnavailable("보안 모듈 HTTP 클라이언트가 종료되었습니다.")
            if self._client is None:
                self._client = httpx.Client(timeout=self._timeout_s)
            try:
                response = self._client.request(method, self.base_url + path, timeout=self._timeout_s, **kwargs)
                response.raise_for_status()
                body = response.json()
            except (httpx.HTTPError, ValueError) as error:
                raise SecurityUnavailable(f"외부 보안 모듈 응답 오류: {type(error).__name__}") from error
            if not _valid_report(body, kind):
                raise SecurityUnavailable("외부 보안 모듈 응답이 ICD-08 1.0 계약과 일치하지 않습니다.")
            return deepcopy(body)

    def observe(self, message: dict) -> dict:
        if (not isinstance(message, dict) or not _text(message.get("run_id"))
                or not _number(message.get("sim_elapsed_s"))):
            raise ValueError("run_id와 유효한 SIM 경과 시각이 있는 관측 객체가 필요합니다.")
        report = self._call("POST", "/api/security/observations", "overview", json=message)
        observation = report.get("observation")
        if not observation or observation["run_id"] != message["run_id"]:
            raise SecurityUnavailable("외부 보안 모듈이 요청한 실행과 다른 관측을 반환했습니다.")
        if observation["sim_elapsed_s"] < message["sim_elapsed_s"]:
            raise SecurityUnavailable("외부 보안 모듈이 요청한 관측보다 오래된 결과를 반환했습니다.")
        return report

    def overview(self) -> dict:
        return self._call("GET", "/api/security/overview", "overview")

    def events(self, after: int = 0) -> dict:
        return self._call("GET", "/api/security/events", "events", params={"after": after})

    def status(self) -> dict:
        report = self._call("GET", "/api/security/status", "status")
        return {**report, "placement": "remote", "endpoint": self.base_url}

    def close(self):
        with self._lock:
            self._closed = True
            if self._client is not None:
                self._client.close()
