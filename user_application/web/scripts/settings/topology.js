// 설정 탭의 모듈 연결 토폴로지 카탈로그와 순수 계산 함수. DOM에 의존하지 않아 node:test로 시험한다.
// 링크 상태는 운용 모드, 연결 진단 결과와 실제 운용 콘솔 WebSocket 상태를 구분한다.
// 보안 운용 SW의 실제 배치는 서버 보고를 따르고 외부 보안 시스템은 기본 미연동이다.

export const STORAGE_KEY = "spacetwin-integration-settings";
export const VIEWBOX = { width: 1320, height: 720 };
export const TRANSPORTS = ["IPC", "TCP", "UDP", "WebSocket", "gRPC"];
const TRANSPORT_LABELS = { IPC: "내장 IPC", TCP: "TCP", UDP: "UDP", WebSocket: "WebSocket", gRPC: "gRPC" };

export const MODES = [
  { id: "standalone", label: "단독 운용", description: "DT 코어와 운용 SW 모듈만으로 운용한다. EM 연동 링크와 검증 지원 링크는 대기 상태로 둔다." },
  { id: "em", label: "EM 연동", description: "DT 통신 계층이 EM 통신 계층과 연결되어 탑재 장비 통제 명령을 보내고 실시간 상태와 갱신 내용을 받는다." },
  { id: "integration", label: "통합 시험", description: "EM 연동에 검증 지원(시험 관리 · 시험결과 DB · 분석)까지 모두 연결한 전체 구성이다." },
];
const ALL_MODES = MODES.map(mode => mode.id);
const LINKED_MODES = ["em", "integration"];

export const GROUPS = {
  core: { label: "DT 코어" },
  ops: { label: "운용 SW 모듈" },
  em: { label: "EM 연동" },
  verify: { label: "검증 지원" },
};

export const PLACEMENTS = {
  embedded: { label: "내장", description: "이 프로세스 안에 내장되어 실행 중" },
  simulated: { label: "모의", description: "외부 시스템을 프로세스 안에서 모의" },
  external: { label: "외부", description: "별도 컴퓨터에 배치 예정" },
};

export const ZONES = [
  { id: "em", group: "em", label: "EM 연동 · 외부 시스템", x: 16, y: 16, w: 396, h: 688 },
  { id: "core", group: "core", label: "DT 코어 · ISDC-ODT", x: 420, y: 16, w: 504, h: 688 },
  { id: "ops", group: "ops", label: "운용 SW 모듈", x: 940, y: 16, w: 364, h: 440 },
  { id: "verify", group: "verify", label: "검증 지원", x: 940, y: 472, w: 364, h: 232 },
];

