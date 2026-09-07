# 구조 개편 실행 계획

**Goal:** 승인된 aerospace framework 경계에 기존 구현을 재배치하고 main 실행과 공동 개발 규칙을 검증한다.
**Architecture:** 사용자 앱이 상태, 카탈로그와 HTTP 어댑터를 조립한다. 계산과 렌더링은 digital_twin, 외부 I/O는 communication, 저장과 조회는 data로 분리한다.
**Tech Stack:** Python, FastAPI, pytest, 브라우저 ES modules, Cesium, satellite.js. 새 런타임 의존성 없음.
**Spec:** ../architecture/design.md

## 공통 제약

기존 수치와 API를 보존하고 미구현 계층을 만들지 않는다. AeroDT와 원본 백업은 수정하지 않는다. 객체별 상태 격리와 명시적 의존성 주입을 적용한다. 사용자 지정 프로젝트에서 직접 작업한다. Git 저장소가 아니므로 worktree와 commit은 적용하지 않는다.

## 작업 순서

- [x] 원본 구조, 프레임워크, AeroDT 규칙 확인. 기존 시험 10개 통과. ZIP 백업 확보.
- [x] 규칙 문서 작성 및 신규 경계 시험 먼저 작성. `python -m pytest project_support/tests/test_structure.py -q`로 기존 코드에서 실패 확인.
- [x] 순수 계산, 모델 정의, 내부 계약 분리. runtime 메서드는 잠금을 유지하고 계산 모듈을 호출. 기존 기준값 및 상태 변경 시험 실행.
- [x] CelesTrak HTTP와 저장 및 조회 정책 분리. API마다 카탈로그 객체 주입. 임시 경로와 httpx MockTransport로 외부 I/O만 대체하여 실제 조회 및 캐시 흐름 시험.
- [x] HTTP routers를 기능별로 분리하고 application factory에서 조립. `create_app()`별 상태 격리, WebSocket, export 시험.
- [x] 웹 UI와 visualization, API client 재배치. main을 CLI 호출만 남기고 임의 cwd 실행 및 포트 충돌 시험. Ref/docs/tests 이동 및 import 경로 갱신.
- [x] 전체 pytest, JavaScript 문법/import 검증 및 실제 브라우저 확인. 개발 완료 기록과 README 갱신.

## 인터페이스

`RuntimeState`는 초기 missions/devices/scenarios를 주입받으며 기존 async command API를 유지한다. `snapshot()`은 KPI 판정용 분리된 RuntimeSnapshot을 반환한다. `Catalog`는 외부 source와 CatalogCache를 주입받아 `get_satellites`, `get_satellite_profile`, `catalog_groups`를 제공한다. `create_app()`은 app.state에 조립된 객체를 보관하며 lifespan에서 시계를 시작하고 종료한다. `main(argv=None)`은 CLI 실행을 맡는다.
