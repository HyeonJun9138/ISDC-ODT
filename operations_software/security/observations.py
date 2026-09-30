"""Rules over supplied SIM values only. No authentication, encryption or file verification."""
from collections import deque
from copy import deepcopy
from datetime import datetime, timedelta
from math import isfinite
from threading import RLock


def _metric(value, upper=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        if not isfinite(value):
            return None
    except OverflowError:
        return None
    return value if value >= 0 and (upper is None or value <= upper) else None


def _timestamp(value):
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if result.utcoffset() != timedelta(0):
            raise ValueError
        return result
    except (TypeError, AttributeError, ValueError) as error:
        raise ValueError("observed_at은 UTC ISO 8601 시각이어야 합니다.") from error


class SecurityStandIn:
    """Owns only accepted observation copies, SIM verdicts and 200 transition events."""
    implementation = "sim-rule-stand-in"

    def __init__(self, *, authentication_threshold=99.0):
        if _metric(authentication_threshold, 100) is None:
            raise ValueError("인증률 기준은 0~100 사이의 숫자여야 합니다.")
        self._threshold = float(authentication_threshold)
        self._lock = RLock()
        self._observation = None
        self._authentication = "unknown"
        self._events = deque(maxlen=200)
        self._sequence = 0
        self._samples = set()
        self._retired_runs = set()

    def observe(self, message: dict) -> dict:
        if not isinstance(message, dict):
            raise ValueError("관측 메시지는 객체여야 합니다.")
        observation = deepcopy(message)
        if observation.get("contract_version") != "1.0" or observation.get("source") != "SIM":
            raise ValueError("ICD-08 1.0의 SIM 관측만 지원합니다.")
        for name in ("run_id", "sample_id"):
            if not isinstance(observation.get(name), str) or not observation[name].strip():
                raise ValueError(f"{name}이 필요합니다.")
        if _metric(observation.get("sim_elapsed_s")) is None or type(observation.get("running")) is not bool:
            raise ValueError("SIM 경과 시각과 실행 상태가 유효하지 않습니다.")
        observed_at = _timestamp(observation.get("observed_at"))
        for name, upper in (("auth_percent", 100), ("throughput_mbps", None), ("loss_percent", 100)):
            observation[name] = _metric(observation.get(name), upper)
        with self._lock:
            previous = self._observation
            run_id = observation["run_id"]
            if run_id in self._retired_runs:
                return self.overview()
            if previous and run_id == previous["run_id"]:
                if (observation["sample_id"] in self._samples
                        or observation["sim_elapsed_s"] <= previous["sim_elapsed_s"]
                        or observed_at < _timestamp(previous["observed_at"])):
                    return self.overview()
            elif previous:
                if observed_at < _timestamp(previous["observed_at"]):
                    return self.overview()
                self._retired_runs.add(previous["run_id"])
                self._samples.clear()
                self._events.clear()
                self._sequence = 0
            auth = observation["auth_percent"]
            verdict = "unknown" if auth is None else ("nominal" if auth >= self._threshold else "warning")
            baseline = not self._events
            if baseline or verdict != self._authentication:
                self._sequence += 1
                label = {"nominal": "기준 충족", "warning": "기준 미달", "unknown": "미확인"}[verdict]
                self._events.append({"sequence": self._sequence, "run_id": run_id,
                    "observed_at": observation["observed_at"], "authentication": verdict,
                    "message": f"SIM 인증률 {'최초 관측' if baseline else '판정 전환'}: {label}"})
            self._observation = observation
            self._authentication = verdict
            self._samples.add(observation["sample_id"])
            return self.overview()

    def overview(self) -> dict:
        with self._lock:
            return deepcopy({"contract_version": "1.0", "source": "SIM", "observation": self._observation,
                "verdict": {"authentication": self._authentication, "integrity": "unknown", "encryption": "unknown"},
                "threshold": self._threshold,
                "basis": "기존 SIM 인증률의 임계값 판정이며 실제 인증, 암호화와 파일 무결성을 검증하지 않습니다."})

    def events(self, after: int = 0) -> dict:
        if type(after) is not int or after < 0:
            raise ValueError("after는 0 이상의 정수여야 합니다.")
        with self._lock:
            return deepcopy({"contract_version": "1.0", "source": "SIM",
                "run_id": self._observation["run_id"] if self._observation else None,
                "events": [event for event in self._events if event["sequence"] > after],
                "latest": self._sequence, "retention_limit": 200, "persistent": False})

    def status(self) -> dict:
        with self._lock:
            return {"module": "security", "implementation": self.implementation, "version": "1.0",
                "contract_version": "1.0", "source": "SIM", "placement": "embedded", "reachable": True,
                "endpoint": None, "run_id": self._observation["run_id"] if self._observation else None,
                "observed_at": self._observation["observed_at"] if self._observation else None,
                "sequence": self._sequence, "scope": "SIM 규칙 판정. 실제 보안 기능 미구현"}
