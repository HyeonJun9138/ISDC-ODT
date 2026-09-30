# 모듈 구분: 디지털 트윈과 협력 운용 SW

2026-09-08 기준으로 SpaceTwin VVP를 이루는 모듈을 "디지털 트윈이 소유하는 것"과 "타 기관 운용 SW가 소유하는 것"으로 나누고, 두 쪽이 어떤 ICD 메시지로만 이어지는지를 적는다. 계층 규칙 자체는 [계층 설계](design.md)와 [개발 규칙서](../DEVELOPMENT.md)에 있고, 이 문서는 그 규칙을 현재 구현된 모듈과 메시지에 대응시킨 지도다. 설정 탭의 연결 토폴로지와 ICD 관리표(`user_application/web/scripts/settings/topology.js`)는 이 문서와 같은 내용을 화면으로 보여준다.

## 한 문장 규칙

디지털 트윈은 **상태를 계산하고 소유**하며(궤도, 기하, 링크 상태, 창, 시계, 장애), 협력 운용 SW는 **그 상태를 받아 판단**한다(어느 링크를 쓸지, 데이터를 어디에 둘지, 어느 위성이 무엇을 할지, 보안 판정). 트윈은 운용 SW의 판단을 대신 계산하지 않고, 운용 SW는 트윈의 상태를 복제해 소유하지 않는다. 둘 사이의 모든 교환은 `communication/http`의 ICD 끝점을 지나며 `project_support/tests/test_architecture.py`가 import 경계를 강제한다.

## 모듈 지도

| 구분 | 모듈 | 소유하는 상태 | 위치 | ICD |
|---|---|---|---|---|
| 디지털 트윈 | DT 엔진(서버 런타임) | SIM 시계, 실행(run_id), 텔레메트리, 활성 장애, 수락된 배치 사본 | `digital_twin/runtime`, `digital_twin/simulation` | ICD-05, ICD-07 |
| 디지털 트윈 | 노드·궤도 모델 | 위성 정의(버스, 장비, Kepler+J2 궤도), 편대 프리셋, 지상국, 임무 종류 | `digital_twin/model_library`(+`browser/`) | ICD-05 EN-01 |
| 디지털 트윈 | 브라우저 네트워크 트윈 | 위성 상태, OISL 단말 이력과 쌍, 지상 링크 기하, ICD-02 네트워크 메시지 | `digital_twin/simulation/browser/{satellite_dynamics,oisl,ground_links,network_snapshot}.js`, `user_application/web/scripts/communication/network_twin.js` | ICD-02 DF-01 |
| 디지털 트윈 | 창 계산 | 지상국 접속창, 관측 통과, 식 구간, 외부 위성 교차링크 창 | `digital_twin/simulation/browser/mission_windows.js` | ICD-03 OR-01 |
| 디지털 트윈 | 검증 지원(내장) | 시나리오 정의, KPI 표본, 복구 판정 규칙, 결과 기록 | `user_application/configs/scenarios.py`, `digital_twin/verification/browser/scenario_kpi.js`, `user_application/web/scripts/scenario/` | ICD-06 |
| 디지털 트윈 | 시각화 | Cesium/Canvas 장면, 연결도, 일정표. 상태를 바꾸지 않는다 | `digital_twin/visualization` | — |
| 협력 운용 SW | 데이터 관리 | 데이터 객체 카탈로그, 복제본 배치, 정합성, 서비스 작업, 이벤트 | `operations_software/data_management` | ICD-01 |
| 협력 운용 SW | 데이터 패브릭(데이터 송수신) | 링크 사용 가능 판정, 경로, 저장 전달(DTN) 백로그 | `operations_software/data_fabric` | ICD-02 |
| 협력 운용 SW | 군집 운용(오케스트레이션) | 임무별 작업 배정, 검사 결과, 확정된 작업 | `operations_software/orchestration` | ICD-03 |
| 협력 운용 SW | 보안 운용 | 인증률 규칙 판정, 전환 이력 | `operations_software/security` | ICD-08 |
| 연결 | 통신 계층 | 없음(wire schema와 전달만) | `communication/http`(ICD 끝점), `communication/external`(외부 모듈 전달), `communication/browser`(브라우저 클라이언트) | 전체 |
| 조립 | 사용자 응용 | 화면 구성(localStorage), 모듈 배치 선택 | `user_application` | ICD-07 |

