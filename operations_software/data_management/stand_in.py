"""The data management stand-in that answers ICD-01 messages.

update_nodes()  DM-04 저장 노드 상태 갱신 (DT → 데이터 관리): roster with availability and the twin's
                simulation clock. Advances the model to that clock.
ingest()        DM-01 수집 등록: products the twin's nodes generated. Filtered, catalogued, placed.
request()       DM-02 서비스 요청: find the object, pick the serving replica, report latency.
action()        DM-03 운영 조치: verify, heal, rebalance, set_replication, set_filter, purge_expired.
overview()      DM-05 상태 보고. objects() DM-06 카탈로그. nodes() DM-07 저장 노드 상태.
events()        DM-08 이벤트. status() DM-09 모듈 상태.

All time is the twin's simulation clock in seconds (`sim_elapsed_s`); wall time is only echoed.
The model is deterministic: the same message sequence yields the same catalogue, jobs and events.
It holds only what a real module would hold (its catalogue and jobs), never twin state.
"""
from __future__ import annotations

import random
from collections import deque
from copy import deepcopy
from typing import Any

from .catalog import (
    DAMAGED_STATES, counted_replicas, evaluate_status, expired, filter_product, make_object, public_object, tier_for,
)
from .placement import choose_targets, free_gb, has_room, overloaded, serve_latency_ms, serving_replica
from .policy import DATA_CLASSES, NODE_KINDS, default_policy

STAND_IN_VERSION = "0.1"
MAX_EVENTS = 300
MAX_REQUESTS = 120
MAX_STEP_S = 6 * 3600.0
ACTIONS = ("verify", "heal", "rebalance", "set_replication", "set_filter", "purge_expired")
SEVERITY = {"info": 0, "warning": 1, "danger": 2}


