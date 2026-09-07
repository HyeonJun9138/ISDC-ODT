# 공동 개발 규칙

## 기능을 어디에 둘 것인가

사용자에게 보이는 흐름과 객체 조립은 user_application에 둔다. 외부 프로토콜을 해석하거나 보내는 코드는 communication, 파일 저장과 조회 정책은 data에 둔다. 물리 및 모의 계산은 digital_twin/simulation, 초기 자산 정의는 model_library, 실행 중 현재 상태는 runtime, 렌더링은 visualization에 둔다. wire schema는 communication에 두고 내부 계약은 contracts에 둔다. `models.py`라는 이름만 보고 요청 스키마를 물리 모델로 분류하지 않는다.

## 의존성과 소유권

user_application이 모든 계층을 조립한다. communication/http는 주입된 runtime 및 catalog를 계약을 통해 호출한다. data/catalog는 주입된 외부 source를 사용하며 구체 HTTP 클라이언트를 생성하지 않는다. runtime은 모델 입력을 받고 simulation과 contracts만 사용한다. simulation은 runtime, data, communication, user_application을 import하지 않는다. visualization은 UI 상태 저장소나 API를 직접 import하지 않으며 데이터와 콜백을 받는다.

현재 상태는 RuntimeState 아래에만 둔다. 잠금 범위 안에서 명령을 처리하고 snapshot을 발행한다. 읽기와 export는 상태를 바꾸지 않는다. 브라우저 store는 화면용 사본이며 서버 상태의 권위자가 아니다. 모의 HIL 함수는 전달된 입력의 사본을 계산하며 장비 상태 소유자가 아니다. 메모리 이벤트 목록은 현재 실행의 제한된 진단 이력이다. 영구 기록 또는 replay로 주장하지 않는다.

## 새 모듈 작성 절차

1. 기존 경계 중 책임이 맞는 곳을 선택한다. 이름만 다른 중복 구현을 만들지 않는다.
2. 입력, 출력, 단위, 시간 기준, 상태 소유권 및 실패 방식을 적는다.
3. 기존 공개 함수를 먼저 검색하고 재사용한다. 공통 영역 추출은 실제 재사용 근거가 있을 때만 한다.
4. 독립 테스트에서 사용할 작은 계약을 정의한다. 호출자가 이미 가진 객체를 다시 전역 singleton으로 만들지 않는다.
5. 정상값, 실패, 경계값과 상태 불변성을 시험한다. 외부 네트워크 대신 transport 경계만 대체하고 실제 파서 및 저장 코드는 시험한다.
6. API 또는 계산식의 의미를 바꿀 때는 architecture 결정 기록에 호환성 영향을 남긴다.

## 이름과 데이터

Python 폴더/파일/함수는 lower_snake_case, 타입은 PascalCase, 상수는 UPPER_SNAKE_CASE를 쓴다. 기존 JavaScript는 camelCase 함수와 PascalCase 클래스를 유지한다. Model은 정적 자산 정의, Runtime은 생명주기와 현재 상태, Adapter는 기술 경계, Contract는 내부 API, Schema는 외부 메시지를 뜻한다. 단순 함수 묶음에 service, manager, engine이라는 이름을 붙이지 않는다.

시뮬레이션 시간은 초, 벽시계는 timezone을 포함한 UTC ISO 8601을 사용한다. RF 단위는 필드 이름의 km/GHz/W/dBi/MHz/Mbps/K/dB를 유지한다. 궤도요소는 GP 필드와 단위를 그대로 보존한다. 브라우저의 SGP4 전파와 Python의 궤도요소 요약 계산은 서로 다른 책임이다.

## 실패와 검증

도메인 입력 오류는 ValueError로 보고하고 HTTP 어댑터에서 400으로 변환한다. Pydantic wire schema 위반은 기존 422를 유지한다. 상류 카탈로그 실패는 기존 stale/미제공/데모 구분을 유지한다. 임의 오류를 정상 결과로 위장하지 않는다. 실행 경로는 cwd가 아닌 모듈 위치에서 구하며 runtime 작업 파일만 data/workspace에 기록한다.

PR 또는 작업 완료 전 전체 pytest, 계층 경계 검사, 웹 모듈 경로 검사와 변경된 화면을 확인한다. 검증 명령, 결과, 남은 한계는 development/CURRENT.md에 기록한다. 런타임 로그, 캐시, 개인 토큰, 백업은 소스 관리 대상이 아니다.

## 향후 확장 조건

실제 장비 프로토콜이 생기면 communication에 어댑터를 구현하고 관측값을 내부 계약으로 변환한다. 실시간 융합이나 상태 추정은 실제 입력과 검증 데이터가 마련된 후 digital_twin에서 구현한다. 학습 데이터 및 학습 과정이 생길 때만 ai_eng을, 학습된 모델의 추론 및 계획이 생길 때만 ai_pnp를 추가한다. PRISM 또는 Predictive World Model을 단순 규칙 기반 재계획의 이름으로 사용하지 않는다. foundation은 둘 이상의 모듈에 실제로 필요한 단위, 좌표 또는 시간 계약이 확인될 때만 추출한다.
