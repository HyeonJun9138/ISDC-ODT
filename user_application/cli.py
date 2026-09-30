from __future__ import annotations

import argparse
import os
import socket
import threading
import time
import webbrowser

import uvicorn

from user_application.configs.paths import DEFAULT_HOST, ROOT_DIR


WILDCARD_HOSTS = {"0.0.0.0", "::"}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="SpaceTwin VVP 실행기")
    parser.add_argument(
        "--host",
        default=DEFAULT_HOST,
        help=f"수신 주소 (기본값: {DEFAULT_HOST})",
    )
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true", help="브라우저를 자동으로 열지 않음")
    parser.add_argument("--reload", action="store_true", help="개발용 자동 재시작")
    parser.add_argument("--data-fabric-url", default="", help="별도 프로세스의 데이터 패브릭 모듈 주소 (예: http://127.0.0.1:8792). 비우면 내장 임시 구현을 쓴다")
    parser.add_argument("--data-management-url", default="", help="별도 프로세스의 데이터 관리 모듈 주소 (예: http://127.0.0.1:8793). 비우면 내장 임시 구현을 쓴다")
    parser.add_argument("--orchestration-url", default="", help="별도 프로세스의 군집 운용 모듈 주소 (예: http://127.0.0.1:5103). 비우면 내장 임시 구현을 쓴다")
    return parser.parse_args(argv)


def open_browser(url: str) -> None:
    time.sleep(1.2)
    webbrowser.open(url)


def primary_ipv4() -> str:
    """Return the IPv4 address selected by the OS for outbound traffic."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return str(sock.getsockname()[0])
    except OSError:
        try:
            return socket.gethostbyname(socket.gethostname())
        except OSError:
            return "127.0.0.1"


def host_url(host: str, port: int) -> str:
    formatted = f"[{host}]" if ":" in host and not host.startswith("[") else host
    return f"http://{formatted}:{port}"


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    browser_host = "127.0.0.1" if args.host in WILDCARD_HOSTS else args.host
    browser_url = host_url(browser_host, args.port)
    share_host = primary_ipv4() if args.host in WILDCARD_HOSTS else args.host
    share_url = host_url(share_host, args.port)
    if not args.no_browser:
        threading.Thread(target=open_browser, args=(browser_url,), daemon=True).start()
    print(f"\nSpaceTwin VVP")
    print(f"서버 접속  →  {share_url}")
    if browser_url != share_url:
        print(f"로컬 접속  →  {browser_url}")
    print(f"수신 주소  →  {args.host}:{args.port}")
    if args.data_fabric_url:
        os.environ["SPACETWIN_DATA_FABRIC_URL"] = args.data_fabric_url
        print(f"데이터 패브릭  →  외부 {args.data_fabric_url}")
    else:
        os.environ.pop("SPACETWIN_DATA_FABRIC_URL", None)
        print("데이터 패브릭  →  내장 임시 구현")
    if args.data_management_url:
        os.environ["SPACETWIN_DATA_MANAGEMENT_URL"] = args.data_management_url
        print(f"데이터 관리  →  외부 {args.data_management_url}")
    else:
        os.environ.pop("SPACETWIN_DATA_MANAGEMENT_URL", None)
    if args.orchestration_url:
        os.environ["SPACETWIN_ORCHESTRATION_URL"] = args.orchestration_url
        print(f"군집 운용  →  외부 {args.orchestration_url}")
    else:
        os.environ.pop("SPACETWIN_ORCHESTRATION_URL", None)
        print("데이터 관리  →  내장 임시 구현")
    print("종료: Ctrl+C\n")
    uvicorn.run("user_application.web.application:create_app", factory=True, host=args.host, port=args.port, reload=args.reload, reload_dirs=[str(ROOT_DIR)] if args.reload else None, log_level="info")
