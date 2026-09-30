"""Temporary stand-in for the data management software (데이터 관리, DataManagementModule).

The partner organisation owns the real data center software. This package keeps a small,
deterministic version of its four functions so the digital twin can be developed and verified
now: extraction and filtering of registered products, distributed placement (DFS), replication
with synchronisation and integrity checks, and self-healing. It answers the ICD-01 messages and
never imports the digital twin.
"""
from .stand_in import DataManagementStandIn, STAND_IN_VERSION
from .scopes import ScopedDataManagement

__all__ = ["DataManagementStandIn", "STAND_IN_VERSION"]
