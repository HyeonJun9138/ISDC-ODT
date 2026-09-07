# 현재 개발 상태

## 2026-09-07: 프레임워크 기반 구조 개편

사용자가 승인한 구조안을 적용했다. 현재 실행 소스는 communication, data, digital_twin, user_application에 있으며 문서, 테스트 및 참조 자료는 project_support에 있다. 루트 main.py는 CLI 진입점만 호출한다. D:\AeroDT는 읽기 전용으로 참고했으며 수정하지 않았다.

## 주요 변경

- RuntimeState 전역 singleton을 없애고 application factory마다 독립 상태와 시계를 생성한다.
- 현재 상태와 임무 상태 변경, 순수 텔레메트리 계산, 모의 장비 계산을 분리했다. 잠금과 기존 계산 순서는 유지했다.
- 외부 CelesTrak HTTP adapter, 카탈로그 조회 정책, gzip 저장, 궤도요소 계산을 각각 분리했다.
- REST와 WebSocket을 기능별 router로 나눴다. 내부 runtime 계약, snapshot 및 stateless query 계약으로 연결했다.
- 브라우저 API client, 웹 화면, 시각화와 궤도 전파 계산을 분리했다.
- 캐시, 기존 로그, 참조 자료 및 테스트를 새 위치로 이동했다. 구 소스는 실행 경로에서 제외하고 읽기 전용 참조 영역에 보존했다.
- 공동 작업 규칙, 계층 의존성, 확장 조건과 이전 파일 대응표를 문서화했다.

## 검증 증거

| 검사 | 실행 및 결과 |
|---|---|
| 변경 전 기준선 | 원본 `python -m pytest -q`: 10 passed |
| 원본 보존 | ZIP 내 92개 파일을 SHA-256 manifest 및 ZIP CRC로 검증 |
| 최종 Python 회귀시험 | `python -m pytest -q`: 35 passed |
| JavaScript 계산 시험 | `node --test project_support/tests/browser/orbit.test.mjs`: 4 passed |
| JavaScript 문법 | 실행 JS 11개 파일을 각각 `node --check`로 검사, 모두 종료 코드 0 |
| REST 계약 | 원본 ZIP의 소스를 임시 별도 Python 프로세스에서 읽은 OpenAPI와 전체 동등 비교. 22 paths와 14 schemas 동일 |
| 내부 경계 | AST import 검사, 계산 입력 사본, 앱 간 상태 격리 및 시계 종료 시험 통과 |
| 외부 연동과 저장 | 실제 카탈로그 정책과 gzip 코드를 사용하고 HTTP transport만 대체. live/cache/stale/그룹별 fallback, 상세정보와 손상 캐시 시험 통과 |
| 웹 경로 | HTML부터 모든 로컬 ES import와 CSS를 따라가 HTTP 200 및 콘텐츠 유형 검사. Python/캐시 비노출 시험 통과 |
| 실행기 | 임의 cwd에서 main을 별도 프로세스로 시작하여 health 및 JS 제공 확인. 점유 포트에서 실패 종료하고 기존 점유자 유지 확인 |
| 실제 브라우저 | 127.0.0.1:18765에서 5개 탭을 전환하고 스크린샷으로 확인. 16,511개 GP 위성, Cesium 3D, SGP4 위치/패스, 통신망, 임무 일정, KPI 차트, MOCK-HIL 화면 표시. WebSocket 갱신 및 콘솔 error 0개 확인 |
| 별도 코드 리뷰 | 계산 입력 원본 노출 및 손상 캐시 timestamp 오류를 지적받아 재현 시험 후 수정 |

검증용 브라우저 탭과 포트 18765의 서버만 종료했다. 기존 사용자 프로세스는 종료하지 않았다. 테스트가 생성하는 임시 서버도 종료한다. Node 24 및 현재 설치된 Python/FastAPI 환경에서 검증했으며 모든 Python 버전 또는 모든 브라우저 조합을 시험한 것은 아니다.

## 변경 전부터 존재한 한계

현재 HIL은 실제 하드웨어 연동이 아니며 recording은 메모리 플래그다. KPI는 SIM 규칙이고 임무 재계획은 AI가 아니다. 메모리 이벤트와 UI history가 영구 운용 이력이나 replay 기능은 아니다. 기존 고정 UI 시나리오 표시와 단순 접속창/재계획 알고리즘을 이번 구조 개편에서 변경하지 않았다. CDN이 차단된 실제 브라우저 세션은 이번 시각 검증에 포함하지 않았으며 대체 궤도 계산은 독립 JavaScript 시험으로 확인했다.

백업: D:\ICDCDT_before_framework_20260907.zip. Git 저장소가 아니므로 commit, branch, merge는 수행하지 않았다.


## 2026-09-07: Git 저장소 초기 등록

사용자의 별도 요청으로 Git을 초기화하고 origin을 https://github.com/HyeonJun9138/ISDC-ODT.git 으로 지정했다. 원격 저장소가 비어 있음을 확인했다. 실행 코드와 자산, 개발 문서 및 테스트 97개 파일을 등록 대상으로 삼고 로컬 도구 설정, 실행 데이터, 기획 자료와 원본 백업은 제외했다. 등록 대상 스냅샷을 임시 폴더에 복원하여 Python 35개 및 JavaScript 4개 시험을 통과했다. 주요 비밀키 패턴 검사에서 발견 항목이 없었다. 원격 반영 여부는 `git status -sb`와 `git ls-remote origin refs/heads/main`으로 확인한다.
