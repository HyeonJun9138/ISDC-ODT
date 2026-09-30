"""Independent ICD-01 catalogues addressed explicitly, never a global destructive reset."""
import threading
from copy import deepcopy

from .stand_in import DataManagementStandIn

SCOPE_CONTRACT = "isolated-v1"


class ScopedDataManagement:
    implementation = "stand_in"

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._scopes: dict[str, DataManagementStandIn] = {}

    def for_scope(self, scope_id: str):
        if not isinstance(scope_id, str) or not scope_id or len(scope_id) > 240:
            raise ValueError("유효한 scope_id가 필요합니다.")
        return DataManagementScope(self, scope_id)

    def status(self) -> dict:
        return {"module": "data_management", "implementation": self.implementation, "placement": "embedded",
                "endpoint": "in-process", "reachable": True, "scope_contract": SCOPE_CONTRACT}

    def call(self, scope_id: str, method: str, *args) -> dict:
        with self._lock:
            state = self._scopes.get(scope_id)
            if state is None:
                state = self._scopes[scope_id] = DataManagementStandIn()
            if method == "ingest":
                roster = {node["id"]: node for node in state.nodes()["nodes"]}
                for product in args[0].get("products", []):
                    source = roster.get(product.get("source"))
                    if not source or not source["available"] or source["capacity_gb"] <= 0:
                        raise ValueError("제품 원본은 현재 범위의 가용 저장 노드여야 합니다.")
            if method in ("action", "request"):
                roster = state.nodes()["nodes"]
                if not any(node["available"] and node["capacity_gb"] > 0 for node in roster):
                    raise ValueError("현재 범위에 가용 저장소가 없습니다.")
                if method == "request" and args[0].get("destination") not in {node["id"] for node in roster if node["available"] and node["capacity_gb"] > 0}:
                    raise ValueError("서비스 목적지는 현재 범위의 가용 저장 노드여야 합니다.")
            result = getattr(state, method)(*args)
            return {**deepcopy(result), "scope_id": scope_id, "scope_contract": SCOPE_CONTRACT}


class DataManagementScope:
    implementation = "stand_in"

    def __init__(self, owner: ScopedDataManagement, scope_id: str) -> None:
        self._owner, self.scope_id = owner, scope_id

    def update_nodes(self, message):
        return self._owner.call(self.scope_id, "update_nodes", message)

    def ingest(self, message):
        return self._owner.call(self.scope_id, "ingest", message)

    def request(self, message):
        return self._owner.call(self.scope_id, "request", message)

    def action(self, message):
        return self._owner.call(self.scope_id, "action", message)

    def overview(self):
        return self._owner.call(self.scope_id, "overview")

    def nodes(self):
        return self._owner.call(self.scope_id, "nodes")

    def objects(self, filters=None):
        return self._owner.call(self.scope_id, "objects", filters)

    def events(self, after=0):
        return self._owner.call(self.scope_id, "events", after)

    def status(self):
        return self._owner.call(self.scope_id, "status")