export const MODULES = [
  { id: "framework", name: "통합 프레임워크", role: "모듈 연동 관리 · 모델 동기화", group: "core", placement: "embedded", x: 696, y: 276, w: 196, h: 116,
    functions: ["내부 SW 모듈 간 연동 관리 (ICD-01/02/03/08 브리지)", "DT 모델과 시각화 연동", "ICD 기반 메시지 라우팅과 외부 모듈 전달", "운용 모드 전환 · 시나리오 실행 제어"] },
  { id: "console", name: "운용 콘솔", role: "이 브라우저 · WebSocket", group: "core", placement: "embedded", x: 696, y: 80, w: 196, h: 88,
    functions: ["8개 탭 운용 화면", "REST 제어 요청", "WebSocket 텔레메트리 수신"] },
  { id: "dt-comm", name: "DT 통신 계층", role: "외부 연동 게이트웨이", group: "core", placement: "embedded", x: 480, y: 290, w: 144, h: 88,
    functions: ["EM 통신 계층과의 세션 관리", "통제 명령 송신 · 실시간 상태 수신", "하트비트 감시 · 재연결"] },
  { id: "engine", name: "DT 엔진", role: "시각화 · 시뮬레이션", group: "core", placement: "embedded", x: 440, y: 584, w: 144, h: 88,
    functions: ["궤도 · 자세 전파(SGP4)", "임무 장비 구동 모사 · 센싱 데이터 모사", "운용 데이터 생성 · 시각화"] },
  { id: "model", name: "DT 모델", role: "노드·임무·네트워크·장애", group: "core", placement: "embedded", x: 600, y: 584, w: 144, h: 88,
    functions: ["노드 모델", "임무 모델", "네트워크 모델", "장애 · What-if 모델", "데이터 · 보안 모델"] },
  { id: "swarm-model", name: "군집 운용 모델", role: "군집 노드 · 임무 모델", group: "core", placement: "embedded", x: 760, y: 584, w: 144, h: 88,
    functions: ["군집 노드 모델", "군집 임무 모델"] },
  { id: "data-dist", name: "데이터 관리", role: "추출/필터링 · 분산 저장 · 복제/정합성 · Self-healing", group: "ops", placement: "embedded", x: 1016, y: 60, w: 268, h: 80,
    functions: ["데이터 추출 · 필터링", "데이터 분산(DFS)", "복제 · 동기화 · 정합성 관리", "Self-healing"] },
  { id: "data-fabric", name: "데이터 패브릭", role: "자율 라우팅 · DTN 스택 · OISL 광통신", group: "ops", placement: "embedded", x: 1016, y: 160, w: 268, h: 80,
    functions: ["자율 라우팅 · 실시간 데이터 경로 관리", "DTN 프로토콜 스택", "OISL 레이저 광통신"] },
  { id: "orchestrator", name: "군집 오케스트레이션", role: "SDC 군집 운용", group: "ops", placement: "embedded", x: 1016, y: 260, w: 268, h: 80,
    functions: ["군집 편성 · 역할 배정", "군집 상태 수집 · 재구성"] },
  { id: "em-comm", name: "EM 통신 계층", role: "탑재 게이트웨이", group: "em", placement: "simulated", x: 252, y: 290, w: 144, h: 88,
    functions: ["DT 통신 계층과의 세션 종단", "탑재 모듈 간 메시지 중계"] },
  { id: "em-ops", name: "EM 운용 모듈", role: "탑재 장비 운용 · 통제", group: "em", placement: "simulated", x: 36, y: 90, w: 156, h: 88,
    functions: ["위성체 · 임무 장비 통제 명령 수행", "데이터 송수신 통제"] },
  { id: "em-analysis", name: "EM 데이터 분석", role: "탑재 데이터 분석", group: "em", placement: "simulated", x: 36, y: 290, w: 156, h: 88,
    functions: ["탑재 데이터 분석", "실시간 정보 · 갱신 내용 생성"] },
  { id: "sbc", name: "SBC 컴퓨팅", role: "고신뢰 탑재 컴퓨터", group: "em", placement: "simulated", x: 36, y: 490, w: 156, h: 88,
    functions: ["우주환경 대응 고신뢰 SBC 플랫폼", "컴퓨팅 · 제어"] },
  { id: "security-ops", name: "보안 운용 SW", role: "SIM 규칙 판정 (실측 아님)", group: "ops", placement: "embedded", x: 1016, y: 360, w: 268, h: 80,
    functions: ["SIM 인증률의 규칙 판정", "관측 누락과 판정 전환 보고", "ICD-08 초안 계약", "실제 암호화와 파일 무결성은 검증하지 않음"] },
  { id: "security-external", name: "외부 보안 시스템", role: "PQC/TEE, SDLS, 키 관리 미연동", group: "em", placement: "external", x: 220, y: 490, w: 176, h: 88,
    functions: ["실제 외부 제품과 종단 미지정", "프로토콜 어댑터 미구현", "MOCK 장비를 실제 연결 증거로 사용하지 않음"] },
  { id: "test-mgr", name: "시험 관리", role: "시나리오 재생 · KPI 판정", group: "verify", placement: "embedded", x: 958, y: 502, w: 140, h: 72,
    functions: ["PoC 시나리오 정의와 세팅 (군집 · 지상국 · 임무)", "단계별 재생과 안내, 장애 주입과 재구성 요청", "단계별 KPI 표본 수집 (VF-02)", "정상 대비 복구 판정과 결과 기록 (VF-03)"] },
  { id: "result-db", name: "시험결과 DB", role: "결과 저장 · 조회", group: "verify", placement: "embedded", x: 1158, y: 502, w: 128, h: 72,
    functions: ["시험 결과 저장", "실행 이력 조회"] },
  { id: "analysis", name: "분석", role: "KPI · 보고서", group: "verify", placement: "embedded", x: 1050, y: 612, w: 164, h: 76,
    functions: ["KPI 평가", "보고서 생성"] },
];

const tcp = (port, extra = {}) => ({ transport: "TCP", host: "127.0.0.1", port, heartbeat: 2, timeout: 6, reconnect: true, enabled: true, ...extra });
const ipc = () => ({ transport: "IPC", host: "in-process", port: 0, heartbeat: 1, timeout: 3, reconnect: true, enabled: true });

export const LINKS = [
  { id: "L01", from: "data-dist", to: "framework", kind: "icd", icd: "ICD-01", modes: ALL_MODES, defaults: tcp(5101) },
  { id: "L02", from: "data-fabric", to: "framework", kind: "icd", icd: "ICD-02", modes: ALL_MODES, defaults: tcp(5102, { transport: "UDP", heartbeat: 1, timeout: 3 }) },
  { id: "L03", from: "orchestrator", to: "framework", kind: "icd", icd: "ICD-03", modes: ALL_MODES, defaults: tcp(5103) },
  { id: "L04", from: "dt-comm", to: "em-comm", kind: "icd", icd: "ICD-04", modes: LINKED_MODES, defaults: tcp(5204, { heartbeat: 1, timeout: 4 }) },
  { id: "L05", from: "framework", to: "dt-comm", kind: "internal", modes: ALL_MODES, defaults: ipc() },
  { id: "L06", from: "framework", to: "engine", kind: "icd", icd: "ICD-05", modes: ALL_MODES, defaults: ipc() },
  { id: "L07", from: "framework", to: "model", kind: "internal", modes: ALL_MODES, defaults: ipc() },
  { id: "L08", from: "framework", to: "swarm-model", kind: "internal", modes: ALL_MODES, defaults: ipc() },
  { id: "L09", from: "console", to: "framework", kind: "console", icd: "ICD-07", modes: ALL_MODES, defaults: { transport: "WebSocket", host: "self", port: 0, heartbeat: 1, timeout: 5, reconnect: true, enabled: true } },
  { id: "L10", from: "framework", to: "test-mgr", kind: "icd", icd: "ICD-06", modes: ALL_MODES, defaults: ipc() },
  { id: "L11", from: "test-mgr", to: "result-db", kind: "internal", modes: ["integration"], defaults: tcp(5432, { heartbeat: 5, timeout: 10 }) },
  { id: "L12", from: "result-db", to: "analysis", kind: "internal", modes: ["integration"], defaults: tcp(5432, { heartbeat: 5, timeout: 10 }) },
  { id: "L13", from: "em-comm", to: "em-ops", kind: "external", via: "L04", modes: LINKED_MODES, defaults: ipc() },
  { id: "L14", from: "em-comm", to: "em-analysis", kind: "external", via: "L04", modes: LINKED_MODES, defaults: ipc() },
  { id: "L15", from: "em-comm", to: "sbc", kind: "external", via: "L04", modes: LINKED_MODES, defaults: ipc() },
  { id: "L16", from: "security-ops", to: "framework", kind: "icd", icd: "ICD-08", modes: ALL_MODES, defaults: ipc() },
  { id: "L17", from: "dt-comm", to: "security-external", kind: "security-external", modes: ALL_MODES, defaults: tcp(0, { host: "미지정", enabled: false, reconnect: false }) },
];

