"""Module connection probe for the settings tab's topology (ICD register).

The console sends the links it wants checked with the transport and endpoint the operator configured.
Links whose endpoint is this process (IPC, localhost, 127.x, "self", "in-process") are checked in
process: both end modules must answer, and embedded partner stand-ins report their own status. Links
pointed at another computer are really probed: TCP-style transports (TCP, WebSocket, gRPC) get a
bounded TCP connect, UDP can only have its address resolved and is reported as unverified.
"""
from __future__ import annotations

import asyncio
import socket
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool

from digital_twin.contracts.data_fabric import DataFabricUnavailable
from digital_twin.contracts.security import SecurityUnavailable
from .dependencies import data_fabric_of, queries_of, runtime_of
from .schemas import ProbeLink, ProbeRequest

router = APIRouter()

LOCAL_HOSTS = {"", "self", "in-process", "localhost", "::1"}


def is_local_host(host: str | None) -> bool:
    value = (host or "").strip().lower()
    return value in LOCAL_HOSTS or value.startswith("127.")


def _elapsed_ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 1)


async def probe_tcp(host: str, port: int, timeout_s: float) -> dict:
    """Open and immediately close a TCP connection; no payload is ever sent."""
    started = time.perf_counter()
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout_s)
    except asyncio.TimeoutError:
        return {"state": "down", "method": "tcp-connect", "latency_ms": None, "detail": f"{host}:{port} 응답 없음 · {timeout_s:g}s 초과"}
    except OSError as error:
        reason = error.strerror or error.__class__.__name__
        return {"state": "down", "method": "tcp-connect", "latency_ms": None, "detail": f"{host}:{port} 연결 실패 · {reason}"}
    latency = _elapsed_ms(started)
    writer.close()
    try:
        await writer.wait_closed()
    except OSError:
        pass
    return {"state": "up", "method": "tcp-connect", "latency_ms": latency, "detail": f"{host}:{port} TCP 연결 성공"}


async def probe_udp(host: str, port: int, timeout_s: float) -> dict:
    """UDP has no handshake: the most we can confirm is that the address resolves."""
    loop = asyncio.get_running_loop()
    started = time.perf_counter()
    try:
        await asyncio.wait_for(loop.getaddrinfo(host, port, type=socket.SOCK_DGRAM), timeout_s)
    except (asyncio.TimeoutError, OSError):
        return {"state": "down", "method": "udp-resolve", "latency_ms": None, "detail": f"{host} 주소 해석 실패"}
    return {"state": "unverified", "method": "udp-resolve", "latency_ms": _elapsed_ms(started),
            "detail": f"{host}:{port} 주소 해석 성공 · UDP는 응답을 확인할 수 없음"}


async def embedded_check(request: Request, module_id: str) -> tuple[bool, str]:
    """Liveness of a module that runs inside this process."""
    runtime = runtime_of(request)
    if module_id == "framework":
        return True, "프레임워크 응답"
    if module_id == "engine":
        status = runtime.status()
        return True, f"런타임 {'실행' if status.get('running') else '정지'} · seq {status.get('sequence', 0)}"
    if module_id == "model":
        network = queries_of(request).network()
        nodes, links = len(network.get("nodes", [])), len(network.get("links", []))
        return nodes > 0, f"모델 노드 {nodes} · 링크 {links}"
    if module_id == "swarm-model":
        count = len(getattr(runtime, "scenarios", None) or [])
        return count > 0, f"시나리오 {count}건"
    if module_id == "data-fabric":
        fabric = data_fabric_of(request)
        try:
            status = await run_in_threadpool(fabric.status)
        except DataFabricUnavailable as error:
            return False, str(error)
        placement = "원격" if status.get("placement") == "remote" else "내장"
        return bool(status.get("reachable", True)), f"데이터 패브릭 {status.get('implementation', '?')} v{status.get('version', '?')} · {placement}"
    if module_id == "security-ops":
        module = getattr(request.app.state, "security", None)
        if module is None:
            return False, "보안 운용 SW 미연동"
        try:
            status = await run_in_threadpool(module.status)
        except SecurityUnavailable as error:
            return False, f"보안 운용 SW 응답 오류: {error}"
        placement = "외부" if status.get("placement") == "remote" else "내장"
        detail = (f"보안 운용 SW {status.get('implementation', '?')} "
                  f"계약 {status.get('contract_version', '?')} / {placement} / "
                  f"실제 주소 {status.get('endpoint') or 'in-process'} / SIM 규칙 판정 (실측 아님)")
        return status.get("reachable") is True, detail
    if module_id == "security-external":
        return False, "외부 보안 시스템 미연동, 실제 프로토콜 확인 근거 없음"
    return True, "내장 스텁 · 구현 전"


async def probe_link(request: Request, link: ProbeLink) -> dict:
    started = time.perf_counter()
    transport = link.transport.upper()
    if "security-external" in link.endpoints or ("security-ops" in link.endpoints and transport != "IPC"):
        if transport == "IPC" or link.host in {"", "self", "in-process", "미지정"} or not link.port:
            return {"state": "unverified", "method": "not-configured", "latency_ms": None,
                    "detail": "보안 연동 미연동, 진단 주소 미지정 또는 외부 시스템 IPC 사용 불가"}
        result = (await probe_udp(link.host, link.port, link.timeout_s) if transport == "UDP"
                  else await probe_tcp(link.host, link.port, link.timeout_s))
        if result["state"] == "up":
            result["state"] = "unverified"
            result["detail"] = f"{link.host}:{link.port} TCP 도달 가능, 보안 프로토콜 미검증"
        return result
    if transport == "IPC" or is_local_host(link.host):
        alive, details = True, []
        for module_id in link.endpoints:
            ok, detail = await embedded_check(request, module_id)
            alive = alive and ok
            details.append(detail)
        note = f" · 예정 엔드포인트 {link.host}:{link.port}" if transport != "IPC" and link.port else ""
        return {"state": "up" if alive else "down", "method": "in-process", "latency_ms": _elapsed_ms(started),
                "detail": (" · ".join(details) or "내장") + note}
    if transport == "UDP":
        return await probe_udp(link.host, link.port, link.timeout_s)
    return await probe_tcp(link.host, link.port, link.timeout_s)


@router.post("/api/integration/probe")
async def integration_probe(request: Request, body: ProbeRequest) -> dict:
    """Check every requested link concurrently and report per-link state, method, latency and detail."""
    results = await asyncio.gather(*(probe_link(request, link) for link in body.links))
    return {
        "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "results": {link.id: result for link, result in zip(body.links, results)},
    }
