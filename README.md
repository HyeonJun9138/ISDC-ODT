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

HTML 셸과 정적 웹 모듈(`/static/*`)은 `Cache-Control: no-cache`로 제공되어 코드 갱신 뒤 브라우저가 ETag로 재검증한다. 포트가 사용 중이면 오류를 보고하고 종료한다. 다른 프로세스를 자동으로 종료하지 않는다. 현재 서버에는 인증이 없으므로 신뢰할 수 있는 네트워크에서만 사용한다. 외부 접속에는 별도의 방화벽과 네트워크 설정이 필요하다. 상태가 메모리에 있으므로 단일 서버 프로세스/worker로 실행한다.

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
operations_software/       타 기관 운용 SW의 임시 구현 (ICD 메시지로만 연결)
  data_fabric/            자율 라우팅, DTN, OISL 링크 품질 (ICD-02)
  data_management/        데이터 센터 수명주기: 배치, 복제, 정합성, 서비스 (ICD-01)
  orchestration/          군집 운용: 임무별 작업 배정, 검사, 실행 확정 (ICD-03)
  security/               보안 운용: 인증률 규칙 판정과 전환 이력 (ICD-08)
digital_twin/
  contracts/              내부 상태 및 계산 API 계약
  model_library/          위성, 통신망, 모의 장비 정의
    browser/              사용자 위성 노드의 버스, 임무 장비(OISL 단말), 편대 프리셋, 지상국, 임무 종류 정의
  simulation/             텔레메트리, RF, 궤도요소, 모의 HIL 계산
    browser/              SGP4/데모 전파, 지상국 패스, 노드 Kepler+J2 다이나믹스와 OISL 단말 모델
  runtime/                시계와 현재 상태, 임무 상태 변경
  verification/           snapshot 기반 KPI 및 요구사항 판정
    browser/              시나리오 KPI 표본, 복구 판정, 결과 기록 (ICD-06 내장)
  visualization/          Cesium/Canvas 지구, 위성 모델, 노드 배치 장면과 차트
user_application/
  bootstrap.py            런타임과 초기 입력 조립
  cli.py                  실행 옵션 처리
  configs/                배포 경로, SIM·PoC 시나리오 정의, 초기 임무
  web/                    application factory와 8개 탭 웹 UI (대시보드, 노드, 통신, 데이터, 보안, 임무, 상태, 설정)
    assets/models/        NASA 3D Resources 위성 glTF 모델, 썸네일, 매핑 manifest
project_support/
  docs/                   구조, 개발 규칙, 검증 기록
  tests/                  Python 및 JavaScript 회귀시험
  tools/                  외부 자산 수집과 검증 스크립트
  reference/              원본 소스와 과거 기획 자료. 실행 입력 아님
