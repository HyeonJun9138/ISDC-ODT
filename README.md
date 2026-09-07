# SpaceTwin VVP

우주 디지털 트윈 기반 시뮬레이션과 검증을 위한 Python/HTML 소프트웨어다. Aerospace 디지털 트윈 프레임워크와 AeroDT의 계층 명명 규칙을 참고하여 현재 구현된 기능만 분리했다.

## 실행

새 PC에서는 먼저 저장소를 내려받는다.

```powershell
git clone https://github.com/HyeonJun9138/ISDC-ODT.git
cd ISDC-ODT
python -m pip install -r requirements.txt
python main.py --host 127.0.0.1
```

기존 개발 PC에서는 아래 경로를 사용한다.

```powershell
cd D:\ICDCDT
python -m pip install -r requirements.txt
python main.py
```

기본 수신 주소는 기존 설정인 `103.218.162.73:8765`다. 이 IP가 없는 PC에서는 로컬 주소를 지정한다.

```powershell
python main.py --host 127.0.0.1 --port 8765 --no-browser
```

접속: [로컬 SpaceTwin](http://127.0.0.1:8765). `--no-browser`를 생략하면 브라우저를 자동으로 연다. `--reload`는 개발용 자동 재시작이다. 모든 인터페이스에 수신하려면 `--host 0.0.0.0`을 명시한다. 다른 작업 디렉터리에서도 `python D:\ICDCDT\main.py ...`로 실행할 수 있다.

포트가 사용 중이면 오류를 보고하고 종료한다. 다른 프로세스를 자동으로 종료하지 않는다. 현재 서버에는 인증이 없으므로 신뢰할 수 있는 네트워크에서만 사용한다. 외부 접속에는 별도의 방화벽과 네트워크 설정이 필요하다. 상태가 메모리에 있으므로 단일 서버 프로세스/worker로 실행한다.

## 코드 구조

```text
main.py
communication/
  http/                   기능별 REST, WebSocket, wire schema
  external/               CelesTrak HTTP adapter
  browser/                웹 API 및 WebSocket client
data/
  catalog/                조회, 필터, 캐시 정책과 gzip 저장
  exports.py              CSV 보고서 encoding
  workspace/              실행 캐시와 로그. 소스 코드 아님
digital_twin/
  contracts/              내부 상태 및 계산 API 계약
  model_library/          위성, 통신망, 모의 장비 정의
  simulation/             텔레메트리, RF, 궤도요소, 모의 HIL 계산
    browser/              SGP4/데모 전파와 지상국 패스 계산
  runtime/                시계와 현재 상태, 임무 상태 변경
  verification/           snapshot 기반 KPI 및 요구사항 판정
  visualization/          Cesium/Canvas 지구와 차트
user_application/
  bootstrap.py            런타임과 초기 입력 조립
  cli.py                  실행 옵션 처리
  configs/                배포 경로, 시나리오, 초기 임무
  web/                    application factory와 5개 탭 웹 UI
project_support/
  docs/                   구조, 개발 규칙, 검증 기록
  tests/                  Python 및 JavaScript 회귀시험
  reference/              원본 소스와 과거 기획 자료. 실행 입력 아님
```

`.vscode`, `.codeboarding` 등 기존 도구 설정은 그대로 둔다. Python과 pytest가 만드는 숨김 캐시는 개념 계층이 아니다. `foundation`, `ai_eng`, `ai_pnp` 및 미구현 live-twinning 폴더는 추가하지 않았다.

## 개발 전에 읽을 문서

1. [자동화 및 공동 작업 규칙](AGENTS.md)
2. [개발 규칙서](project_support/docs/DEVELOPMENT.md)
3. [계층 설계](project_support/docs/architecture/design.md)
4. [이전 경로와 새 경로의 대응](project_support/docs/architecture/migration.md)
5. [현재 검증 상태](project_support/docs/development/CURRENT.md)

새 코드는 위 경계에 추가한다. current state를 별도로 복제하거나 하위 모듈에서 user_application을 import하지 않는다. 외부 호출과 파일 접근은 순수 계산에서 분리한다. API 변경은 wire schema 및 회귀시험과 함께 검토한다.

## 검증

```powershell
python -m pytest -q
node --test project_support/tests/browser/orbit.test.mjs
```

Node.js 22 이상은 브라우저 계산 단위시험에만 필요하며 앱 실행에는 필요하지 않다. Python은 3.10 이상을 사용한다. Python 시험은 임시 캐시와 HTTP transport 대역을 사용하므로 CelesTrak 접속 없이 실행할 수 있다. 시험에는 기존 기능, 앱 상태 격리, 스냅샷 사본, 손상 캐시, 실패 대체, API 명세, WebSocket, 정적 모듈 경로, CLI 실행과 계층 의존성 검사가 포함된다.

## 현재 기능과 데이터 의미

- Cesium 3D 지구 및 Canvas 대체 화면, 위성 목록과 궤도 필터, GP 검색과 식별 정보.
- GP/OMM snapshot과 satellite.js 전파 위치. 이는 실제 위성 텔레메트리가 아니다.
- 결정론적 SIM 텔레메트리, 재생/정지/배속/스텝, 장애 주입.
- RF 링크 버짓, 우회 경로와 시나리오 기반 접속창.
- 임무 작업 편집, 충돌 검사 및 규칙 기반 재계획. AI 추론 기능이 아니다.
- Run 기반 KPI, 요구사항 판정, CSV/JSON 내보내기.
- MOCK-HIL 장비 상태, 시각 동기화 모의 동작, preflight와 시험 시퀀스.

GP 캐시는 2시간, SATCAT 상세정보는 24시간 정책을 유지한다. 상류 요청 실패 시 기존 snapshot을 stale로 제공한다. 초기 snapshot이 없는 active/starlink/oneweb 그룹은 미제공 상태를 표시하며, 다른 그룹은 기존 데모 위성으로 대체한다. Cesium 또는 satellite.js를 사용할 수 없을 때는 기존 대체 표시 및 합성 궤도를 사용한다.

기록 버튼은 현재 상태 플래그이며 영구 시험 로그 수집이 아니다. 메모리 이벤트와 브라우저 표시 이력을 저장소 기반 replay로 취급하지 않는다. 실제 장비, 학습 파이프라인, PRISM 및 병렬 미래 rollout은 아직 구현하지 않았다.

## 원본 보존

재구성 전 92개 파일의 ZIP 백업은 `D:\ICDCDT_before_framework_20260907.zip`이다. 내부 manifest의 SHA-256을 검증했다. 기존 backend 소스는 `project_support/reference/before_refactoring`에도 비교용으로 보존한다. `D:\AeroDT`는 수정하지 않았다.

백업, 과거 기획 자료(`project_support/reference`), 실행 캐시와 로그, 개인 개발 도구 설정은 로컬에만 보관하며 Git 저장소에는 포함하지 않는다. 앱에 포함된 웹 이미지 자산은 함께 버전 관리한다.