`operations_software`의 네 모듈은 임시 구현이다. 실제 모듈이 오면 `user_application/web/application.py`의 `default_*()`에서 외부 주소(`SPACETWIN_*_URL`, CLI `--*-url`)로 바꾸며, `communication/external/*.py`가 같은 ICD를 그 주소로 전달한다. 응답이 없으면 503이고 내장 결과로 대체하지 않는다.

## 상태 소유권

| 상태 | 권위자 | 사본 |
|---|---|---|
| SIM 시계와 실행 | `RuntimeState`(서버) | 브라우저 `store.runtime`은 마지막 텔레메트리 사본. 시나리오 시계는 이 사본을 벽시계로 보간한다 |
| 배치된 위성(ID, 이름, 모드, 장비) | 노드 탭 작업 세트 → 서버 수락(EN-01) 뒤 `RuntimeState`가 사본과 버전 소유 | 데이터 관리 모듈은 DM-04로 받은 저장 노드 명세를 범위(scope_id)별로 보관 |
| OISL 단말 포착 이력 | 브라우저 `networkTwin` 하나 | 통신 탭과 시나리오 재생기는 이를 공유하고 `tick()`으로만 전진시킨다 |
| 링크 사용 가능 여부, 경로 | 데이터 패브릭 모듈(DF-02, DF-04) | 트윈은 답을 표시만 한다 |
| 임무 요청 | 브라우저 `missionStore`(localStorage) | 서버 SIM의 시나리오 임무(`/api/missions/*`)와 별개 |
| 임무 작업 배정, 확정 | 군집 운용 모듈(OR-02, OR-03) | 브라우저는 결과를 저장하고 분석 시각으로 진행 상태만 판정 |
| 데이터 객체와 복제본 | 데이터 관리 모듈 | 트윈은 생성된 제품(DM-01)과 노드 가용성(DM-04)만 보낸다 |
| 장애 | `RuntimeState.active_faults` | 패브릭은 스냅샷의 `faulted` 표시로 받고, 군집 운용은 편성 요청의 `faulted_links`로 받는다 |
| 보안 판정 | 보안 운용 모듈(SEC-02) | 트윈은 SIM 관측만 보낸다(SEC-01) |

## ICD 흐름

메시지 목록과 구현 여부(`implemented`, `simulated`, `planned`)는 설정 탭 ICD 관리표에 있다. 아래는 흐름의 방향과 주기다.