export const LINK_KINDS = {
  icd: "ICD 연동",
  internal: "내부 연결",
  external: "EM 내부 버스",
  console: "운용 콘솔",
  "security-external": "외부 보안 진단 (프로토콜 미검증)",
};

export const LINK_STATES = {
  active: { label: "연결", badge: "success", dot: "ok" },
  down: { label: "단절", badge: "danger", dot: "danger" },
  standby: { label: "대기", badge: "neutral", dot: "" },
  disabled: { label: "사용 안 함", badge: "warning", dot: "warning" },
  unknown: { label: "미확인", badge: "neutral", dot: "warning" },
};

const PROBE_METHODS = { "in-process": "내장", "tcp-connect": "TCP", "udp-resolve": "UDP" };

export const ICD_STATUSES = {
  approved: { label: "승인", badge: "success" },
  review: { label: "검토", badge: "info" },
  draft: { label: "초안", badge: "warning" },
};

// direction: "ab" = parties[0] → parties[1], "ba" = 반대, "both" = 양방향
// status of a message: "implemented" (code exchanges it today), "simulated" (a stand-in models the
// exchange in this process), "planned" (defined for the partner module, not exchanged yet).
export const MESSAGE_STATUSES = {
  implemented: { label: "구현", badge: "success" },
  simulated: { label: "모의", badge: "info" },
  planned: { label: "계획", badge: "warning" },
};

