from __future__ import annotations

import asyncio
import json
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from .dependencies import runtime_of, queries_of

router = APIRouter()


@router.websocket("/ws/telemetry")
async def telemetry_socket(websocket: WebSocket) -> None:
    runtime = runtime_of(websocket)
    await websocket.accept()
    try:
        while True:
            payload = runtime.telemetry()
            payload["analytics"] = queries_of(websocket).evaluate(runtime.snapshot())
            await websocket.send_text(json.dumps(payload, ensure_ascii=False, default=str))
            await asyncio.sleep(1.0)
    except WebSocketDisconnect:
        return
    except Exception:
        try:
            await websocket.close()
        except Exception:
            pass