- **ICD-05 DT 엔진**: 콘솔 → 런타임. EN-01 배치 수락(`/api/data-deployment/*`), EN-02 시뮬레이션 제어(`/api/scenario/{control,speed,select,advance}`), EN-03 운용 데이터, EN-04 이벤트, EN-05 네트워크·창 계산(브라우저 시뮬레이션 모듈).
- **ICD-07 운용 콘솔**: 런타임 → 콘솔. CS-001 스냅샷, CS-002 텔레메트리(WebSocket, 1 Hz), CS-003 이벤트·장비·임무, CS-004 제어 요청, CS-005 모듈 대시보드 조회.
- **ICD-02 데이터 패브릭**: 트윈 → 패브릭 DF-01 네트워크 상태(1 Hz, `networkTwin.exchange()`), 패브릭 → 트윈 DF-02 링크 판정·경로·저장 전달, DF-03/04 경로 계산 요청과 결과, DF-05 모듈 상태. DF-06 번들 전달 상태는 계획.
- **ICD-03 군집 운용**: 트윈 → 모듈 OR-01 편성 요청(임무, 위성, 지상국, 창, 격자, 장애 링크·지상국, 제외), 모듈 → 트윈 OR-02 역할 배정 결과, 트윈 → 모듈 OR-03 실행 확정·중단 통보, OR-04 모듈 상태. OR-05 군집 상태 보고는 계획.
- **ICD-01 데이터 관리**: 트윈 → 모듈 DM-01 수집 등록, DM-02 서비스 요청, DM-03 운영 조치, DM-04 저장 노드 상태 갱신; 모듈 → 트윈 DM-05 상태 보고, DM-06 카탈로그, DM-07 노드 상태, DM-08 이벤트, DM-09 모듈 상태.
- **ICD-08 보안 운용**: 트윈 → 모듈 SEC-01 SIM 관측, 모듈 → 트윈 SEC-02 판정, SEC-03 전환 이력, SEC-04 모듈 상태.
- **ICD-06 검증 지원(내장)**: VF-01 시험 시나리오 정의·주입(`/api/scenarios`, 재생기의 장애 주입), VF-02 KPI 표본(재생기가 매초 모음), VF-03 시험 결과 기록(복구 판정 결과 JSON). VF-04 결과 저장·조회는 계획.

## PoC 시나리오에서의 대응

`SDC_POC_01`(OISL 주 링크 단절과 우회 복구)의 다섯 단계가 어느 모듈과 메시지를 지나는지다. 재생기의 상세 규칙은 [시나리오 재생 콘솔](../development/scenario_console.md)에 있다.

| 단계 | 트윈이 하는 일 | 운용 SW가 하는 일 | 메시지 |
|---|---|---|---|
| 1 정상 운용 | 40기 배치와 지상국·임무 조립, 1 Hz 네트워크 상태 전송, 기준 표본 | 패브릭이 N1→N4 주 경로를 답하고, 군집 운용이 중계·관측 임무를 배정·확정하며, 데이터 관리가 저장 노드를 받는다 | EN-01, OR-01/02/03, DF-01/02/03/04, DM-04 |
| 2 Fault 주입 | 실제 편성된 첫 교차링크에 `link_loss` 장애를 런타임에 주입 | — | EN-02(장애 주입), CS-003 |
| 3 상태 전달 | 장애가 `faulted`로 표시된 네트워크 상태를 계속 전송 | 패브릭이 그 링크를 사용 불가로 판정하고 우회 경로를 답한다 | DF-01/02, SEC-01/02 |
| 4 우회·재전송 | 장애 링크를 격자에서 뺀 편성 요청 | 군집 운용이 우회 경로로 다시 배정한다 | OR-01/02, DF-03/04 |
| 5 복구 판정 | 장애 만료 뒤 주 경로 복귀 확인, 서비스 요청, 표본 비교와 판정 | 데이터 관리가 서비스 요청을 처리하고, 보안 운용 판정이 유지된다 | DM-02/05, SEC-02, VF-02/03 |

## 확장할 때

- 새 운용 SW 기능은 `operations_software/<모듈>`에 임시 구현을 두고, 계약은 `digital_twin/contracts/<모듈>.py`, wire schema와 끝점은 `communication/http/<모듈>*.py`, 외부 전달은 `communication/external/<모듈>.py`, 브라우저 클라이언트는 `communication/browser/<모듈>.js`에 둔다. 설정 탭 `topology.js`의 ICD 관리표에 메시지와 구현 여부를 함께 적는다.
- 트윈이 계산해야 할 새 상태(예: 새 창 종류)는 `digital_twin/simulation`에 순수 함수로 두고 운용 SW로 보내는 메시지 필드를 늘린다. 운용 SW 임시 구현 안에서 그 상태를 다시 계산하지 않는다.
- 시나리오 단계가 새 조치를 필요로 하면 `scenarios.py`의 `ACTION_KINDS`와 재생기의 `runAction`을 함께 늘리고, 판정 지표는 `METRICS`와 `scenario_kpi.js`의 `metricValue`를 함께 늘린다.