export const ICDS = [
  { id: "ICD-01", title: "데이터 관리 연동", link: "L01", parties: ["framework", "data-dist"], version: "1.4", status: "approved", revised: "2026-09-08",
    summary: "데이터 센터의 수명주기 연동이다. 트윈이 저장 노드 상태와 생성된 데이터 제품을 등록하고, 데이터 관리 모듈이 배치·복제·정합성·서비스 결과를 보고한다. 데이터를 어디에 두고 온전한지를 다루며, 경로와 전달을 다루는 ICD-02(데이터 패브릭)와 구분된다. 시간 기준은 트윈 시뮬레이션 경과 초(sim_elapsed_s)이고, 모든 메시지는 실행과 배치를 구분하는 scope_id(범위 계약 isolated-v1)를 갖는다. 저장 노드 명부는 노드 탭에서 배치한 SDC 위성의 서버 수락 구성에서 만들어진다.",
    messages: [
      { id: "DM-01", name: "수집 등록", direction: "ab", rate: "대시보드 조회마다 (3 s)", size: "≤ 2000건/배치", status: "implemented", description: "배치 노드가 생성한 데이터 제품(참조, 종류, 생성 노드, 크기, 우선순위, 생성 시각). 응답은 수락 객체와 복제본 배치, 필터 거부 사유" },
      { id: "DM-02", name: "서비스 요청", direction: "ab", rate: "이벤트", size: "512 B", status: "implemented", description: "객체 ID 또는 종류와 수신 노드. 응답은 제공 복제본, 예상 지연, 실패 사유. 시나리오 5단계가 관문 위성의 요청으로 보낸다" },
      { id: "DM-03", name: "운영 조치", direction: "ab", rate: "이벤트", size: "≤ 8 KB", status: "implemented", description: "무결성 검사, 자가복구, 재균형, 복제 계수 변경, 필터 규칙 갱신, 만료 정리" },
      { id: "DM-04", name: "저장 노드 상태 갱신", direction: "ab", rate: "3 s", size: "≤ 64 KB", status: "implemented", description: "서버가 수락한 배치의 저장 노드 명세(탑재 저장 용량)와 가용 여부. 심각 장애로 노드가 내려가면 여기서 전달된다" },
      { id: "DM-05", name: "상태 보고", direction: "ba", rate: "3 s", size: "≤ 16 KB", status: "implemented", description: "안정성 점수와 구성 요소, 파이프라인 단계, 용량, 진행 작업, 경고. 시나리오 KPI의 데이터 안정성 항목" },
      { id: "DM-06", name: "카탈로그 조회", direction: "ba", rate: "3 s", size: "≤ 256 KB", status: "implemented", description: "데이터 객체와 복제본 배치, 상태, 계층, 체크섬" },
      { id: "DM-07", name: "저장 노드 상태", direction: "ba", rate: "3 s", size: "≤ 8 KB", status: "implemented", description: "노드별 사용량, 객체 수, 복제본 상태 분포" },
      { id: "DM-08", name: "이벤트", direction: "ba", rate: "이벤트", size: "≤ 8 KB", status: "implemented", description: "수집, 복제 부족, 무결성 손상, 자가복구, 노드 이탈·복귀, 용량 경고, 정책 변경" },
      { id: "DM-09", name: "모듈 상태", direction: "ba", rate: "요청당", size: "512 B", status: "implemented", description: "구현, 버전, 배치 위치, 엔드포인트, 메시지 순번, 범위 계약" },
    ],
    history: ["v1.4 (2026-09-08) 범위 계약 scope_id와 배치 기반 명부 명시, 시나리오 서비스 요청 용도 추가", "v1.3 (2026-09-07) DM-01~DM-09으로 재정의, 시뮬레이션 시각 기준 명시", "v1.2 (2026-08-21) 복구 완료 코드 추가", "v1.0 (2026-04-15) 최초 승인"] },
  { id: "ICD-02", title: "데이터 패브릭 연동", link: "L02", parties: ["framework", "data-fabric"], version: "2.0", status: "approved", revised: "2026-09-08",
    summary: "디지털 트윈이 계산한 네트워크 상태(위성·지상국 노드, OISL 단말 상태와 기하, 지상 RF 기하, 지상망)를 보내고, 데이터 패브릭이 링크별 사용 가능 여부와 품질, 위성별 지상 경로와 저장 전달 상태, 요청 경로를 돌려준다. 활성 SIM 장애는 트윈이 링크의 faulted 속성으로 접어 보내므로 패브릭은 런타임의 장애 모델을 모르며, 그래서 장애가 곧바로 공통 상태로 전달된다. 시간 기준은 트윈 분석 시각(UTC)이며 메시지 사이의 경과 시간이 저장 전달 모델을 진행시킨다.",
    messages: [
      { id: "DF-01", name: "네트워크 상태 갱신", direction: "ab", rate: "1 s", size: "≤ 64 KB", status: "implemented", description: "노드(kind, 운용 모드, 생성률, 저장 용량, 추가 지연)와 링크(OISL: 단말 상태·거리·정격 전송률·기하 여유, 지상 RF: 대역·고각·거리·EIRP·G/T·주파수, 지상망: 거리), 링크별 faulted" },
      { id: "DF-02", name: "링크 판정 · 경로 · 저장 전달 보고", direction: "ba", rate: "DF-01 응답", size: "≤ 64 KB", status: "implemented", description: "링크별 usable·사유·편도 지연·용량·품질·Eb/N0 여유·BER, 위성별 지상 경로·다음 홉·지연·병목·보관량·custody, 지상국별 담당 위성, 요약(사용 가능 링크, 지상 연결 위성, 전달·보관·폐기량)" },
      { id: "DF-03", name: "경로 계산 요청", direction: "ab", rate: "이벤트 (재생 중 2 s)", size: "256 B", status: "implemented", description: "출발·목적 노드와 목적(최저 지연, 최대 신뢰도, 균형). 마지막 네트워크 상태의 사용 가능 링크 위에서 계산" },
      { id: "DF-04", name: "경로 계산 결과", direction: "ba", rate: "DF-03 응답", size: "≤ 4 KB", status: "implemented", description: "status(available·unavailable·no_network), 경로, 구간별 지연·용량·품질, 편도 지연 합, 병목 용량, 신뢰도. 시나리오의 우회 경로와 주 경로 복귀 판정 근거" },
      { id: "DF-05", name: "모듈 상태", direction: "ba", rate: "30 s", size: "512 B", status: "implemented", description: "구현, 버전, 배치, 엔드포인트, 순번, 마지막 갱신 시각, 노드·링크 수" },
      { id: "DF-06", name: "번들 전달 상태", direction: "ba", rate: "이벤트", size: "≤ 8 KB", status: "planned", description: "개별 DTN 번들의 생성·보관·전달·만료 (현재 임시 구현은 위성별 보관 총량만 보고한다)" },
    ],
    history: ["v2.0 (2026-09-08) 실제 교환 메시지(DF-01~DF-05)로 재정의, 구 DF-001~004 폐기, 번들 전달 상태를 계획 항목으로 분리", "v1.1 (2026-07-18) DF-003 포착 상태 필드 추가", "v1.0 (2026-05-02) 최초 승인"] },
  { id: "ICD-03", title: "군집 오케스트레이션 연동", link: "L03", parties: ["framework", "orchestrator"], version: "1.1", status: "review", revised: "2026-09-08",
    summary: "디지털 트윈이 임무 요청과 함께 계산한 창(지상국 접속, 관측 통과, 외부 위성 교차링크, 식)과 위성 상태, 현재 OISL 격자를 보내고, 군집 운용 모듈이 위성별 작업 배정과 실행 가능 판정을 돌려준다. 운용자의 실행 확정과 중단은 모듈에 통보되어 점유 구간으로 기억된다. 격자에서는 런타임이 장애로 보고한 링크가 제외되므로 재구성 요청이 자동으로 우회 경로를 받는다.",
    messages: [
      { id: "OR-01", name: "임무 편성 요청", direction: "ab", rate: "이벤트", size: "≤ 512 KB", status: "implemented", description: "임무(종류, 우선순위, 계획 창, 기한, 종류별 항목), 위성(운용 모드, 능력, 전력, 확정 작업 점유), 지상국, 창(접속·관측·교차링크·식), OISL 격자(장애 링크 제외), 제외 위성, 계획 지평과 장애 링크·지상국 목록" },
      { id: "OR-02", name: "역할 배정 결과", direction: "ba", rate: "OR-01 응답", size: "≤ 64 KB", status: "implemented", description: "작업 목록(종류, 위성, 상대, 시작·끝, 크기, 전송률, 근거 창, 선행), 실행 가능 여부, 요약(완료 예정, 여유, 경로, 홉, 종단 지연), 검사 항목(기한·저장·배터리·지연), 사유, 대안 수, 제외 위성" },
      { id: "OR-03", name: "실행 확정 · 중단 통보", direction: "ab", rate: "이벤트", size: "≤ 32 KB", status: "implemented", description: "임무 ID, 계획 버전, decision(commit·abort), 확정 작업 목록. 응답은 수락 여부와 점유 작업 수. 재구성 후에도 다시 통보한다" },
      { id: "OR-04", name: "모듈 상태", direction: "ba", rate: "30 s", size: "≤ 4 KB", status: "implemented", description: "구현, 버전, 순번, 임무별 마지막 판정과 확정 여부, 점유 중인 계획" },
      { id: "OR-05", name: "군집 상태 보고", direction: "ba", rate: "이벤트", size: "≤ 8 KB", status: "planned", description: "모듈이 스스로 감지한 노드 이탈·복귀와 재구성 필요 알림 (현재는 트윈이 실행 위성의 모드·배치·장애 링크로 재구성 필요를 판정한다)" },
    ],
    history: ["v1.1 (2026-09-08) 실제 메시지(OR-01~OR-04)로 재정의, 실행 확정·중단 통보와 장애 링크 제외 격자 추가, 군집 상태 보고는 계획 항목", "v1.0 (2026-08-30) 검토 중", "v0.9 (2026-07-05) 초안 배포"] },
  { id: "ICD-04", title: "EM 연동", link: "L04", parties: ["dt-comm", "em-comm"], version: "0.9", status: "draft", revised: "2026-09-01",
    summary: "DT 통신 계층이 위성체 · 임무 장비 통제 명령과 데이터 송수신 통제 명령을 보내고, EM 통신 계층이 실시간 정보와 갱신 내용을 돌려준다. EM은 이 프로세스 안의 모의이며 실제 탑재 장비 프로토콜은 아직 없다.",
    messages: [
      { id: "EM-001", name: "위성체 · 임무 장비 통제 명령", direction: "ab", rate: "이벤트", size: "≤ 2 KB", status: "simulated", description: "장비 ID, 명령 코드, 인자, 실행 시각 (MOCK-HIL 장비 조작 /api/hil)" },
      { id: "EM-002", name: "데이터 송수신 통제 명령", direction: "ab", rate: "이벤트", size: "1 KB", status: "planned", description: "송수신 창, 대상 노드, 우선순위" },
      { id: "EM-003", name: "실시간 상태 정보", direction: "ba", rate: "1 s", size: "2 KB", status: "simulated", description: "장비 상태, 전력 · 열 · 자세 요약 (SIM 텔레메트리)" },
      { id: "EM-004", name: "갱신 내용", direction: "ba", rate: "이벤트", size: "≤ 32 KB", status: "planned", description: "탑재 SW · 파라미터 갱신 결과" },
      { id: "EM-005", name: "하트비트", direction: "both", rate: "1 s", size: "64 B", status: "planned", description: "세션 유지 · 시각 동기" },
    ],
    history: ["v0.9 (2026-09-01) EM-004 크기 상한 조정", "v0.8 (2026-08-12) 초안 배포"] },
  { id: "ICD-05", title: "DT 엔진 연동", link: "L06", parties: ["framework", "engine"], version: "1.4", status: "approved", revised: "2026-09-08",
    summary: "프레임워크가 모델을 동기화하고 시뮬레이션을 제어하며, 엔진이 운용 데이터와 이벤트를 돌려준다. 현재 내장 REST와 WebSocket으로 이어진다. 브라우저의 궤도·OISL·지상 링크 계산과 서버 SIM 런타임이 함께 DT 엔진을 이룬다.",
    messages: [
      { id: "EN-01", name: "모델 동기화 · 배치 수락", direction: "ab", rate: "이벤트", size: "≤ 256 KB", status: "implemented", description: "노드 탭의 배치 명령(ID, 이름, 모드, 장비)을 런타임이 수락해 사본과 버전을 소유 (/api/data-management/deployment)" },
      { id: "EN-02", name: "시뮬레이션 제어", direction: "ab", rate: "이벤트", size: "128 B", status: "implemented", description: "시작 · 정지 · 스텝 · 배속 · 시나리오 선택 · 시계 전진 (/api/runtime, /api/scenario)" },
      { id: "EN-03", name: "운용 데이터", direction: "ba", rate: "1 Hz", size: "≤ 8 KB", status: "implemented", description: "런타임 상태, SIM 텔레메트리(전력 · 온도 · 링크 품질 · 손실률 · 인증률), 장비 상태, 이벤트 (/ws/telemetry)" },
      { id: "EN-04", name: "이벤트", direction: "ba", rate: "이벤트", size: "512 B", status: "implemented", description: "장애 주입·해제, 시나리오 로드, 시계 전진, 실행 제어 이벤트" },
      { id: "EN-05", name: "네트워크 · 창 계산", direction: "ba", rate: "1 s / 이벤트", size: "가변", status: "implemented", description: "브라우저 엔진이 만든 위성 상태, OISL 단말 상태, 지상 링크 기하, 접속·관측·교차링크·식 창. ICD-02와 ICD-03 요청의 입력" },
    ],
    history: ["v1.4 (2026-09-08) 배치 수락, 시나리오 제어와 브라우저 엔진의 창 계산을 실제 경로로 명시", "v1.3 (2026-08-05) EN-003 주기 10 Hz 고정", "v1.2 (2026-06-11) EN-004 임무 전이 추가", "v1.0 (2026-03-20) 최초 승인"] },
  { id: "ICD-06", title: "검증 지원 연동", link: "L10", parties: ["framework", "test-mgr"], version: "1.0", status: "review", revised: "2026-09-08",
    summary: "시험 관리가 시험 시나리오를 정의해 주입하고 KPI 표본과 결과 기록을 받는다. 현재는 콘솔에 내장된 시나리오 재생기가 이 역할을 맡는다: PoC 시나리오 정의(/api/scenarios)를 세팅해 군집·지상국·임무를 구성하고, 단계마다 각 모듈의 보고를 KPI 표본으로 모아 정상 대비 복구를 판정하며 결과를 JSON으로 기록한다. 외부 시험 관리 모듈이 오면 같은 메시지를 별도 프로세스로 옮긴다.",
    messages: [
      { id: "VF-01", name: "시험 시나리오 정의 · 주입", direction: "ba", rate: "이벤트", size: "≤ 64 KB", status: "implemented", description: "군집 정의(편대, 역할, 장비), 지상국, 임무, 단계(시각 기준점, 조치, 안내, 확인 항목), 판정 기준 (user_application/configs/scenarios.py, /api/scenarios)" },
      { id: "VF-02", name: "KPI 샘플", direction: "ab", rate: "2 s (재생 중)", size: "≤ 2 KB", status: "implemented", description: "경로(홉, 지연, 신뢰도), 임무(상태, 여유, 종단 지연), 패브릭(사용 가능 링크, N1 보관량), 데이터(안정성, 객체), 보안(판정)의 표본. 단계별 기준선·장애·우회·복구 구간" },
      { id: "VF-03", name: "시험 결과 기록", direction: "ab", rate: "이벤트", size: "≤ 128 KB", status: "implemented", description: "판정 그룹(도달·자원·상태)별 규칙 결과, 구간 비교표, 사건 시각(장애 주입, 재수렴, 재구성, 해제, 복귀), ICD 메시지 이력" },
      { id: "VF-04", name: "시험 결과 저장 · 조회", direction: "both", rate: "이벤트", size: "가변", status: "planned", description: "시험결과 DB와 분석 모듈로의 전달 (통합 시험 모드, 외부 배치 예정)" },
    ],
    history: ["v1.0 (2026-09-08) 내장 시나리오 재생기로 VF-01~VF-03 구현, DB 저장은 계획 항목", "v0.8 (2026-08-27) VF-002 KPI 목록 정리", "v0.5 (2026-06-02) 초안 배포"] },
  { id: "ICD-07", title: "운용 콘솔 텔레메트리", link: "L09", parties: ["framework", "console"], version: "1.1", status: "approved", revised: "2026-09-08",
    summary: "운용 콘솔이 REST로 제어하고 WebSocket으로 텔레메트리를 받는다. 이 링크는 실제 연결 상태를 반영한다. 시나리오 재생 중에는 콘솔의 모든 분석 시계가 런타임 시계(실행 시작 UTC + 경과 초)를 따른다.",
    messages: [
      { id: "CS-001", name: "런타임 스냅샷", direction: "ab", rate: "1 Hz", size: "1 KB", status: "implemented", description: "run_id, 시나리오, 시작 UTC, 경과, 배속, 활성 장애" },
      { id: "CS-002", name: "텔레메트리", direction: "ab", rate: "1 Hz", size: "≤ 4 KB", status: "implemented", description: "전력 · 온도 · 링크 품질 · 손실률 · 인증률" },
      { id: "CS-003", name: "이벤트 · 장비 · 임무", direction: "ab", rate: "1 Hz", size: "≤ 16 KB", status: "implemented", description: "이벤트 이력, 장비 상태, SIM 임무 계획" },
      { id: "CS-004", name: "제어 요청", direction: "ba", rate: "이벤트", size: "≤ 1 KB", status: "implemented", description: "REST /api/runtime(시작 · 정지 · 스텝 · 배속), /api/scenario(선택 · 시계 전진), /api/faults(장애 주입), /api/missions, /api/data-management/deployment(배치 명령)" },
      { id: "CS-005", name: "모듈 대시보드 조회", direction: "ba", rate: "2~5 s", size: "≤ 256 KB", status: "implemented", description: "프레임워크가 각 운용 SW의 ICD를 대신 교환해 합친 화면용 보고 (/api/data-management/dashboard, /api/security/dashboard)" },
    ],
    history: ["v1.1 (2026-09-08) 시나리오 제어와 배치 명령, 모듈 대시보드 조회 추가", "v1.0 (2026-09-07) 현행 구현과 일치"] },
  { id: "ICD-08", title: "보안 모니터링 연동", link: "L16", parties: ["framework", "security-ops"], version: "1.0", status: "draft", revised: "2026-09-08",
    summary: "DT의 SIM 관측값을 별도 보안 운용 SW에 전달하고 규칙 판정과 전환 이력을 조회하는 초안이다. 실측 보안 검증, 암호화, 침입 탐지 또는 영구 감사 로그가 아니다. 외부 배치는 서버 SPACETWIN_SECURITY_URL 설정과 재시작으로 반영하며 브라우저 진단 주소와 구분한다. 시나리오 재생기는 단계마다 판정을 표본으로 모아 링크 장애 중에도 판정이 유지되는지 확인한다.",
    messages: [
      { id: "SEC-01", name: "SIM 관측 전달", direction: "ab", rate: "콘솔 조회 시", size: "가변", status: "implemented", description: "계약 버전, 실행과 표본 식별자, SIM 경과 초, 생성 UTC, 인증률, 처리량과 손실률" },
      { id: "SEC-02", name: "판정 조회", direction: "ba", rate: "콘솔 조회 시", size: "가변", status: "implemented", description: "인증률 규칙 판정과 근거. 암호화와 파일 무결성은 미확인" },
      { id: "SEC-03", name: "전환 이력", direction: "ba", rate: "콘솔 조회 시", size: "최대 200건", status: "implemented", description: "모듈 실행 중 메모리에 보관하는 SIM 판정 전환" },
      { id: "SEC-04", name: "모듈 상태", direction: "ba", rate: "요청 시", size: "가변", status: "implemented", description: "실제 배치, 주소, 응답 상태, 구현과 계약 버전" },
    ], history: ["v1.0 (2026-09-08) SIM 보안 모니터링 계약 초안"] },
];

