# PoC 시나리오 재생 콘솔 구현 계획

작성일: 2026-09-08. 사용자가 요청한 "시나리오 선택 → 세팅 → 재생 → 통신·데이터·보안·임무 동시 갱신 → 단계별 안내"를 구현하는 작업의 범위와 파일 소유를 적는다. 동시에 작업하는 다른 에이전트는 아래 "이 작업이 수정하는 파일"을 피하거나 앵커 기반으로만 편집한다.

## 목표

- 대시보드 상단에서 PoC 시나리오를 고르고 세팅하면 노드(위성 40기), 지상국, 임무(ICD-03 편성·확정)가 한 번에 구성된다.
- 재생하면 서버 SIM 시계가 시나리오 시계가 되고 모든 탭의 분석 시계가 이를 따른다. 단계마다 정해진 조치(장애 주입, 재구성, 서비스 요청)가 실행되고 안내 창이 해당 탭으로 이끈다.
- 통신(ICD-02), 데이터(ICD-01), 보안(ICD-08), 임무(ICD-03) 교환이 탭이 보이지 않아도 계속되며, 단계별 KPI를 모아 정상 대비 장애·복구를 판정한다(ICD-06 검증 지원의 내장 구현).
- ICD 관리표를 실제 구현 메시지로 다시 정의하고 구현 여부를 표시한다.

## 모듈 배치

| 책임 | 위치 |
|---|---|
| 시나리오 정의(운용 구성, 데이터) | `user_application/configs/scenarios.py` |
| 시나리오 조회·시계 전진 API | `communication/http/scenarios.py`, `communication/http/runtime.py`, `digital_twin/runtime/state.py` |
| 정의 → 위성·지상국·임무 조립(순수 함수) | `digital_twin/model_library/browser/scenario_assembly.js` |
| KPI 표본과 복구 판정(순수 함수) | `digital_twin/verification/browser/scenario_kpi.js` |
| 브라우저 DT 네트워크 상태의 단일 소유자와 ICD-02 교환 | `user_application/web/scripts/communication/network_twin.js` |
| ICD-03 요청 구성과 편성(임무 탭과 재생기가 공유) | `user_application/web/scripts/missions/planner.js` |
| 시나리오 시계(서버 SIM 시계 추종) | `user_application/web/scripts/scenario/clock.js`, `scripts/orbit/clock.js`의 추종 모드 |
| 재생기 상태 기계와 조치 실행 | `user_application/web/scripts/scenario/runner.js` |
| 안내 창·도크·대화상자 | `user_application/web/scripts/scenario/console.js`, `styles/scenario.css` |
| 군집 운용 실행 확정 통보(OR-03) | `operations_software/orchestration/stand_in.py`, `communication/http/orchestration.py`, `communication/external/orchestration.py`, `communication/browser/orchestration.js` |
| ICD 관리표 | `user_application/web/scripts/settings/topology.js` |

## 이 작업이 수정하는 기존 파일

`index.html`, `app.js`, `api.js`, `orbit/clock.js`, `tabs/communication.js`(tick·sendSnapshot·pollStatus·requestRoute를 network_twin에 위임), `tabs/mission.js`(창 계산과 요청 구성을 planner로 이동, 실행 확정 통보), `tabs/nodes.js`(공유 배치 클라이언트), `nodes/data_deployment.js`, `settings/topology.js`, `tabs/settings.js`, `application.py`, `schemas.py`, `orchestration_schemas.py`, `contracts/orchestration.py`, `contracts/runtime.py`, `runtime/state.py`, `configs/scenarios.py`, 문서.

## 구현 결과

계획한 배치대로 구현했고 사용 방법, 실행 규칙, 한계는 [시나리오 재생 콘솔](scenario_console.md)에, 모듈 구분은 [모듈 구분: 디지털 트윈과 협력 운용 SW](../architecture/modules.md)에 옮겨 적었다. 계획과 다른 점: 궤도면을 가리는 OISL 단말 대상 선택 규칙(`nodes/links.js`)과 정적 모듈의 `Cache-Control: no-cache`가 추가됐고, 재생기의 틱은 한 번에 하나만 돌도록 합쳤다.

## 검증

Python: 시나리오 정의 유효성과 API, 시계 전진, 실행 확정 통보. JavaScript: 조립, KPI 판정, 재생기 상태 기계(가짜 의존성), 시계 추종, planner의 장애 링크 제외, network_twin 단일 이력. 브라우저: 세팅 → 재생 → 5단계 → 판정까지 실제 화면 확인.
