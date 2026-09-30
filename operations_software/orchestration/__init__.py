"""Temporary stand-in for the constellation operations software (SDC 군집 운용 SW, ICD-03).

The partner organisation owns the real task assignment and reconfiguration logic. This package
keeps a small deterministic scheduler so the digital twin's mission console can be developed and
verified now. It receives a mission request together with the access, contact, crosslink and
eclipse windows the twin computed (ICD-03 "임무 편성 요청") and answers with the satellite tasks,
a feasibility verdict and the checks behind it (ICD-03 "역할 배정 결과").
"""
from .stand_in import OrchestrationStandIn, STAND_IN_VERSION

__all__ = ["OrchestrationStandIn", "STAND_IN_VERSION"]