export function transportLabel(transport) {
  return TRANSPORT_LABELS[transport] || String(transport || "—");
}

export function modeById(id) {
  return MODES.find(mode => mode.id === id) || MODES[0];
}

export function moduleById(id) {
  return MODULES.find(module => module.id === id) || null;
}

export function linkById(id) {
  return LINKS.find(link => link.id === id) || null;
}

export function icdById(id) {
  return ICDS.find(icd => icd.id === id) || null;
}

export function linksOfModule(id) {
  return LINKS.filter(link => link.from === id || link.to === id);
}

export function isEmbeddedHost(host) {
  const value = String(host ?? "").trim().toLowerCase();
  if (!value || value === "self" || value === "in-process" || value === "localhost" || value === "::1") return true;
  return value.startsWith("127.");
}

export function resolveLink(link, overrides = {}) {
  return { ...link.defaults, ...(overrides?.[link.id] || {}) };
}

export function normalizeLinkSettings(input, link) {
  const base = link?.defaults || {};
  const transport = TRANSPORTS.includes(input?.transport) ? input.transport : base.transport;
  const host = String(input?.host ?? base.host ?? "").trim() || base.host || "127.0.0.1";
  const port = Number.parseInt(input?.port, 10);
  const heartbeat = Number(input?.heartbeat);
  const timeout = Number(input?.timeout);
  return {
    transport,
    host,
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : base.port ?? 0,
    heartbeat: Number.isFinite(heartbeat) && heartbeat > 0 ? Math.round(heartbeat * 10) / 10 : base.heartbeat ?? 1,
    timeout: Number.isFinite(timeout) && timeout > 0 ? Math.round(timeout * 10) / 10 : base.timeout ?? 5,
    reconnect: Boolean(input?.reconnect),
    enabled: Boolean(input?.enabled),
  };
}

