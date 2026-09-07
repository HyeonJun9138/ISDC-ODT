from __future__ import annotations

from fastapi import APIRouter, Request
from .dependencies import runtime_of
from .schemas import DeviceAction, HilSequenceRequest, RecordingControl

router = APIRouter()


@router.post("/api/hil/device")
async def device_action(request: Request, command: DeviceAction) -> dict:
    runtime = runtime_of(request)
    return await runtime.device_action(command.device_id, command.action)


@router.get("/api/hil/preflight")
async def hil_preflight(request: Request) -> dict:
    runtime = runtime_of(request)
    return runtime.hil_preflight()


@router.post("/api/hil/sequence")
async def hil_sequence(request: Request, command: HilSequenceRequest) -> dict:
    runtime = runtime_of(request)
    return await runtime.run_hil_sequence(command.sequence_id)


@router.post("/api/hil/recording")
async def hil_recording(request: Request, command: RecordingControl) -> dict:
    runtime = runtime_of(request)
    return await runtime.set_recording(command.enabled)
