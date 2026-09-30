# 배치 SDC 데이터 연결 구현 계획

> **For agentic workers:** Use superpowers:subagent-driven-development to implement task-by-task.

**Goal:** 고정 예제 대신 수락된 SDC 배치로 데이터 생성과 저장을 구동한다.
**Architecture:** runtime 소유 배치 사본 → 모델/생성 함수 → ICD 범위별 독립 데이터 모듈 → 화면 사본. 브라우저 배치는 서버 수락 후 반영한다.
**Tech Stack:** Python/FastAPI/httpx, JavaScript, pytest/node:test.
**Spec:** project_support/docs/development/data_deployment_design.md

## 제약
SIM만 다룬다. 외부 공유 데이터 삭제와 예제 fallback을 금지한다. 무관한 현재 작업은 보존한다.
Ruling: 현재 feature 브랜치의 미커밋 구현을 기반으로 하므로 현재 작업 디렉터리에서 담당 파일을 나눠 작업한다.

## 1. 서버 배치와 데이터 운용 범위
파일: runtime/state.py 및 필요한 runtime 배치 코드, simulation/data_products.py 또는 배치 모델 파일, contracts/data_management.py, communication/http/data_management.py와 배치 schema, external/data_management.py, operations_software/data_management, application.py, test_data_management.py 및 새 test_data_deployment.py.
인터페이스: GET/POST /api/data-management/deployment. GET {deployment_id,revision,nodes,run_id,scope_id}. POST {deployment_id,expected_revision,nodes}. nodes는 {id,name,mode,equipment:[{id,catalog,enabled}]} 형태. 응답 동일. 빈 최초 deployment_id=null revision=0. 같은 배치 재전송은 멱등. 충돌409.
Dashboard는 기존 필드와 deployment를 포함한다. scope_id=run_id와 deployment_id의 조합. 모듈 범위는 메시지 scope_id로 분리하고 외부 미지원시 중단한다.
- [x] `assert client.get('/api/data-management/dashboard').json()['nodes']==[]` 실패를 확인한다.
- [x] 배치 명세 검증, runtime 사본 소유 및 서버 버전 충돌, 범위 계약과 노드/프로파일 변환 구현.
- [x] 빈 배치, 미설정 저장소, 실제 배치/재배치/회수, 런타임 reset, no backfill, old scope, 외부 미지원 회귀시험을 통과시킨다.

## 2. 노드 배치 수락 흐름
파일: scripts/nodes/data_deployment.js(new), tabs/nodes.js, browser/data_deployment.test.mjs.
인터페이스: 배치 클라이언트는 fetch를 주입 받아 조회/수락 명령을 직렬화한다. 승인 뒤 constellation.deploy()/recall() 호출 및 기존 nodes:deployed 이벤트를 유지한다. 데이터 탭은 별도 polling에서 deployment를 읽는다.
- [x] 서버 실패 시 local deployed 보존과 성공 시 반영, 초기 복원/충돌 시험의 실패를 확인한다.
- [x] 서버 수락 전 성공 표시 금지, 재시도 가능 상태, 최초 localStorage 배치 복원 구현.
- [x] 시험 및 기존 constellation 회귀시험 통과.

## 3. 데이터 화면
파일: tabs/data_management.js, data_management/view_model.js, browser/data_management_view.test.mjs 및 lifecycle 시험, index.html 필요한 안내.
- [x] 빈 안정성은 평가 대기, 범위 변경 시 객체/커서/추세 초기화와 빈 배치 조치 불가 시험을 먼저 추가해 실패를 확인한다.
- [x] scope_id에 따른 화면 사본 갱신, 늦은 응답 차단, 오류/빈배치 구분, 스냅샷 비활성화 구현.
- [x] 관련 Node 시험 통과.

## 4. 검토 및 통합 검증
- [x] 독립 리뷰, 회귀시험으로 발견 결함 수정.
- [x] python -m pytest -q 및 node --test project_support/tests/browser/*.test.mjs 실행.
- [x] 별도 서버/브라우저에서 빈 배치→노드 배치→생성→회수, 테마/스크롤 확인.
- [x] CURRENT.md와 data_management.md에 변경 계약 및 검증 기록.


## 검증 기록

구현과 독립 리뷰를 완료했다. 전체 pytest에는 이번 변경 밖의 orchestration 시험 2건이 남아 있으므로 전체 통과로 표시하지 않는다. 상세 결과는 CURRENT.md를 따른다. 브라우저 회수 확인 대화상자에서 자동화 연결이 응답하지 않아 회수 요청은 별도 검증 서버의 API로 수행했고, 새 브라우저에서 회수 결과를 확인했다. 노드 배치 버튼과 수락 결과, 초안만 있을 때의 빈 데이터, 생성 제품과 서비스 요청은 실제 화면에서 확인했다.
