"""Temporary stand-in for the data fabric software (데이터 송수신 기술).

The partner organisation owns the real routing, DTN and optical link logic. This package keeps a
small, deterministic version of that logic so the digital twin can be developed and verified now.
It receives the network state the twin measures or simulates (ICD-02 "네트워크 상태 갱신") and
returns link quality, ground paths and store-and-forward state.
"""
from .stand_in import DataFabricStandIn, STAND_IN_VERSION

__all__ = ["DataFabricStandIn", "STAND_IN_VERSION"]
