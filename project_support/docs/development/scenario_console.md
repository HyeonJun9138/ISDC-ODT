# 시나리오 재생 콘솔 사용 및 실행 규칙

상단 도구 모음의 `시나리오` 단추로 PoC 시나리오를 고르고 세팅한 뒤 재생하면, 서버 SIM 시계가 시나리오 시계가 되어 노드·통신·데이터·보안·임무 탭이 함께 진행되고 단계마다 안내 창이 해당 탭으로 이끈다. 보여주기용 재생기이며 실제 운용 절차나 실측 시험이 아니다. 판정에 쓰는 값은 모두 SIM과 임시 운용 SW의 대표 공학값이다.

## 사용

1. `시나리오`를 누르면 목록(`/api/scenarios`)이 열린다. 목록에는 기존 SIM 시나리오(`kind: "sim"`, 런타임 선택만 함)와 PoC 시나리오(`kind: "poc"`, 전체 정의를 가짐)가 함께 있다. PoC를 고르면 오른쪽에 단계, 임무, 판정 기준이 보인다.
2. `시나리오 세팅`은 순서대로 (a) 런타임 실행 선택과 정지, (b) 정의대로 위성 40기(4면 × 10기, 550 km, 53°)를 노드 작업 세트에 조립해 서버 수락(EN-01), (c) 지상국 배치, (d) 임무 등록과 ICD-03 편성, `commit: true`인 임무의 실행 확정(OR-03), (e) 첫 ICD-02 교환, (f) 화면 준비(대시보드 SDC 필터, 각 탭 한 번 방문)를 한다. 이전 배치와 임무는 지워지므로 대화상자가 미리 알린다. 세팅 중 단계 이름과 진행이 도크에 표시된다.
3. `재생`은 서버 SIM 시계를 시작한다. 도크(화면 아래)에 단계 목록, 경과 시각(T+초와 UTC), 정지·재생, 배속, `다음 단계`, 자동 탭 전환 스위치가 있다. 단계가 되면 안내 카드가 그 단계의 서술, 흐름(모듈 → 모듈 메시지), 확인 항목, 관련 탭 칩을 보여주고 자동 탭 전환이 켜져 있으면 해당 탭으로 옮긴다.
4. `다음 단계`는 서버 시계를 다음 단계 시각까지 전진시킨다(`POST /api/scenario/advance`, 앞으로만). 시계를 뒤로 돌리는 조작은 거부된다.
5. 마지막 단계의 복구 판정이 끝나면 런타임이 멈추고 결과 대화상자가 열린다. 도달·자원·상태 세 그룹의 규칙별 통과 여부, 정상·장애·우회·복구 구간의 KPI 비교표, 사건 시각, ICD 메시지 이력, JSON(VF-03 결과 기록) 저장이 있다.
6. `닫기`(도크)는 시나리오를 끝내고 모든 탭의 시계를 벽시계로 되돌린다. 시나리오가 등록한 임무(비고에 `[scenario:…]`)는 지운다. 페이지를 새로고침하면 같은 실행(run_id)이면 재개하고, 서버 실행이 바뀌었으면 만료로 표시한다.

## 시나리오 모델

정의는 `user_application/configs/scenarios.py`의 데이터이며 `validate_definition()`이 참조(임무 키, 단계 ID, 역할, 지표 이름)를 검사한다. `SDC_POC_01`은 다음으로 구성된다.

