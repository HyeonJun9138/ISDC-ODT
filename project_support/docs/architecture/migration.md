# 기존 코드와 새 모듈의 대응

| 기존 위치 | 현재 위치와 책임 |
|---|---|
| main.py의 실행 로직 | user_application/cli.py. main.py는 main 호출만 남긴다. |
| backend/app.py | communication/http의 기능별 router, user_application/web/application.py의 조립과 정적 웹 호스팅 |
| backend/models.py | communication/http/schemas.py. 물리 모델이 아니라 wire 요청 스키마다. |
| backend/runtime.py | digital_twin/runtime/state.py와 missions.py의 상태, simulation/telemetry.py 및 mock_hil.py의 계산 |
| backend/network.py | digital_twin/simulation/rf_network.py. 실제 소켓 통신이 아닌 RF 및 통신망 계산이다. |
| backend/verification.py | digital_twin/verification/kpis.py. 분리된 RuntimeSnapshot만 입력받는다. |
| backend/celestrak.py | communication/external/celestrak.py의 HTTP, data/catalog의 저장과 조회 정책, simulation/orbital_elements.py의 계산 |
| backend/data.py | model_library의 자산 정의와 user_application/configs의 운용 시나리오 및 초기 임무. 사용되지 않던 정적 ANALYTICS 사본은 이식하지 않는다. |
| backend/config.py | user_application/configs/paths.py의 배포 경로, data/catalog/settings.py의 카탈로그 정책, 외부 adapter의 endpoint |
| frontend/index.html, styles, assets, scripts/tabs | user_application/web 아래 웹 UI |
| frontend/scripts/api.js | communication/browser/api.js |
| frontend/scripts/globe.js | digital_twin/visualization/globe.js와 simulation/browser/orbit.js. DOM 렌더링과 SGP4/데모 위치 및 패스 계산을 분리한다. |
| frontend/scripts/charts.js | digital_twin/visualization/charts.js |
| data/catalog_cache | data/workspace/catalog_cache. 기존 gzip 파일을 이동하여 캐시를 보존했다. |
| docs, Ref | project_support/reference의 previous_docs와 planning |
| tests | project_support/tests. import 경로를 갱신한 기존 10개 시험과 신규 시험 |

## 프레임워크 해석

Digital Layer의 Shared Digital Model Library, Simulation Engine, 현재 상태와 Visualization에 해당하는 기존 기능을 digital_twin에 배치했다. 현재는 관측 데이터 동기화나 센서 융합이 없으므로 Live Twinning이라는 빈 모듈은 만들지 않았다. Python 텔레메트리와 장비 상태는 SIM/MOCK-HIL이며 Physical Layer의 실제 장비 구현이 아니다.

Data Layer에는 실제 있는 GP 저장과 조회, 보고서 CSV encoding을 둔다. JSON 응답과 다운로드 헤더는 HTTP 경계에서 조립한다. 기존 recording 플래그나 메모리 이벤트 목록을 영구 기록 또는 replay라고 확대 해석하지 않는다.

Communication & Integration Layer에는 HTTP, WebSocket과 CelesTrak adapter를 둔다. RF 링크 버짓이나 경로 탐색은 디지털 모델의 계산이므로 이 계층에 넣지 않는다. User Layer에는 웹 화면, 운용 설정, 실행과 조립을 둔다.

AI Model Engineering, PRISM 및 Predictive World Model은 현재 구현이 없으므로 폴더를 만들지 않았다. 규칙 기반 임무 재계획은 runtime/missions의 기존 결정 규칙으로 유지했다. foundation도 현재 공통 하위 추상화를 억지로 만들 필요가 없어 추가하지 않았다.

## 의도적으로 바꾼 안전 동작

1. main 실행 시 포트를 점유한 임의 프로세스를 taskkill하던 동작을 제거했다. 포트 충돌은 Uvicorn 오류와 실패 종료 코드로 보고한다. 다른 포트를 지정하거나 기존 서버를 사용자가 직접 종료한다.
2. 카탈로그 그룹에 경로 구분자나 상위 경로 문자가 있으면 400으로 거절한다. 기존 정상 그룹과 알 수 없는 단순 그룹명의 stations fallback은 유지한다.
3. 정적 호스팅은 JS/CSS/이미지 폴더만 허용한다. Python 조립 코드와 data/workspace를 웹에서 읽을 수 없게 했다. 앱 화면 URL은 기존과 같이 index로 연결된다.
4. 모듈 import 시 생성되던 전역 runtime을 없앴다. create_app 호출마다 별도 상태를 만들고 lifespan에서 시계를 시작한다. 서버는 단일 worker를 기준으로 운용한다.

위 항목은 계산식 개선이나 새 기능 추가가 아닌 재배치 경계에 필요한 안전 조정이다. REST 22개 경로와 14개 스키마는 재구성 전 OpenAPI와 동일하다.