def _number(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if number == number else default


class DataManagementStandIn:
    implementation = "stand_in"
    version = STAND_IN_VERSION

    def __init__(self, seed: int = 2042) -> None:
        self._seed = seed
        self._rng = random.Random(seed)
        self._sequence = 0
        self._now: float | None = None
        self._wall: str | None = None
        self._nodes: dict[str, dict] = {}
        self._objects: dict[str, dict] = {}
        self._jobs: dict[str, dict] = {}
        self._events: deque[dict] = deque(maxlen=MAX_EVENTS)
        self._requests: deque[dict] = deque(maxlen=MAX_REQUESTS)
        self._policy = default_policy()
        self._counters = {"ingested": 0, "ingested_mb": 0.0, "filtered": 0, "served": 0, "failed": 0, "healed": 0, "corrupt_found": 0, "purged": 0}
        self._samples: list[tuple[float, str, float]] = []   # (time, kind, value) for rolling-window rates
        self._object_counter = 0
        self._job_counter = 0
        self._event_counter = 0
        self._request_counter = 0
        self._next_auto_request_s: float | None = None
        self._next_verify_s: float | None = None
        self._capacity_warned: set[str] = set()

    # ---- bookkeeping ---------------------------------------------------------------------------

    def _emit(self, kind: str, severity: str, message: str, **payload: Any) -> dict:
        self._event_counter += 1
        event = {"sequence": self._event_counter, "time_s": round(self._now or 0.0, 3), "wall": self._wall, "kind": kind,
                 "severity": severity if severity in SEVERITY else "info", "message": message, **payload}
        self._events.append(event)
        return event

    def _sample(self, kind: str, value: float) -> None:
        self._samples.append((self._now or 0.0, kind, value))

    def _prune_samples(self) -> None:
        if self._now is None:
            return
        horizon = self._now - float(self._policy["window_s"])
        self._samples = [sample for sample in self._samples if sample[0] >= horizon]

    def _window(self, kind: str) -> list[float]:
        return [value for _, sample_kind, value in self._samples if sample_kind == kind]

    def _recount_usage(self) -> None:
        for node in self._nodes.values():
            node["used_gb"] = 0.0
            node["objects"] = 0
        for obj in self._objects.values():
            for replica in obj["replicas"]:
                node = self._nodes.get(replica["node"])
                if node and replica["state"] != "lost":
                    node["used_gb"] += obj["size_mb"] / 1000
                    node["objects"] += 1
        for node in self._nodes.values():
            node["used_gb"] = round(node["used_gb"], 6)

    def _target(self, obj: dict) -> int:
        return int(self._policy["replication"].get(obj["class"], DATA_CLASSES[obj["class"]]["replication"]))

    def _start_job(self, kind: str, obj: dict | None, target: str | None, duration_s: float, detail: str) -> dict:
        self._job_counter += 1
        job = {"id": f"JOB-{self._job_counter:05d}", "kind": kind, "object_id": obj["id"] if obj else None, "target": target,
               "started_s": round(self._now, 3), "eta_s": round(self._now + max(0.5, duration_s), 3), "progress": 0.0, "status": "running", "detail": detail}
        self._jobs[job["id"]] = job
        return job

    def _schedule_heal(self, obj: dict, reason: str) -> dict | None:
        if any(job["object_id"] == obj["id"] and job["kind"] == "heal" and job["status"] == "running" for job in self._jobs.values()):
            return None
        holding = {replica["node"] for replica in obj["replicas"] if replica["state"] not in DAMAGED_STATES}
        targets = choose_targets(self._nodes, None, obj["size_mb"], 1, exclude=holding)
        if not targets:
            obj["status"] = "critical" if counted_replicas(obj) == 0 else "degraded"
            obj["reason"] = "no_capacity_for_heal"
            self._emit("heal_blocked", "danger", f"{obj['id']} 복구 대상 노드 없음 (용량 또는 가용성)", object_id=obj["id"])
            return None
        duration = obj["size_mb"] * 8 / float(self._policy["heal_rate_mbps"])
        job = self._start_job("heal", obj, targets[0], duration, reason)
        self._emit("heal_started", "warning", f"{obj['id']} 자가복구 시작 → {targets[0]} ({reason})", object_id=obj["id"], job_id=job["id"], node=targets[0])
        return job

    # ---- time evolution --------------------------------------------------------------------------

    def _advance(self, to_s: float) -> float:
        if self._now is None:
            self._now = to_s
            self._next_auto_request_s = to_s + float(self._policy["auto_request_interval_s"])
            self._next_verify_s = to_s + float(self._policy["verify_interval_s"])
            return 0.0
        if to_s < self._now:
            # The simulation clock moved backwards: no reverse history exists, so the model restarts.
            self.__init__(self._seed)
            return self._advance(to_s)
        step = min(MAX_STEP_S, to_s - self._now)
        end = self._now + step
        self._progress_jobs(end)
        self._progress_sync(end)
        self._now = end
        self._auto_requests()
        self._periodic_verify()
        self._tiering_and_retention()
        self._outage_healing()
        self._recount_usage()
        self._capacity_watch()
        self._prune_samples()
        return step

    def _progress_sync(self, end: float) -> None:
        for obj in self._objects.values():
            changed = False
            for replica in obj["replicas"]:
                if replica["state"] in ("syncing", "stale") and replica.get("ready_s") is not None and replica["ready_s"] <= end:
                    replica["state"] = "verified"
                    replica["verified_s"] = replica["ready_s"]
                    replica["lag_s"] = round(max(0.0, replica["ready_s"] - obj["created_s"]), 3)
                    replica["ready_s"] = None
                    changed = True
            if changed:
                evaluate_status(obj, self._target(obj))

    def _progress_jobs(self, end: float) -> None:
        for job in list(self._jobs.values()):
            if job["status"] != "running":
                continue
            span = max(0.001, job["eta_s"] - job["started_s"])
            job["progress"] = round(max(0.0, min(1.0, (end - job["started_s"]) / span)), 4)
            if end < job["eta_s"]:
                continue
            job["status"] = "done"
            job["progress"] = 1.0
            job["finished_s"] = job["eta_s"]
            obj = self._objects.get(job["object_id"]) if job["object_id"] else None
            if job["kind"] == "heal" and obj:
                obj["replicas"] = [replica for replica in obj["replicas"] if replica["state"] not in DAMAGED_STATES or replica["node"] != job["target"]]
                obj["replicas"].append({"node": job["target"], "state": "verified", "placed_s": job["started_s"], "verified_s": job["eta_s"],
                                        "lag_s": round(job["eta_s"] - obj["created_s"], 3), "ready_s": None})
                # A damaged copy that was replaced is dropped from the catalogue.
                obj["replicas"] = [replica for replica in obj["replicas"] if replica["state"] not in DAMAGED_STATES]
                self._counters["healed"] += 1
                evaluate_status(obj, self._target(obj))
                self._emit("heal_completed", "info", f"{obj['id']} 자가복구 완료 → {job['target']}", object_id=obj["id"], job_id=job["id"], node=job["target"])
            elif job["kind"] == "verify":
                self._emit("verify_completed", "info", job["detail"], job_id=job["id"])
            elif job["kind"] == "rebalance":
                self._emit("rebalance_completed", "info", job["detail"], job_id=job["id"])
        finished = [job_id for job_id, job in self._jobs.items() if job["status"] == "done" and job.get("finished_s", 0) < (self._now or 0) - 3600]
        for job_id in finished[:-20] if len(finished) > 20 else []:
            del self._jobs[job_id]

    def _auto_requests(self) -> None:
        if self._next_auto_request_s is None:
            return
        while self._now >= self._next_auto_request_s:
            destinations = [node["id"] for node in self._nodes.values() if node["kind"] in ("core", "edge")]
            hot = [obj for obj in self._objects.values() if obj["status"] != "expired" and obj["tier"] == "hot"]
            if destinations and hot:
                obj = hot[self._rng.randrange(len(hot))]
                destination = destinations[self._rng.randrange(len(destinations))]
                self._serve({"object_id": obj["id"], "destination": destination, "requester": "auto"}, at=self._next_auto_request_s)
            interval = float(self._policy["auto_request_interval_s"])
            self._next_auto_request_s += interval * (0.6 + 0.8 * self._rng.random())

    def _periodic_verify(self) -> None:
        if self._next_verify_s is None:
            return
        while self._now >= self._next_verify_s:
            self._verify_pass(at=self._next_verify_s, label="주기 무결성 검사")
            self._next_verify_s += float(self._policy["verify_interval_s"])

    def _verify_pass(self, at: float, label: str) -> dict:
        checked = 0
        found = 0
        for obj in self._objects.values():
            if obj["status"] == "expired":
                continue
            for replica in obj["replicas"]:
                if replica["state"] != "verified":
                    continue
                checked += 1
                if self._rng.random() < float(self._policy["corruption_rate"]):
                    replica["state"] = "corrupt"
                    found += 1
                    self._counters["corrupt_found"] += 1
                    self._emit("integrity_failed", "danger", f"{obj['id']} 체크섬 불일치 @ {replica['node']}", object_id=obj["id"], node=replica["node"])
                else:
                    replica["verified_s"] = at
            obj["last_verified_s"] = at
            evaluate_status(obj, self._target(obj))
            if found and any(replica["state"] == "corrupt" for replica in obj["replicas"]):
                self._schedule_heal(obj, "integrity")
        return {"checked": checked, "corrupt": found, "label": label}

    def _tiering_and_retention(self) -> None:
        for obj in list(self._objects.values()):
            if obj["status"] == "expired":
                continue
            obj["tier"] = tier_for(obj, self._now)
            if expired(obj, self._now):
                obj["status"] = "expired"
                obj["reason"] = "retention"
                obj["replicas"] = []
                self._counters["purged"] += 1
                self._emit("retention_purged", "info", f"{obj['id']} 보존 기간 만료로 삭제", object_id=obj["id"])

    def _outage_healing(self) -> None:
        grace = float(self._policy["outage_grace_s"])
        for obj in self._objects.values():
            if obj["status"] == "expired":
                continue
            if counted_replicas(obj) >= self._target(obj):
                continue
            unreachable = [replica for replica in obj["replicas"] if replica["state"] == "unreachable"]
            if unreachable and all(self._now - replica.get("since_s", self._now) >= grace for replica in unreachable):
                self._schedule_heal(obj, "outage")
            elif not unreachable and counted_replicas(obj) < self._target(obj) and not any(replica["state"] in ("syncing", "stale") for replica in obj["replicas"]):
                self._schedule_heal(obj, "under_replicated")

    def _capacity_watch(self) -> None:
        ratio = float(self._policy["capacity_warning_ratio"])
        for node in overloaded(self._nodes, ratio):
            if node["id"] not in self._capacity_warned:
                self._capacity_warned.add(node["id"])
                self._emit("capacity_warning", "warning", f"{node['id']} 저장 사용률 {node['used_gb'] / node['capacity_gb'] * 100:.0f} %", node=node["id"])
        for node_id in list(self._capacity_warned):
            node = self._nodes.get(node_id)
            if not node or node["used_gb"] / node["capacity_gb"] < ratio * 0.9:
                self._capacity_warned.discard(node_id)

    # ---- ICD-01 messages ---------------------------------------------------------------------------

    def _clock(self, message: dict) -> float:
        if not isinstance(message, dict):
            raise ValueError("메시지는 객체여야 합니다.")
        if "sim_elapsed_s" not in message:
            raise ValueError("메시지에 sim_elapsed_s(트윈 시뮬레이션 경과 초)가 필요합니다.")
        at = _number(message.get("sim_elapsed_s"), -1.0)
        if at < 0:
            raise ValueError("sim_elapsed_s는 0 이상의 수여야 합니다.")
        self._wall = str(message.get("time") or self._wall or "")
        self._advance(at)
        return at

    def update_nodes(self, message: dict) -> dict:
        self._clock(message)
        roster = message.get("nodes")
        if not isinstance(roster, list):
            raise ValueError("nodes 목록이 필요합니다.")
        seen: set[str] = set()
        for record in roster:
            if not isinstance(record, dict) or not record.get("id"):
                raise ValueError("저장 노드에는 id가 필요합니다.")
            node_id = str(record["id"])
            if record.get("kind") not in NODE_KINDS:
                raise ValueError(f"저장 노드 {node_id}의 kind는 {', '.join(NODE_KINDS)} 중 하나여야 합니다.")
            if node_id in seen:
                raise ValueError(f"저장 노드 id가 중복됩니다: {node_id}")
            seen.add(node_id)
            available = bool(record.get("available", True))
            existing = self._nodes.get(node_id)
            node = existing or {"id": node_id, "used_gb": 0.0, "objects": 0, "available": True, "reason": None, "since_s": self._now}
            was_available = node["available"]
            node.update({"name": str(record.get("name") or node_id), "kind": record["kind"], "capacity_gb": max(0.0, _number(record.get("capacity_gb"))),
                         "available": available, "reason": record.get("reason")})
            if existing is None:
                self._nodes[node_id] = node
            if was_available and not available:
                node["since_s"] = self._now
                self._emit("node_unavailable", "danger", f"{node_id} 사용 불가 ({record.get('reason') or '사유 미상'})", node=node_id)
                for obj in self._objects.values():
                    for replica in obj["replicas"]:
                        if replica["node"] == node_id and replica["state"] in ("verified", "syncing", "stale"):
                            replica["state"] = "unreachable"
                            replica["since_s"] = self._now
                    evaluate_status(obj, self._target(obj))
            elif not was_available and available:
                node["since_s"] = self._now
                self._emit("node_recovered", "info", f"{node_id} 복귀, 복제본 재동기화", node=node_id)
                for obj in self._objects.values():
                    for replica in obj["replicas"]:
                        if replica["node"] == node_id and replica["state"] == "unreachable":
                            replica["state"] = "stale"
                            replica["ready_s"] = self._now + 5.0
                    evaluate_status(obj, self._target(obj))
        for node_id in [node_id for node_id in self._nodes if node_id not in seen]:
            del self._nodes[node_id]
        self._recount_usage()
        self._sequence += 1
        return {"sequence": self._sequence, "sim_elapsed_s": round(self._now, 3), "nodes": self._node_reports()}

    def ingest(self, message: dict) -> dict:
        self._clock(message)
        products = message.get("products")
        if not isinstance(products, list):
            raise ValueError("products 목록이 필요합니다.")
        if not self._nodes:
            raise ValueError("저장 노드 상태 갱신(DM-04)이 먼저 필요합니다.")
        self._sequence += 1
        known = {obj["ref"] for obj in self._objects.values()}
        accepted: list[dict] = []
        rejected: list[dict] = []
        for product in products:
            if not isinstance(product, dict):
                rejected.append({"ref": None, "reason": "malformed"})
                continue
            reason = filter_product(product, self._policy["filters"], known)
            if reason:
                rejected.append({"ref": product.get("ref"), "reason": reason})
                self._counters["filtered"] += 1
                self._sample("filtered", 1)
                continue
            self._object_counter += 1
            obj = make_object(f"OBJ-{self._object_counter:06d}", product, _number(product.get("created_s"), self._now))
            known.add(obj["ref"])
            targets = choose_targets(self._nodes, obj["source"] if obj["source"] in self._nodes else None, obj["size_mb"], self._target(obj))
            for index, node_id in enumerate(targets):
                if index == 0 and node_id == obj["source"]:
                    obj["replicas"].append({"node": node_id, "state": "verified", "placed_s": self._now, "verified_s": self._now, "lag_s": 0.0, "ready_s": None})
                else:
                    ready = self._now + 2.0 + obj["size_mb"] * 8 / float(self._policy["sync_rate_mbps"]) * (1 + 0.15 * index)
                    obj["replicas"].append({"node": node_id, "state": "syncing", "placed_s": self._now, "verified_s": None, "lag_s": None, "ready_s": round(ready, 3)})
                self._nodes[node_id]["used_gb"] = round(self._nodes[node_id]["used_gb"] + obj["size_mb"] / 1000, 6)
            if not targets:
                obj["status"] = "critical"
                obj["reason"] = "no_capacity"
                self._emit("placement_failed", "danger", f"{obj['id']} 저장 위치 없음 (용량 부족)", object_id=obj["id"])
            else:
                evaluate_status(obj, self._target(obj))
                if len(targets) < self._target(obj):
                    self._emit("under_replicated", "warning", f"{obj['id']} 복제본 {len(targets)}/{self._target(obj)}만 배치", object_id=obj["id"])
            self._objects[obj["id"]] = obj
            self._counters["ingested"] += 1
            self._counters["ingested_mb"] += obj["size_mb"]
            self._sample("ingested_mb", obj["size_mb"])
            self._sample("ingested", 1)
            accepted.append({"ref": obj["ref"], "object_id": obj["id"], "class": obj["class"], "replicas": [replica["node"] for replica in obj["replicas"]], "status": obj["status"]})
        if accepted:
            self._emit("ingest_completed", "info", f"{len(accepted)}건 수집 등록" + (f", {len(rejected)}건 필터링" if rejected else ""), count=len(accepted), rejected=len(rejected))
        self._recount_usage()
        return {"sequence": self._sequence, "accepted": accepted, "rejected": rejected}

    def _serve(self, query: dict, at: float | None = None) -> dict:
        self._request_counter += 1
        request_id = f"REQ-{self._request_counter:05d}"
        destination = str(query.get("destination") or "")
        obj = self._objects.get(str(query.get("object_id") or ""))
        if obj is None and query.get("class"):
            matches = [candidate for candidate in self._objects.values() if candidate["class"] == query["class"] and candidate["status"] != "expired"]
            obj = max(matches, key=lambda candidate: candidate["created_s"]) if matches else None
        record = {"id": request_id, "time_s": round(at if at is not None else self._now, 3), "object_id": obj["id"] if obj else query.get("object_id"),
                  "class": obj["class"] if obj else query.get("class"), "destination": destination, "requester": str(query.get("requester") or "operator"),
                  "status": "failed", "served_from": None, "latency_ms": None, "size_mb": obj["size_mb"] if obj else None, "reason": None}
        if obj is None or obj["status"] == "expired":
            record["reason"] = "object_not_found"
        elif destination and destination not in self._nodes:
            record["reason"] = "unknown_destination"
        else:
            replica = serving_replica(obj, self._nodes)
            if replica is None:
                record["reason"] = "no_available_replica"
            else:
                kind = self._nodes[replica["node"]]["kind"]
                record.update({"status": "served", "served_from": replica["node"], "latency_ms": serve_latency_ms(kind, obj["size_mb"])})
                obj["requests"] += 1
        if record["status"] == "served":
            self._counters["served"] += 1
            self._sample("served", 1)
            self._sample("latency_ms", float(record["latency_ms"]))
            self._sample("served_mb", float(record["size_mb"]))
        else:
            self._counters["failed"] += 1
            self._sample("failed", 1)
            self._emit("request_failed", "warning", f"{request_id} 서비스 실패 ({record['reason']})", request_id=request_id, object_id=record["object_id"])
        self._requests.append(record)
        return dict(record)

    def request(self, message: dict) -> dict:
        self._clock(message)
        if not message.get("object_id") and not message.get("class"):
            raise ValueError("object_id 또는 class가 필요합니다.")
        self._sequence += 1
        return {"sequence": self._sequence, **self._serve(message)}

    def action(self, message: dict) -> dict:
        self._clock(message)
        kind = str(message.get("action") or "")
        if kind not in ACTIONS:
            raise ValueError(f"알 수 없는 조치입니다: {kind or '(없음)'}. 가능: {', '.join(ACTIONS)}")
        result: dict[str, Any] = {"sequence": self._sequence + 1, "action": kind, "status": "done", "job_id": None, "detail": ""}
        if kind == "verify":
            obj = self._objects.get(str(message.get("object_id") or ""))
            scope = [obj] if obj else [candidate for candidate in self._objects.values() if candidate["status"] != "expired"]
            summary = self._verify_pass(self._now, "요청 무결성 검사")
            job = self._start_job("verify", obj, None, 1.0 + 0.02 * summary["checked"], f"무결성 검사 완료: 복제본 {summary['checked']}개 확인, 불일치 {summary['corrupt']}건")
            result.update({"status": "running", "job_id": job["id"], "detail": job["detail"], "checked": summary["checked"], "corrupt": summary["corrupt"], "objects": len(scope)})
        elif kind == "heal":
            obj = self._objects.get(str(message.get("object_id") or ""))
            if obj is None:
                targets = [candidate for candidate in self._objects.values() if candidate["status"] in ("degraded", "critical")]
                jobs = [job for job in (self._schedule_heal(candidate, "operator") for candidate in targets) if job]
                result.update({"status": "running" if jobs else "done", "detail": f"복구 작업 {len(jobs)}건 시작", "jobs": [job["id"] for job in jobs]})
            else:
                job = self._schedule_heal(obj, "operator")
                result.update({"status": "running" if job else "done", "job_id": job["id"] if job else None, "detail": job["detail"] if job else "복구 대상 아님 또는 진행 중"})
        elif kind == "rebalance":
            moved = 0
            ratio = float(self._policy["capacity_warning_ratio"])
            for node in overloaded(self._nodes, ratio):
                for obj in sorted(self._objects.values(), key=lambda candidate: -candidate["size_mb"]):
                    if node["used_gb"] / node["capacity_gb"] < ratio * 0.9:
                        break
                    replica = next((replica for replica in obj["replicas"] if replica["node"] == node["id"] and replica["state"] == "verified"), None)
                    if replica is None:
                        continue
                    holding = {candidate["node"] for candidate in obj["replicas"]}
                    targets = choose_targets(self._nodes, None, obj["size_mb"], 1, exclude=holding)
                    if not targets:
                        continue
                    replica["node"] = targets[0]
                    replica["state"] = "syncing"
                    replica["ready_s"] = self._now + 2.0 + obj["size_mb"] * 8 / float(self._policy["sync_rate_mbps"])
                    node["used_gb"] -= obj["size_mb"] / 1000
                    self._nodes[targets[0]]["used_gb"] += obj["size_mb"] / 1000
                    moved += 1
                    evaluate_status(obj, self._target(obj))
            job = self._start_job("rebalance", None, None, 3.0 + moved * 0.5, f"재균형 완료: 복제본 {moved}개 이동")
            result.update({"status": "running", "job_id": job["id"], "detail": job["detail"], "moved": moved})
        elif kind == "set_replication":
            name = str(message.get("class") or "")
            if name not in DATA_CLASSES:
                raise ValueError("알 수 없는 데이터 종류입니다.")
            factor = int(_number(message.get("replication"), -1))
            if factor < 1 or factor > 5:
                raise ValueError("복제 계수는 1~5 사이여야 합니다.")
            self._policy["replication"][name] = factor
            scheduled = 0
            for obj in self._objects.values():
                if obj["class"] != name or obj["status"] == "expired":
                    continue
                verified = [replica for replica in obj["replicas"] if replica["state"] == "verified"]
                if len(verified) > factor:
                    keep = set(id(replica) for replica in sorted(verified, key=lambda replica: replica["placed_s"])[:factor])
                    obj["replicas"] = [replica for replica in obj["replicas"] if replica["state"] != "verified" or id(replica) in keep]
                evaluate_status(obj, factor)
                if counted_replicas(obj) < factor and self._schedule_heal(obj, "policy"):
                    scheduled += 1
            self._recount_usage()
            self._emit("policy_changed", "info", f"{DATA_CLASSES[name]['label']} 복제 계수 {factor}로 변경 (복구 {scheduled}건)", cls=name, replication=factor)
            result.update({"detail": f"복제 계수 {factor} 적용, 복구 {scheduled}건", "scheduled": scheduled})
        elif kind == "set_filter":
            incoming = message.get("filter") or {}
            if not isinstance(incoming, dict):
                raise ValueError("filter는 객체여야 합니다.")
            filters = self._policy["filters"]
            if "min_size_mb" in incoming:
                value = _number(incoming["min_size_mb"], -1)
                if value < 0:
                    raise ValueError("min_size_mb는 0 이상이어야 합니다.")
                filters["min_size_mb"] = value
            if "accept_classes" in incoming:
                classes = [name for name in (incoming["accept_classes"] or []) if name in DATA_CLASSES]
                filters["accept_classes"] = sorted(classes) if classes else sorted(DATA_CLASSES)
            if "drop_priority_below" in incoming:
                filters["drop_priority_below"] = int(_number(incoming["drop_priority_below"], 0))
            if "dedupe_by_ref" in incoming:
                filters["dedupe_by_ref"] = bool(incoming["dedupe_by_ref"])
            self._emit("policy_changed", "info", f"필터 규칙 갱신: 최소 {filters['min_size_mb']} MB, 종류 {len(filters['accept_classes'])}개", filters=deepcopy(filters))
            result.update({"detail": "필터 규칙 적용", "filters": deepcopy(filters)})
        elif kind == "purge_expired":
            before = len(self._objects)
            self._objects = {object_id: obj for object_id, obj in self._objects.items() if obj["status"] != "expired"}
            removed = before - len(self._objects)
            self._recount_usage()
            result.update({"detail": f"만료 객체 {removed}건 정리", "removed": removed})
        self._sequence += 1
        return result

    # ---- reports -----------------------------------------------------------------------------------

    def _node_reports(self) -> list[dict]:
        reports = []
        for node in self._nodes.values():
            capacity = float(node["capacity_gb"])
            used = float(node.get("used_gb", 0.0))
            replicas = {"verified": 0, "syncing": 0, "stale": 0, "unreachable": 0, "corrupt": 0, "lost": 0}
            for obj in self._objects.values():
                for replica in obj["replicas"]:
                    if replica["node"] == node["id"]:
                        replicas[replica["state"]] = replicas.get(replica["state"], 0) + 1
            reports.append({"id": node["id"], "name": node["name"], "kind": node["kind"], "available": node["available"], "reason": node.get("reason"),
                            "capacity_gb": capacity, "used_gb": round(used, 3), "used_ratio": round(used / capacity, 4) if capacity else None,
                            "free_gb": round(free_gb(node), 3), "objects": node.get("objects", 0), "replicas": replicas,
                            "state": "down" if not node["available"] else "warning" if capacity and used / capacity >= float(self._policy["capacity_warning_ratio"]) else "ok"})
        return reports

    def _stability(self) -> dict:
        nodes = list(self._nodes.values())
        live = [obj for obj in self._objects.values() if obj["status"] != "expired"]
        if not live or not any(node["capacity_gb"] > 0 for node in nodes):
            return {"score": None, "grade": "unevaluated", "components": {
                key: None for key in ("availability", "replication", "integrity", "service", "headroom")}}
        availability = (sum(1 for node in nodes if node["available"]) / len(nodes)) if nodes else 1.0
        replication = (sum(1 for obj in live if counted_replicas(obj) >= self._target(obj)) / len(live)) if live else 1.0
        total_replicas = sum(len(obj["replicas"]) for obj in live)
        damaged = sum(1 for obj in live for replica in obj["replicas"] if replica["state"] in DAMAGED_STATES)
        integrity = (1 - damaged / total_replicas) if total_replicas else 1.0
        served = len(self._window("served"))
        failed = len(self._window("failed"))
        service = served / (served + failed) if served + failed else 1.0
        ratios = [node["used_gb"] / node["capacity_gb"] for node in nodes if node["capacity_gb"]]
        headroom = 1 - (sum(ratios) / len(ratios)) if ratios else 1.0
        score = 100 * (0.30 * availability + 0.25 * replication + 0.20 * integrity + 0.15 * service + 0.10 * headroom)
        grade = "stable" if score >= 90 else "caution" if score >= 70 else "unstable"
        return {"score": round(score, 1), "grade": grade, "components": {"availability": round(availability, 4), "replication": round(replication, 4),
                "integrity": round(integrity, 4), "service": round(service, 4), "headroom": round(headroom, 4)}}

    def overview(self) -> dict:
        window = float(self._policy["window_s"])
        live = [obj for obj in self._objects.values() if obj["status"] != "expired"]
        ingested_mb = sum(self._window("ingested_mb"))
        latencies = self._window("latency_ms")
        lags = [replica["lag_s"] for obj in live for replica in obj["replicas"] if replica.get("lag_s") is not None]
        by_status = {"healthy": 0, "degraded": 0, "critical": 0, "expired": 0, "pending": 0}
        by_class: dict[str, dict] = {}
        for obj in self._objects.values():
            by_status[obj["status"]] = by_status.get(obj["status"], 0) + 1
            entry = by_class.setdefault(obj["class"], {"label": DATA_CLASSES[obj["class"]]["label"], "objects": 0, "size_mb": 0.0, "replication": self._policy["replication"][obj["class"]]})
            if obj["status"] != "expired":
                entry["objects"] += 1
                entry["size_mb"] = round(entry["size_mb"] + obj["size_mb"], 3)
        total_capacity = sum(float(node["capacity_gb"]) for node in self._nodes.values())
        total_used = sum(float(node.get("used_gb", 0.0)) for node in self._nodes.values())
        running = [job for job in self._jobs.values() if job["status"] == "running"]
        alerts = []
        for node in self._nodes.values():
            if not node["available"]:
                alerts.append({"severity": "danger", "message": f"{node['id']} 사용 불가", "node": node["id"]})
        for node in overloaded(self._nodes, float(self._policy["capacity_warning_ratio"])):
            alerts.append({"severity": "warning", "message": f"{node['id']} 저장 사용률 {node['used_gb'] / node['capacity_gb'] * 100:.0f} %", "node": node["id"]})
        if by_status["critical"]:
            alerts.append({"severity": "danger", "message": f"검증된 복제본이 없는 객체 {by_status['critical']}건"})
        if by_status.get("degraded"):
            alerts.append({"severity": "warning", "message": f"복제 부족 또는 무결성 손상 객체 {by_status['degraded']}건"})
        return {
            "sequence": self._sequence, "sim_elapsed_s": round(self._now or 0.0, 3), "time": self._wall,
            "implementation": self.implementation, "version": self.version,
            "stability": self._stability(),
            "stages": {
                "ingested": len(self._window("ingested")), "filtered": len(self._window("filtered")),
                "stored": sum(1 for obj in live if counted_replicas(obj) >= 1),
                "replicated": sum(1 for obj in live if counted_replicas(obj) >= self._target(obj)),
                "served": len(self._window("served")), "failed": len(self._window("failed")), "window_s": window,
            },
            "metrics": {
                "ingest_mbps": round(ingested_mb * 8 / window, 3), "served_mbps": round(sum(self._window("served_mb")) * 8 / window, 3),
                "mean_latency_ms": round(sum(latencies) / len(latencies), 1) if latencies else None,
                "mean_sync_lag_s": round(sum(lags) / len(lags), 2) if lags else None,
                "max_sync_lag_s": round(max(lags), 2) if lags else None,
                "objects": len(live), "replicas": sum(len(obj["replicas"]) for obj in live),
                "verified_replicas": sum(counted_replicas(obj) for obj in live),
                "damaged_replicas": sum(1 for obj in live for replica in obj["replicas"] if replica["state"] in DAMAGED_STATES),
                "healing_jobs": sum(1 for job in running if job["kind"] == "heal"),
                "running_jobs": len(running),
            },
            "capacity": {"total_gb": round(total_capacity, 3), "used_gb": round(total_used, 3), "used_ratio": round(total_used / total_capacity, 4) if total_capacity else None,
                         "nodes": len(self._nodes), "available_nodes": sum(1 for node in self._nodes.values() if node["available"])},
            "objects_by_status": by_status, "objects_by_class": by_class,
            "counters": deepcopy(self._counters), "policy": deepcopy(self._policy),
            "jobs": [dict(job) for job in sorted(self._jobs.values(), key=lambda job: job["started_s"], reverse=True)[:20]],
            "requests": [dict(record) for record in list(self._requests)[-20:]][::-1],
            "alerts": alerts,
        }

    def objects(self, filters: dict | None = None) -> dict:
        filters = filters or {}
        items = [obj for obj in self._objects.values()]
        if filters.get("class"):
            items = [obj for obj in items if obj["class"] == filters["class"]]
        if filters.get("node"):
            items = [obj for obj in items if any(replica["node"] == filters["node"] for replica in obj["replicas"])]
        if filters.get("status"):
            items = [obj for obj in items if obj["status"] == filters["status"]]
        if filters.get("query"):
            needle = str(filters["query"]).lower()
            items = [obj for obj in items if needle in obj["id"].lower() or needle in obj["label"].lower() or needle in obj["source"].lower()]
        items.sort(key=lambda obj: obj["created_s"], reverse=True)
        limit = int(_number(filters.get("limit"), 200) or 200)
        return {"sequence": self._sequence, "total": len(items), "items": [public_object(obj) for obj in items[:max(1, min(limit, 1000))]]}

    def nodes(self) -> dict:
        return {"sequence": self._sequence, "nodes": self._node_reports()}

    def events(self, after: int = 0) -> dict:
        after = int(after or 0)
        items = [dict(event) for event in self._events if event["sequence"] > after]
        return {"sequence": self._sequence, "latest": self._event_counter, "items": items[-120:]}

    def status(self) -> dict:
        return {
            "module": "data_management", "implementation": self.implementation, "version": self.version,
            "placement": "embedded", "endpoint": "in-process", "sequence": self._sequence,
            "last_update": self._wall, "sim_elapsed_s": round(self._now or 0.0, 3),
            "objects": len(self._objects), "nodes": len(self._nodes), "reachable": True,
        }