export function endpointOf(settings, selfHost = "") {
  if (settings.transport === "IPC") return "in-process";
  if (settings.host === "self") return selfHost || "현재 호스트";
  return settings.port ? `${settings.host}:${settings.port}` : settings.host;
}

export function linkState(link, context = {}) {
  const { mode = "standalone", overrides = {}, health = {} } = context;
  const settings = resolveLink(link, overrides);
  if (!link.modes.includes(mode)) return { state: "standby", reason: `${modeById(mode).label} 모드에서는 사용하지 않는 링크` };
  if (settings.enabled === false) return { state: "disabled", reason: "운용자 설정으로 사용 안 함" };
  if (link.kind === "console") {
    const socket = health.socket;
    if (socket === "open") return { state: "active", reason: "WebSocket 텔레메트리 수신 중" };
    if (socket === "connecting" || socket == null) return { state: "down", reason: "WebSocket 연결 중" };
    return { state: "down", reason: `WebSocket ${socket === "error" ? "오류" : "끊김"} · 재연결 대기` };
  }
  if (link.kind === "external") {
    const gate = linkById(link.via);
    const gateState = gate ? linkState(gate, context) : { state: "down" };
    return gateState.state === "active"
      ? { state: "active", reason: "EM 통신 계층 경유 상태 보고" }
      : { state: "down", reason: "EM 게이트웨이 단절 · 상태 확인 불가" };
  }
  // A backend probe result, when one exists, is the truth: it checked the embedded modules or really
  // connected to the configured endpoint. Without probing (no backend answer yet) fall back to the
  // placement rule: local endpoints are the embedded modules, remote ones have nothing deployed.
  const probe = health.probes?.[link.id];
  if (probe) {
    if (probe.state === "up") return { state: "active", reason: probeReason(probe) };
    if (probe.state === "unverified") return { state: "unknown", reason: probeReason(probe) };
    return { state: "down", reason: probeReason(probe) };
  }
  if (health.probes) return { state: "unknown", reason: "연결 확인 중" };
  if ([link.from, link.to].some(id => id.startsWith("security-"))) return { state: "unknown", reason: "모듈 응답 또는 보안 프로토콜 확인 근거 없음" };
  if (!isEmbeddedHost(settings.host)) return { state: "down", reason: `${endpointOf(settings)} 응답 없음 · 원격 모듈 미배치` };
  if (settings.transport === "IPC") return { state: "active", reason: "내장 모듈 · 프로세스 내 연결" };
  return { state: "active", reason: `내장 모듈 · ${transportLabel(settings.transport)} ${endpointOf(settings)}` };
}