- **군집**: Walker Δ 4면 × 10기, 550 km, 53°, 위상 F=1, RAAN 60° 범위. 모든 위성에 `dtn_store`, 역할 위성에 추가 장비. 표시 모델은 `model_key`(모델 manifest의 키)로 정하며 PoC는 NASA 3D Resources의 Earth Observing-1(`eo_1`, 대표 치수 7 m)을 모든 위성에 쓴다. 역할에 `model_key`를 주면 그 위성만 다른 모델을 쓰고, 둘 다 없으면 버스 프리셋의 모델이다. 버스(전력, 장비)는 모델과 무관하게 유지된다. 역할은 N1(원천, `source`), N2(중계, `relay`), N3(대체, `alternate`), N4(관문, `gateway`)이며 궤도면과 순번으로 지정한다. 같은 궤도면 이웃은 36° 간격(약 4,280 km)으로 OISL이 유지되고, 궤도면 사이 링크는 간헐적이다.
- **지상국**: 대전, 제주.
- **임무**: `relay`(N1→N4 데이터 중계, 확정), `observe`(독도 관측 인도, 확정), `fleet_update`(관문 소프트웨어 갱신, 계획만). 정의의 `params`가 임무 종류 프리셋보다 우선한다.
- **경로와 서비스**: 패브릭 경로 질의는 `@source → @gateway`, 데이터 관리 서비스 요청은 `@gateway` 대상 `imagery`.
- **재생**: 기본 배속과 허용 배속, 표본 간격 1초.
- **단계**: 아래 표.
- **판정 기준**: 도달(중계 임무 완료, 기한 여유 ≥ 0), 자원(N1 보관량 ≤ 저장 용량 60 %, 데이터 안정성 ≥ 70), 상태(대체 경로 재수렴 ≤ 90 s, 주 경로 복귀, 보안 판정 유지).

| 단계 | 시각 규칙 | 조치 | 확인 |
|---|---|---|---|
| 1 정상 운용 | T+0 | 패브릭 경로 질의, 15초 뒤 기준 표본 | 경로 있음, 임무 확정 |
| 2 Fault 주입 | 편성된 첫 교차링크 시작 + 20 s (없으면 T+40) | 그 링크에 `link_loss`(high, 300 s) 주입, 6초 뒤 장애 표본 | 런타임 활성 장애 |
| 3 상태 전달 | 2단계 + 4 s | 패브릭이 장애 링크를 사용 불가로 판정했는지 확인 | `fabric.fault_link_unusable` |
| 4 우회·재전송 | 2단계 + 10 s | 장애 링크를 격자에서 뺀 재편성, 경로 재질의, 8초 뒤 우회 표본 | 재편성 결과, 우회 경로 |
| 5 복구 판정 | max(중계 임무 종료, 장애 만료) + 5 s (없으면 T+600) | 서비스 요청(DM-02), 복구 표본, 판정 | 3그룹 규칙 |

단계 시각 규칙(`at`)은 `offset_s`, 다른 단계 뒤(`after`), 편성된 작업(`anchor: task`, 임무·작업 종류·순번·시작/끝), 임무 종료(`mission_end`), 장애 만료(`fault_end`), 이들 중 최댓값(`max`)과 정할 수 없을 때의 `fallback_s`로 적는다. 조치(`ACTION_KINDS`)는 `route`, `sample`, `inject_fault`, `verify_link_unusable`, `replan_mission`, `dm_request`, `verdict`, `switch_tab`이다. 안내 서술의 `{a.b}`는 재생 맥락(역할 ID·이름, 경로, 장애 링크, 재편성 경로)으로 채운다.

## 실행 규칙

- **시계**: 서버 SIM 시계(`started_at + elapsed_seconds`)를 마지막 텔레메트리 수신 시각부터 벽시계로 보간한 값이 시나리오 시각이다. 재생 중 모든 탭의 `OrbitClock`은 `followAll()`로 이 시각을 따르고 각 탭의 정지·배속·스텝은 런타임 제어 API로 위임된다. 종료·닫기 때 `releaseAll()`이 모든 시계를 벽시계로 되돌린다. 제어 응답의 런타임 상태는 즉시 `store.runtime`에 반영해 다음 보간이 늦은 텔레메트리에 기대지 않게 한다.
- **네트워크 상태의 단일 소유자**: OISL 단말 이력과 ICD-02 메시지는 `networkTwin` 하나가 소유한다. 통신 탭이 보일 때는 통신 탭이, 아니면 재생기가 매초 `tick()`으로 전진시키고 `exchange()`로 패브릭에 보낸다(연속 전송 최소 간격 900 ms, 시계 전진과 판정 직전에는 강제 전송). 재생기의 틱은 한 번에 하나만 돌며, 진행 중 요청된 틱은 하나로 합쳐진다.
- **장애**: 2단계는 편성 결과의 실제 첫 교차링크 작업(`satellite ↔ counterpart`)에 주입한다. 장애는 런타임 상태이므로 패브릭에는 스냅샷 링크의 `faulted`로, 군집 운용에는 편성 요청의 `horizon.faulted_links`로 전달되어 격자에서 빠진다. 만료 시각은 런타임의 `expires_at`으로 기록한다.
- **재편성**: 공용 `missionPlanner`(`scripts/missions/planner.js`)가 임무 탭과 재생기 양쪽의 OR-01 요청을 만든다. 장애 링크와 장애 지상국은 제외되고 확정 임무의 점유 구간은 유지된다. 확정·중단은 OR-03으로 모듈에 통보한 뒤 화면 상태를 바꾼다.
- **표본과 판정**: 매초 `takeSample()`이 경로(홉, 지연, 신뢰도), 임무(경로 홉, 종단 지연, 기한 여유), 패브릭(사용 가능 링크, N1 보관 상태·량), 데이터 관리(안정성, 객체 수), 보안(판정)을 모으고 단계 조치 `sample`이 구간 대표 표본을 남긴다. 사건 시각(`fault_at_s`, `detour_available_at_s`, `reroute_at_s`, `fault_end_s`, `primary_restored_at_s`)에서 재수렴 시간과 주 경로 복귀를 구한다. 판정은 `digital_twin/verification/browser/scenario_kpi.js`의 순수 함수이며 값이 없으면 실패가 아니라 결측으로 표시한다.
- **복원**: 재생기 상태는 `localStorage`(`spacetwin-scenario-v1`)에 두고 페이지 숨김 때 타이머와 시계 추종만 푼다. 같은 run_id면 재개하고 아니면 만료다.

