# 보안 운용 SW와 모니터링 구현 계획

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 독립 보안 SIM 모듈, 보안 화면과 설정 토폴로지를 구현한다.
**Architecture:** DT 관측값을 ICD-08로 전달하고 운용 SW가 판정한다. HTTP 어댑터는 교체 가능하며 화면은 판정 사본만 표시한다.
**Tech Stack:** Python, FastAPI, httpx, JavaScript, SVG, CSS, pytest, node:test.
**Spec:** project_support/docs/development/security_console_design.md

## 공통 제약

SIM과 MOCK을 실측 보안으로 표현하지 않는다. 새 이벤트 버스나 암호 엔진을 만들지 않는다. 미연동 외부 장비에 자동 접속하지 않는다. DT와 operations_software 간 직접 import를 금지한다.

Ruling: 현재 기능 브랜치의 작업 디렉터리에서 진행한다. 기존 화면과 계층 개편이 미커밋 상태이므로 HEAD 기반 별도 worktree로 이동하면 승인 설계가 참조하는 구현이 사라진다. 다른 변경은 수정하거나 되돌리지 않는다.

## 1. 보안 모듈과 API

파일: operations_software/security, digital_twin/contracts/security.py, communication/http/security.py 및 security_schemas.py, communication/external/security.py, user_application/configs/security.py, user_application/web/application.py, project_support/tests/test_security.py.

인터페이스: SecurityStandIn.observe(message), overview(), events(after=0), status(). GET /api/security/dashboard는 {module, overview, events, runtime}를 반환한다. overview에는 observation과 verdict={authentication, integrity, encryption}, threshold가 포함된다. authentication은 nominal/warning/unknown이며 integrity와 encryption은 unknown이다. observation은 run_id, sample_id, sim_elapsed_s, observed_at, source, running, auth_percent, throughput_mbps, loss_percent를 포함한다.

- [x] 시험 작성: `assert module.observe(sample(auth_percent=98))['verdict']['authentication'] == 'warning'`; 중복과 역순 입력, 사본, 결측, 실행 초기화, 200건 제한, 외부 오류 및 앱 격리를 추가한다.
- [x] `python -m pytest project_support/tests/test_security.py -q`로 구현 부재 실패를 확인한다.
- [x] 잠금과 deepcopy를 사용한 규칙 모듈, 계약, 스키마, 2.5초 HTTP 어댑터와 주입을 구현한다. HTTP 실패를 503으로 변환하고 외부 실패 시 내장 대체를 금지한다.
- [x] 같은 시험 및 계층 시험을 통과시킨다.

## 2. 보안 UI와 탐색

파일: index.html, scripts/app.js, scripts/tabs/security.js, scripts/security/view_model.js, styles/security.css, project_support/tests/browser/security_view.test.mjs, test_web_assets.py.

인터페이스: initSecurity(), setSecurityActive(active), updateSecurityTelemetry(payload), updateSecuritySocket(status). 표시 함수 securityView(report, {now, receivedAt, socket, telemetryAt, error})는 애니메이션 허용과 지연 상태 및 숫자 표시를 반환한다.

- [x] `assert.equal(securityView(null, {}).animate, false)`와 지연, 단절, 정지, 결측, HTTPS 출처 시험을 작성한다. 여덟 탭 순서와 데이터 표시 이름 시험을 추가한다.
- [x] Node 및 웹 시험으로 실패를 확인한다.
- [x] 승인된 흐름 개념도, SIM 지표, 기술별 미연동, 배치 및 연결 정보와 모듈 이력을 렌더링한다. 2초 비중첩 조회와 이탈 취소, 10초 지연을 구현한다.
- [x] 축소 모션 및 다크/라이트 테마와 촘촘한 탭을 적용한다. 단위시험을 통과시킨다.

## 3. 설정 토폴로지

파일: scripts/settings/topology.js, 관련 settings 렌더링, communication/http/integration.py, project_support/tests/browser/topology.test.mjs, project_support/tests/test_integration_probe.py.

- [x] security-ops, security-external 카드와 ICD-08 존재, 외부 링크 기본 비활성 및 미확인 시험을 추가하고 실패를 확인한다.
- [x] 모듈과 링크 배치를 추가한다. 내장 보안 상태는 실제 module.status()를 확인하고 외부 장비는 연결 증거가 없으면 미확인으로 유지한다. 진단 주소와 실제 배치를 구분한다.
- [x] 기존 저장 설정 및 설정 레이아웃 시험을 유지하며 관련 시험을 통과시킨다.

## 4. 통합 검증

- [x] 각 변경을 독립 검토하고 발견된 결함을 회귀시험으로 수정한다.
- [x] `python -m pytest -q`, `node --test project_support/tests/browser/*.test.mjs`를 실행한다.
- [x] 별도 로컬 서버/브라우저에서 1280x720 및 큰 화면, 다크/라이트, 탭 복귀, 단절과 모션 감소를 확인한다.
- [x] CURRENT.md에 결과와 실제 보안 미구현 한계를 기록한다. 무관한 변경은 커밋하지 않는다.

최종 검증: Python 140개, Node 265개 통과. 독립 검토 완료. 사용자 운용 서버는 유지하고 검증용 서버만 종료한다.