export function probeReason(probe) {
  const method = PROBE_METHODS[probe.method] || probe.method || "";
  const latency = probe.latency_ms != null && probe.method !== "in-process" ? ` · ${probe.latency_ms} ms` : "";
  return `${method ? `${method} · ` : ""}${probe.detail || ""}${latency}`;
}

// Links the backend can check: everything in use except the console socket (measured in the
// browser) and the EM internal bus (reported through its gateway).
export function probeTargets(evaluations) {
  return evaluations
    .filter(item => ["icd", "internal", "security-external"].includes(item.link.kind) && item.state !== "standby" && item.state !== "disabled")
    .map(item => ({
      id: item.link.id,
      transport: item.settings.transport,
      host: item.settings.host,
      port: item.settings.port,
      timeout_s: Math.min(5, Math.max(0.1, Number(item.settings.timeout) || 1)),
      endpoints: [item.link.from, item.link.to],
    }));
}

export function evaluateLinks(context = {}) {
  return LINKS.map(link => ({ link, settings: resolveLink(link, context.overrides), ...linkState(link, context) }));
}

export function summarize(evaluations) {
  const summary = { total: evaluations.length, active: 0, down: 0, standby: 0, disabled: 0, unknown: 0 };
  for (const item of evaluations) summary[item.state] = (summary[item.state] || 0) + 1;
  return summary;
}

