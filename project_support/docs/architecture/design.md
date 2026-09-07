# SpaceTwin 구조 개편 설계

2026-09-07 사용자가 승인한 구조안을 구현한다. AeroDT는 읽기 전용 참고이며 현재 프로젝트의 Python과 브라우저 JavaScript 구현을 그대로 사용한다.

## 범위와 완료 조건

기존 5개 화면, REST 경로, WebSocket payload, 모의 계산 결과, 카탈로그 캐시 정책을 유지한다. 실행은 루트 main.py를 사용한다. 기존 backend와 frontend를 책임별로 해체하고 코드, 생성 데이터, 참조 자료를 구분한다. 빈 AI 계층이나 실제 장비 연동 기능은 만들지 않는다. 공동 작업자는 DEVELOPMENT.md와 AGENTS.md를 읽고 같은 명명 및 의존성 규칙을 적용한다.

## 경계

- communication: FastAPI 요청 및 응답, WebSocket, 외부 CelesTrak HTTP, 브라우저 API 클라이언트. 계산이나 현재 상태를 소유하지 않는다.
- data: 카탈로그 gzip 저장, 메모리 조회와 갱신 정책, CSV/JSON 직렬화. workspace는 생성물이며 정적 웹 경로로 노출하지 않는다.
- digital_twin/contracts: 내부 스냅샷과 상태 조작 API 계약. FastAPI 및 디스크 경로에 의존하지 않는다.
- digital_twin/model_library: 기존 데모 위성, 통신망, 모의 장비 정의. 사본을 반환하며 실행 상태는 소유하지 않는다.
- digital_twin/simulation: 결정론적 텔레메트리, RF 링크 및 경로 계산, 궤도요소 계산, 모의 HIL 판정. 네트워크와 저장소를 호출하지 않는다.
- digital_twin/runtime: 시계와 현재 상태의 단일 소유자. 임무 및 HIL 상태 변경은 이 영역의 잠금 아래에서 수행한다. 분리한 모듈이 별도 현재 상태를 복제하지 않는다.
- digital_twin/visualization: 지구, 궤도, 차트 표현. 서버 상태를 변경하지 않고 DOM 및 렌더러를 관리한다.
- user_application: 객체 조립과 생명주기, CLI, 운용 시나리오 및 초기 임무, 웹 화면의 사용자 흐름. 상위 조립 지점이 하위 모듈에 필요한 설정과 의존성을 전달한다.
- project_support: 규칙, 설계, 시험, 도구, 참고 자료. 실제 앱에서 참조 자료를 import하지 않는다.

## 실행 및 데이터 흐름

main -> CLI -> application factory -> runtime / catalog / HTTP routers / 웹 자산.
CelesTrak HTTP adapter -> data catalog -> 궤도요소 정규화 -> 응답 -> 브라우저 SGP4 -> 시각화.
사용자 명령 -> HTTP schema -> runtime -> snapshot -> KPI 판정 -> WebSocket 또는 export.

API factory 호출마다 별도 runtime 및 catalog를 만든다. import만으로 시계나 네트워크를 시작하지 않는다. 경로는 파일 위치 기준으로 계산하여 임의 작업 디렉터리에서도 main을 실행할 수 있게 한다. 기존 main의 다른 프로세스 자동 종료는 재구성 작업 중 실행하지 않으며 신규 진입점에서는 사용 중인 포트 오류를 정상 보고한다.

## 보존할 한계

GP는 실측 텔레메트리가 아니다. 현재 HIL은 메모리 기반 MOCK이며 recording은 상태 플래그다. 영구 운용 이력 및 replay 기능은 구현하지 않는다. 임무 재계획은 기존 규칙이며 AI가 아니다. KPI는 SIM 판정이다. 이 한계를 문서와 UI 데이터 provenance에서 유지한다.

## 검증

기존 10개 시험을 먼저 실행한 뒤 이동한다. 신규 시험은 앱 간 상태 격리, 시계 종료, 스냅샷 분리, 계산 기준값, 카탈로그 성공/캐시/stale/오프라인, gzip 저장, REST/WS/export, 정적 JS import, 임의 cwd의 main 실행과 계층 의존성을 다룬다. 브라우저에서 기존 화면을 확인한다. 백업을 남기고 Git을 새로 초기화하거나 AeroDT를 수정하지 않는다.