## 코드 위치

| 책임 | 파일 |
|---|---|
| 정의와 검사, 목록 API | `user_application/configs/scenarios.py`, `communication/http/scenarios.py` |
| 시계 전진 API | `communication/http/runtime.py`(`POST /api/scenario/advance`), `digital_twin/runtime/state.py`(`advance`) |
| 정의 → 위성·지상국·임무 조립 | `digital_twin/model_library/browser/scenario_assembly.js` |
| KPI 표본과 판정, 결과 기록 | `digital_twin/verification/browser/scenario_kpi.js` |
| 네트워크 상태 단일 소유자 | `user_application/web/scripts/communication/network_twin.js` |
| 공용 임무 편성기 | `user_application/web/scripts/missions/planner.js`, `planner_client.js` |
| 공용 배치 클라이언트 | `user_application/web/scripts/nodes/deployment_client.js` |
| 시나리오 시계와 시계 추종 | `user_application/web/scripts/scenario/clock.js`, `scripts/orbit/clock.js`(`followAll`, `releaseAll`) |
| 재생기 상태 기계 | `user_application/web/scripts/scenario/runner.js` |
| 대화상자·도크·안내 카드·결과 | `user_application/web/scripts/scenario/console.js`, `styles/scenario.css`, `index.html` |
| 실행 확정 통보(OR-03) | `operations_software/orchestration/stand_in.py`, `communication/http/orchestration.py`, `communication/external/orchestration.py`, `communication/browser/orchestration.js` |
| 시험 | `project_support/tests/test_scenarios.py`, `test_orchestration_commit.py`, `tests/browser/scenario_*.test.mjs`, `network_twin.test.mjs`, `mission_planner.test.mjs`, `node_links_planes.test.mjs` |

## 한계

- 세팅은 기존 노드 배치와 임무를 지운다. 사용자 작업 세트를 남기려면 세팅 전에 노드 탭에서 내보내야 한다.
- 시계는 앞으로만 간다. 단계 시각을 지나친 뒤 되돌아가는 재생은 없다.
- 판정은 SIM 값의 비교이며 실측 시험 결과가 아니다. 결과 JSON은 브라우저에서 내려받을 뿐 서버에 저장하지 않는다(VF-04 계획).
- 궤도면 사이 OISL은 기하상 간헐적이므로 N1→N4 주 경로는 같은 궤도면 이웃을 지나고, 우회 경로는 순간의 격자에 따라 홉 수가 다를 수 있다. 같은 궤도면 이웃 거리(약 4,280 km)가 단말 정격에 가까워 경로 신뢰도가 낮게(수십 %) 보고된다.
- 대시보드 GP 카탈로그 준비는 브라우저 자동화 창(rAF 없음)에서 멈출 수 있으며 실제 브라우저에서는 정상이다.