// 모듈 상태: 연결된 링크 중 단절이 있으면 warn, 현재 모드에서 쓰는 링크가 하나도 없으면 idle, 그 외 ok.
export function moduleStatus(moduleId, evaluations) {
  const incident = evaluations.filter(item => item.link.from === moduleId || item.link.to === moduleId);
  if (incident.some(item => item.state === "down")) return "warn";
  if (!incident.some(item => item.state === "active")) return "idle";
  return "ok";
}

// 실제 배치는 서버 보고만 사용한다. 브라우저 링크 진단 설정은 이 함수의 입력이 아니다.
export function securityDeployment(report, error = null) {
  const placement = report?.placement === "remote" ? "외부" : report?.placement === "embedded" ? "내장 SIM" : "미확인";
  return {
    placement: error && report ? `${placement} (마지막 보고)` : placement,
    endpoint: report?.endpoint || (report?.placement === "embedded" ? "동일 프로세스 / in-process" : "미확인"),
    contract: report?.contract_version || "미확인",
    implementation: report?.implementation || "미확인",
    state: error || report?.reachable === false ? "warn" : report?.reachable === true ? "ok" : "idle",
    response: error ? `조회 오류: ${error}` : report?.reachable === true ? "응답 확인" : report?.reachable === false ? "응답 불가" : "미확인",
  };
}

export function defaultSettings() {
  return { mode: MODES[0].id, links: {} };
}

export function loadSettings(storage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw);
    const mode = MODES.some(item => item.id === parsed?.mode) ? parsed.mode : MODES[0].id;
    const links = parsed?.links && typeof parsed.links === "object" ? parsed.links : {};
    return { mode, links };
  } catch (_) {
    return defaultSettings();
  }
}

export function saveSettings(storage, settings) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch (_) {
    return false;
  }
}

// ---- geometry ----------------------------------------------------------------------------------

const OPPOSITE = { left: "right", right: "left", top: "bottom", bottom: "top" };
const round = value => Math.round(value * 10) / 10;

export function centerOf(module) {
  return { x: module.x + module.w / 2, y: module.y + module.h / 2 };
}

export function sideFor(a, b) {
  const ca = centerOf(a), cb = centerOf(b);
  const dx = cb.x - ca.x, dy = cb.y - ca.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

function pointOnSide(module, side, t) {
  switch (side) {
    case "left": return { x: module.x, y: module.y + module.h * t };
    case "right": return { x: module.x + module.w, y: module.y + module.h * t };
    case "top": return { x: module.x + module.w * t, y: module.y };
    default: return { x: module.x + module.w * t, y: module.y + module.h };
  }
}

function pushOut(point, side, distance) {
  switch (side) {
    case "left": return { x: point.x - distance, y: point.y };
    case "right": return { x: point.x + distance, y: point.y };
    case "top": return { x: point.x, y: point.y - distance };
    default: return { x: point.x, y: point.y + distance };
  }
}

export function bezierPath(p, sideP, q, sideQ) {
  const horizontal = sideP === "left" || sideP === "right";
  const span = horizontal ? Math.abs(q.x - p.x) : Math.abs(q.y - p.y);
  const distance = Math.max(30, span * 0.45);
  const c1 = pushOut(p, sideP, distance), c2 = pushOut(q, sideQ, distance);
  const mid = {
    x: round(0.125 * p.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * q.x),
    y: round(0.125 * p.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * q.y),
  };
  const d = `M ${round(p.x)} ${round(p.y)} C ${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(q.x)} ${round(q.y)}`;
  return { d, mid };
}

// 같은 모듈의 같은 변에 붙는 링크들은 상대 모듈 위치 순으로 고르게 나눠 붙인다.
export function layoutEdges(links = LINKS, modules = MODULES) {
  const byId = new Map(modules.map(module => [module.id, module]));
  const usage = new Map();
  const ends = links.map(link => {
    const a = byId.get(link.from), b = byId.get(link.to);
    if (!a || !b) throw new Error(`link ${link.id} references an unknown module`);
    const sideA = sideFor(a, b), sideB = OPPOSITE[sideA];
    const register = (module, side, end, other) => {
      const key = `${module.id}:${side}`;
      if (!usage.has(key)) usage.set(key, []);
      usage.get(key).push({ linkId: link.id, end, other: centerOf(other) });
    };
    register(a, sideA, "from", b);
    register(b, sideB, "to", a);
    return { link, a, b, sideA, sideB };
  });
  const points = new Map();
  for (const [key, list] of usage) {
    const [moduleId, side] = key.split(":");
    const module = byId.get(moduleId);
    const horizontal = side === "left" || side === "right";
    list.sort((p, q) => (horizontal ? p.other.y - q.other.y : p.other.x - q.other.x));
    list.forEach((item, index) => points.set(`${item.linkId}:${item.end}`, pointOnSide(module, side, (index + 1) / (list.length + 1))));
  }
  return ends.map(({ link, sideA, sideB }) => {
    const from = points.get(`${link.id}:from`), to = points.get(`${link.id}:to`);
    const { d, mid } = bezierPath(from, sideA, to, sideB);
    return { id: link.id, from, to, fromSide: sideA, toSide: sideB, d, mid };
  });
}
