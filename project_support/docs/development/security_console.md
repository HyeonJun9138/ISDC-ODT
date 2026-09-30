# 보안 운용 SW와 보안 화면

## 현재 구현

보안 탭은 별도 보안 운용 SW의 ICD-08 보고를 표시한다. DT는 기존 SIM 인증률, 처리량과 손실률을 사본으로 제공하고, operations_software/security의 SecurityStandIn이 인증률 기준을 판정한다. 규칙의 기본 기준은 99%이며 user_application/configs/security.py에서 조립 지점으로 전달한다. UI에는 보안 정책의 중복 구현이 없다.

인증률이 유효하지 않으면 미확인이다. 무결성과 암호화는 항상 검증 입력 없음이며 SDLS, PQC, TEE/Mesh-PUF와 OTAR는 미연동으로 표시한다. PQC-TEE 연결 상태는 MOCK 장비 모델의 값이다. 실제 암호 연산, 사용자 인증, 침입 탐지나 파일 검증 기능을 구현한 것이 아니다.

위성에서 중계를 거쳐 지상국에 도달하는 그림은 송수신 개념도다. 실제 위성 경로나 패킷 캡처가 아니다. 모듈 보고와 텔레메트리가 최신이고 SIM이 실행 중일 때만 패킷이 움직인다. 정지, 단절, 수신 지연과 탭 이탈 시 애니메이션을 중단하며 CSS의 모션 감소 설정을 지원한다.

## 독립 모듈과 배치

DT와 운용 SW 사이에는 직접 import가 없다. digital_twin/contracts/security.py는 계약만 정의하고 communication/http/security.py가 현재 DT 스냅샷을 메시지로 전달한다. user_application/web/application.py에서 SecurityStandIn 또는 RemoteSecurity를 주입한다. 외부 어댑터는 communication/external/security.py에 있다.

기본 배치는 같은 프로세스의 내장 SIM이다. 별도 프로세스에 같은 ICD-08 API를 제공하는 보안 운용 SW가 있을 때 서버 환경변수 SPACETWIN_SECURITY_URL에 HTTP 또는 HTTPS 기본 주소를 지정하고 재시작하면 외부 배치를 선택한다. URL에 계정 정보, query 또는 fragment를 넣을 수 없다. 외부 모듈에 접속할 수 없거나 응답 계약이 맞지 않으면 오류를 표시하며 내장 SIM으로 자동 대체하지 않는다. 요청 제한은 호출당 2.5초다.

설정 화면에는 보안 운용 SW와 외부 보안 시스템이 별도 카드로 나타난다. L16/ICD-08은 보안 운용 SW와의 연동이고 L17은 외부 장비 진단 대상이다. L17은 기본 비활성이고 주소도 미지정이다. 브라우저에서 진단 주소를 변경해도 서버 모듈 배치가 바뀌지 않는다. 실제 배치는 서버 보고를 별도로 표시한다. TCP 접속 성공은 도달 가능일 뿐 보안 프로토콜 검증이 아니다.

## API와 수명주기

| 경로 | 역할 |
|---|---|
| POST /api/security/observations | SIM 관측 전달 |
| GET /api/security/overview | 모듈 판정과 마지막 관측 조회 |
| GET /api/security/events?after=0 | 실행 내 순번 이후 판정 전환 조회 |
| GET /api/security/status | 실제 모듈 배치와 응답 정보 |
| GET /api/security/dashboard | DT 관측 전달과 콘솔용 보고 조립 |

관측에는 계약 버전 1.0, source=SIM, run_id, sample_id, sim_elapsed_s, observed_at, running과 모의 지표가 들어간다. HTTP 스키마는 필드 형식을 검사하며 외부 응답도 계약과 장비 형식을 검증한다. 요청보다 오래된 관측과 다른 실행의 응답은 거부한다. dashboard는 관측, 모듈 상태와 이력이 동일한 실행을 가리키는지 확인한다.

모듈은 사본과 잠금으로 입력과 반환 상태를 격리한다. 같은 샘플과 역순 관측은 판정을 덮어쓰지 않으며 같은 판정의 반복 조회는 이벤트를 늘리지 않는다. 이력은 최대 200건이고 화면은 최근 40건을 보여준다. 브라우저 새로고침에는 유지되지만 새 SIM 실행 또는 모듈 재시작 때 초기화된다. 영구 감사 로그가 아니다.

화면은 보안 탭이 활성 상태일 때 이전 조회 완료 후 2초 뒤 다시 조회한다. 관측은 조회에 의해 수행되며 백그라운드 연속 감사 서비스가 아니다. 모듈 보고 수신과 WebSocket 텔레메트리 수신을 분리하고 10초 이상 갱신되지 않으면 오래된 값임을 알린다. 브라우저 HTTP/HTTPS와 WS/WSS 표시는 해당 구간만 설명한다. 현재 서버의 사용자 인증 미구현 경고는 그대로 유지한다.

## 검증

모듈 및 HTTP 시험은 project_support/tests/test_security.py, UI 순수 함수와 조회 수명주기는 project_support/tests/browser/security_view.test.mjs 및 security_lifecycle.test.mjs에 있다. 설정은 기존 topology, integration_probe와 settings_layout 시험으로 검증한다. 최종 전체 시험 결과와 실제 화면 확인 기록은 CURRENT.md를 따른다.