```

`.vscode`, `.codeboarding` 등 기존 도구 설정은 그대로 둔다. Python과 pytest가 만드는 숨김 캐시는 개념 계층이 아니다. `foundation`, `ai_eng`, `ai_pnp` 및 미구현 live-twinning 폴더는 추가하지 않았다.

## 개발 전에 읽을 문서

1. [자동화 및 공동 작업 규칙](AGENTS.md)
2. [개발 규칙서](project_support/docs/DEVELOPMENT.md)
3. [계층 설계](project_support/docs/architecture/design.md)와 [모듈 구분: 디지털 트윈과 협력 운용 SW](project_support/docs/architecture/modules.md)
4. [이전 경로와 새 경로의 대응](project_support/docs/architecture/migration.md)
5. [현재 검증 상태](project_support/docs/development/CURRENT.md)

새 코드는 위 경계에 추가한다. current state를 별도로 복제하거나 하위 모듈에서 user_application을 import하지 않는다. 외부 호출과 파일 접근은 순수 계산에서 분리한다. API 변경은 wire schema 및 회귀시험과 함께 검토한다.

## 검증

```powershell
python -m pytest -q
node --test project_support/tests/browser/*.test.mjs
```

Node.js 22 이상은 브라우저 계산 단위시험에만 필요하며 앱 실행에는 필요하지 않다. Python은 3.10 이상을 사용한다. Python 시험은 임시 캐시와 HTTP transport 대역을 사용하므로 CelesTrak 접속 없이 실행할 수 있다. 시험에는 기존 기능, 앱 상태 격리, 스냅샷 사본, 손상 캐시, 실패 대체, API 명세, WebSocket, 정적 모듈 경로, CLI 실행과 계층 의존성 검사가 포함된다.

## 현재 기능과 데이터 의미

- Cesium 3D 지구 및 Canvas 좌표도, 촘촘한 가상 위성 목록과 검색/정렬/관심 필터, 선택 위성 분석.
- GP/OMM snapshot과 satellite.js 전파 위치. 이는 실제 위성 텔레메트리가 아니다.
- 선택 위성의 3D 모델을 대표 치수 기준 실제 축척으로 지구 위에 표시하고, 위성을 클릭하면 카메라가 위성을 중심으로 확대되어 따라간다. NASA 3D Resources와 NOAA/NASA GOES-R 모델, 공개 자료가 없는 Starlink, OneWeb, GNSS, 3U 큐브샛용 자체 제작 대표 형상을 정확 일치, 동일 계열, 대표 형상으로 구분해 표시한다. 실제 촬영 이미지나 자세 추정이 아니다.
- 궤도 탭의 독립 UTC 분석 시계와 WGS84 지상 관측 기하, 고각 마스크별 24시간 관측창 예측.
- 결정론적 SIM 텔레메트리, 재생/정지/배속/스텝, 장애 주입.
- RF 링크 버짓, 우회 경로와 시나리오 기반 접속창.
- 임무 탭: 우주 데이터 센터의 서비스 임무(관측 인도, 궤도상 연산, 중계 전송, 외부 위성 데이터 수신, 군집 소프트웨어 갱신)를 요청으로 등록하면 디지털 트윈이 지상국 접속창, 관측 통과, 식 구간, 외부 위성(GP) 교차링크 창을 계산해 군집 운용 모듈(ICD-03, `operations_software/orchestration` 임시 구현)에 보내고, 모듈이 배정한 위성별 작업과 검사 결과를 UTC 일정표에 올린다. 실행 상태는 분석 시각으로 판정하며 위성이 빠지면 재구성한다. 기존 시나리오 임무 API(`/api/missions/*`)는 REST로만 남는다. 규칙 기반 배정이며 AI 추론이 아니다.
- 데이터 관리 탭: 데이터 센터의 데이터가 얼마나 안정적으로 수집·저장·분산·복제·서비스되는지를 데이터 관리 모듈(ICD-01)에서 받아 표시한다. 안정성 점수와 구성 요소, 파이프라인 단계와 추이, 저장 노드 사용률, 데이터 카탈로그와 복제본 배치, 무결성 검사·자가복구·재균형·복제 계수 변경 같은 운영 조치, 이벤트를 제공한다. 모듈은 기본적으로 내장 임시 구현이며 `--data-management-url`로 외부 모듈에 연결한다. 값은 대표 공학값이고 실제 저장 시스템 측정이 아니다.
- 노드 탭: 사용자 위성 노드를 임시로 배치해 보는 샌드박스. 내 위성만 보이는 Cesium 궤도 뷰(모든 위성의 3D 모델, 궤적, OISL 링크 선), 선택 위성의 상태(정의 궤도요소와 현재 위치, 일조 여부, 순간 전력 수지, 장비, OISL 단말별 짐벌 지향과 포착 상태)와 편집 폼(이름, 3D 모델, 임무 장비, 궤도, 운용 모드, 전력), 편대 프리셋(단일, 열차형, Walker Δ, Walker ★)과 슬라이더. 작업 세트는 브라우저 localStorage에 저장되며 `배치 완료`로 대시보드 카탈로그에 합쳐진다. 노드 위치는 Kepler+J2 모의 계산이고 OISL 상태는 기하학적 모델이다. 상태 탭: SIM 런타임, 현재 텔레메트리, 활성 장애, 이벤트 이력, 데이터 출처. 설정 탭: 내·외부 모듈 연결 토폴로지(운용 모드별 연결·단절·대기·사용 안 함 구분), 링크별 연결 설정(전송 방식, 엔드포인트, 하트비트, 타임아웃), 링크 상태표, ICD 관리표와 메시지 목록 대화상자. 링크 상태는 `/api/integration/probe`가 실제로 확인한다(내장 모듈은 프로세스 안 생존 검사, 원격 엔드포인트는 TCP 접속 시험, UDP는 주소 해석까지). 운용 콘솔 링크는 브라우저의 WebSocket 상태를 따른다.
- 시나리오 재생기: 상단 `시나리오` 단추에서 PoC 시나리오(`SDC_POC_01`, OISL 주 링크 단절과 우회 복구)를 고르고 세팅하면 위성 40기, 지상국, 임무(ICD-03 편성·확정)가 한 번에 구성된다. 재생하면 서버 SIM 시계를 모든 탭의 분석 시계가 따르며, 단계마다 장애 주입·패브릭 판정 확인·재편성·서비스 요청이 실행되고 안내 카드가 해당 탭으로 이끈다. 마지막에 정상·장애·우회·복구 구간의 KPI를 비교해 도달·자원·상태 판정과 결과 기록(ICD-06 VF-03)을 낸다. 보여주기용이며 SIM 값의 비교다.
- Run 기반 KPI, 요구사항 판정, CSV/JSON 내보내기와 MOCK-HIL 장비 상태, preflight, 시험 시퀀스는 REST API로만 남아 있다. 분석 탭과 시험 탭 화면은 제거했다.

GP 캐시는 2시간, SATCAT 상세정보는 24시간 정책을 유지한다. 상류 요청 실패 시 기존 snapshot을 stale로 제공한다. 초기 snapshot이 없는 active/starlink/oneweb 그룹은 미제공 상태를 표시하며, 다른 그룹은 명시적인 데모 위성으로 대체한다. DEMO만 원형 Kepler 운동과 지구 자전을 사용한다. 실제 GP의 전파 실패를 합성 위치로 감추지 않는다. Cesium을 사용할 수 없으면 같은 계산값을 2D 경위도 좌표도로 표시하며, satellite.js도 없으면 GP 위치는 미제공이다.

[궤도 탭 사용 및 계산 규칙](project_support/docs/development/orbit_console.md)에 시계와 필터 사용법, 좌표계, DEMO 가정 및 관측창 예측의 한계를 정리했다. [노드 탭 사용 및 계산 규칙](project_support/docs/development/node_sandbox.md)에는 편대 배치, 노드 다이나믹스, OISL 단말 모델의 가정과 한계를 정리했다. [데이터 관리 탭과 모듈](project_support/docs/development/data_management.md)에는 데이터 패브릭과의 개념 구분, ICD-01 메시지, 배치·복제·정합성 모델의 가정과 한계를 정리했다. [시나리오 재생 콘솔](project_support/docs/development/scenario_console.md)에는 PoC 시나리오 모델, 시계 추종, 네트워크 상태 소유, 판정 규칙과 한계를 정리했다. 다른 탭의 기존 SIM 텔레메트리와 MOCK-HIL은 이번 궤도 개선과 별개다.

위성 3D 모델과 썸네일은 [NASA 3D Resources](https://github.com/nasa/NASA-3D-Resources)와 NOAA/NASA GOES-R 프로그램에서 가져온 자산이며 출처를 밝힌다. NASA 휘장은 사용하지 않고 NASA의 보증을 뜻하지 않는다. Starlink, OneWeb, Kuiper, GNSS, 3U 큐브샛처럼 공개 3D 자료가 없는 위성군은 `project_support/tools/build_generic_models.py`가 만든 단순 박스와 원통 조립 형상을 쓰며 화면에 자체 제작 대표 형상임을 표시한다. 어떤 모델을 어떤 객체에 배정하는지와 대표 치수 `size_m`은 `user_application/web/assets/models/manifest.json`이 정의하며, 로켓 본체와 파편은 모델을 배정하지 않는다. 모델 자세는 진행 방향과 천정 기준의 표시용 근사이고 실제 자세 추정이 아니다. 자산 갱신과 무결성 검증은 `python project_support/tools/fetch_nasa_models.py`와 `--verify` 옵션으로 수행한다. 출처 표와 사용 지침은 [모델 폴더 README](user_application/web/assets/models/README.md)에 있다.

기록 버튼은 현재 상태 플래그이며 영구 시험 로그 수집이 아니다. 메모리 이벤트와 브라우저 표시 이력을 저장소 기반 replay로 취급하지 않는다. 실제 장비, 학습 파이프라인, PRISM 및 병렬 미래 rollout은 아직 구현하지 않았다.

## 원본 보존

재구성 전 92개 파일의 ZIP 백업은 `D:\ICDCDT_before_framework_20260907.zip`이다. 내부 manifest의 SHA-256을 검증했다. 기존 backend 소스는 `project_support/reference/before_refactoring`에도 비교용으로 보존한다. `D:\AeroDT`는 수정하지 않았다.

백업, 과거 기획 자료(`project_support/reference`), 실행 캐시와 로그, 개인 개발 도구 설정은 로컬에만 보관하며 Git 저장소에는 포함하지 않는다. 앱에 포함된 웹 이미지 자산은 함께 버전 관리한다.
