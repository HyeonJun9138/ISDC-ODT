# 운용 SW 임시 구현

이 폴더는 타 기관이 개발하는 운용 SW를 디지털 트윈 개발과 검증에 쓰기 위해 임시로 구현한 것이다. 디지털 트윈 코드를 import하지 않으며, 디지털 트윈도 이 폴더를 직접 import하지 않는다. 두 쪽은 `communication/http`가 제공하는 ICD 메시지로만 이어지므로 실제 모듈이 오면 조립 지점(`user_application`)에서 교체하면 된다. 계층 검사(`project_support/tests/test_architecture.py`)가 이 경계를 강제한다.

## data_fabric — 데이터 송수신 기술 (ICD-02)

패브릭 SW의 세 기능을 작은 결정론적 모델로 대신한다.

| 파일 | 역할 |
|---|---|
| `link_metrics.py` | 링크별 사용 가능 여부, 편도 지연, 용량, 품질(0~100), Eb/N0 여유, BER. 지상 RF 링크는 Friis 예산, OISL은 트윈이 보고한 기하 여유를 쓴다. |
| `routing.py` | 사용 가능한 링크로 만든 무방향 그래프에서 목적(최저 지연, 최대 신뢰도, 균형)별 최단 경로와, 모든 지상국에서 출발하는 다중 시작점 Dijkstra로 위성별 지상 경로를 구한다. |
| `bundles.py` | 위성별 저장 전달(DTN) 백로그. 지상 경로가 있으면 병목 용량으로 내려보내고, 없으면 저장 용량까지 보관한다. |
| `stand_in.py` | 위 셋을 묶어 ICD-02 메시지에 답하는 `DataFabricStandIn`. 마지막 네트워크 상태와 백로그만 기억한다. |

### 메시지

`update(snapshot)` — 네트워크 상태 갱신 (디지털 트윈 → 패브릭). 트윈이 계산한 노드와 링크의 기하와 단말 상태를 받는다.

```json
{
  "time": "2026-09-07T13:00:00Z",
  "nodes": [
    {"id": "NODE-0001", "name": "ODT-A1", "kind": "satellite", "mode": "nominal", "generation_mbps": 0.2, "storage_gb": 64, "extra_delay_ms": 0},
    {"id": "GS-SEOUL", "name": "서울", "kind": "ground"}
  ],
  "links": [
    {"id": "NODE-0001|NODE-0002", "a": "NODE-0001", "b": "NODE-0002", "kind": "oisl", "state": "locked", "range_km": 2100.4, "data_rate_mbps": 10000, "margin_db": 7.5, "faulted": false},
    {"id": "GS-SEOUL|NODE-0001", "a": "GS-SEOUL", "b": "NODE-0001", "kind": "ground", "band": "X", "elevation_deg": 35.2, "min_elevation_deg": 5, "range_km": 900.1, "data_rate_mbps": 800, "eirp_dbw": 32.8, "gt_dbk": 30.7, "frequency_ghz": 8.2, "faulted": false},
    {"id": "GS-JEJU|GS-SEOUL", "a": "GS-JEJU", "b": "GS-SEOUL", "kind": "terrestrial", "distance_km": 452, "data_rate_mbps": 10000}
  ]
}
```

응답 (패브릭 → 디지털 트윈): `links[]`에 `usable`, `reason`, `delay_ms`, `capacity_mbps`, `quality`, `margin_db`, `ber`; `nodes[]`에 위성별 `ground_path`, `next_hop`, `ground_delay_ms`, `ground_bottleneck_mbps`, `stored_mb`, `custody`(`passing`, `forwarding`, `storing`, `full`, `idle`)와 지상국별 `serving`; `summary`에 사용 가능 링크 수, 지상 경로를 가진 위성 수, 평균 지상 지연, 보관·전달·폐기 데이터량.

`route(source, target, objective)` — 마지막 네트워크 상태에서 두 노드 사이의 경로. `status()` — 구현, 버전, 순번, 마지막 갱신 시각.

### 가정과 한계

- 지연은 거리 / 광속(지상망은 0.67c)에 처리 지연(OISL 1.5 ms, 지상 4 ms, 지상망 3 ms)을 더한 편도 값이다.
- RF 여유는 EIRP + G/T − 자유공간 손실 − 구현 손실 6 dB − 대기 손실(천정값 / sin 고각) + 228.6 − 10 log10(전송률) − 9.6 dB(QPSK, BER 1e-5)다. 강우 감쇠, 편파, 간섭은 없다.
- 품질은 여유 −10 dB에서 0 %, 0 dB에서 50 %, +10 dB에서 100 %다. 용량은 3 dB 이상 여유에서 정격, 0 dB에서 절반, 음수에서 0이다.
- OISL 링크는 트윈이 `locked`(양방향 추적)로 보고한 것만 사용 가능으로 본다. 포착 중, 단방향, 차단은 라우팅에 쓰지 않는다.
- 저장 전달 모델은 백로그 총량만 다루며 개별 번들, 수명, 우선순위는 없다. 분석 시각이 과거로 돌아가면 백로그를 비운다.
- 값은 대표 공학값이며 실측이나 검증된 링크 예산이 아니다.

## data_management — 데이터 관리 (ICD-01)

우주 데이터 센터의 데이터 수명주기 관리자다. 위성과 지상의 저장 노드 위에서 데이터 객체의 배치, 복제, 정합성, 서비스를 결정하고 보고한다. 비트의 이동 경로를 다루는 데이터 패브릭(ICD-02)과 책임이 겹치지 않는다.

| 파일 | 역할 |
|---|---|
| `policy.py` | 데이터 종류별 복제 계수, 보존 기간, 계층 유지 시간과 기본 정책, 노드 종류별 서비스 지연 |
| `catalog.py` | 데이터 객체와 복제본 상태, 수집 필터, 상태 판정(정상·대기·복제 부족·위험·만료), 계층과 보존 |
| `placement.py` | 복제본 배치(원본 노드 우선, 이후 코어 → 엣지 → 탑재), 서비스 복제본 선택과 지연 |
| `stand_in.py` | 위 셋을 묶어 ICD-01 메시지에 답하는 `DataManagementStandIn`. 카탈로그, 작업, 이벤트만 기억한다 |

### 메시지

`update_nodes(DM-04)` 저장 노드 명세와 가용 여부, `ingest(DM-01)` 생성된 데이터 제품 등록, `request(DM-02)` 서비스 요청, `action(DM-03)` 운영 조치(무결성 검사·자가복구·재균형·복제 계수·필터·만료 정리), `overview(DM-05)` 안정성과 파이프라인, `objects(DM-06)` 카탈로그, `nodes(DM-07)` 노드 상태, `events(DM-08)` 이벤트, `status(DM-09)` 모듈 상태.

```json
{
  "time": "2026-09-07T14:00:00Z",
  "sim_elapsed_s": 420.5,
  "products": [
    {"ref": "SAT-01:imagery:5", "class": "imagery", "source": "SAT-01", "size_mb": 812.4, "priority": 2, "created_s": 450}
  ]
}
```

시간 기준은 트윈 시뮬레이션 경과 초(`sim_elapsed_s`)이며 과거로 돌아가면 모델을 다시 시작한다. 가정과 한계는 [데이터 관리 문서](../project_support/docs/development/data_management.md)에 있다.

## orchestration — 군집 운용 (ICD-03)

임무 요청을 위성별 작업으로 배정하는 군집 운용 SW의 임시 구현이다. 디지털 트윈이 계산한 창과 위성 상태를 받아 결정론적 탐욕 규칙으로 작업을 배정하고 검사 결과를 돌려준다. 데이터가 어느 링크로 흐르는지(데이터 패브릭, ICD-02)나 데이터 객체가 어디에 있는지(데이터 관리, ICD-01)는 다루지 않는다.

| 파일 | 역할 |
|---|---|
| `scheduler.py` | 종류별 배정(관측 인도, 궤도상 연산, 중계 전송, 외부 위성 데이터 수신, 군집 소프트웨어 갱신), OISL 격자 중계, 기한·저장·배터리·지연 검사 |
| `stand_in.py` | ICD-03 메시지에 답하는 `OrchestrationStandIn`(0.2). 순번, 마지막 판정, 확정된 작업만 기억한다 |

### 메시지

`plan(request)` — 임무 편성 요청 (디지털 트윈 → 군집 운용).

```json
{
  "time": "2026-09-08T00:00:00Z",
  "mission": {"id": "MSN-0001", "kind": "observe", "priority": 3, "window_start": "2026-09-08T00:00:00Z", "deadline": "2026-09-08T06:00:00Z",
              "params": {"target_name": "독도", "latitude": 37.24, "longitude": 131.86, "max_off_nadir_deg": 30, "product_mb": 800, "processing": true, "processing_ratio": 0.4}},
  "satellites": [{"id": "NODE-0001", "name": "ODT-A1", "mode": "nominal", "capabilities": {"camera": true, "compute_mbps": 300, "storage_free_mb": 2000000, "oisl": true, "rf_bands": ["X", "S"]},
                  "power": {"generation_w": 900, "bus_w": 150, "battery_wh": 3000}, "busy": [{"start": "…", "end": "…", "task_id": "MSN-0000-T03", "mission_id": "MSN-0000"}]}],
  "stations": [{"id": "GS-DAEJEON", "name": "대전", "bands": ["S", "X", "Ka"]}],
  "windows": {
    "contacts": [{"id": "GS-DAEJEON|NODE-0001|…", "satellite": "NODE-0001", "station": "GS-DAEJEON", "band": "X", "rate_mbps": 800, "uplink_mbps": 20, "start": "…", "end": "…", "peak": "…", "max_elevation": 61.2}],
    "target_access": [{"id": "access|NODE-0001|…", "satellite": "NODE-0001", "start": "…", "end": "…", "peak": "…", "max_elevation": 74.0}],
    "crosslinks": [{"id": "crosslink|NODE-0001|25544|…", "satellite": "NODE-0001", "external": "25544", "start": "…", "end": "…", "min_range_km": 880}],
    "eclipses": [{"satellite": "NODE-0001", "start": "…", "end": "…"}]
  },
  "mesh": {"NODE-0001": ["NODE-0002", "NODE-0010"]},
  "exclude": []
}
```

역할 배정 결과 (군집 운용 → 디지털 트윈): `feasible`, `tasks[]`(`kind`, `satellite`, `counterpart`, `start`, `end`, `duration_s`, `volume_mb`, `rate_mbps`, `window`, `depends_on`, `power_w`), `summary`(`finish_at`, `deadline`, `margin_s`, `path`, `satellites`, `task_count`, `volume_mb`, `hops`와 종류별 값), `checks[]`(`deadline`, `storage`, `energy`, 중계는 `latency`), `reasons[]`, `alternatives`, `unavailable[]`.

요청의 `horizon`에는 계획 창 외에 `faulted_links`(런타임 장애로 쓸 수 없는 OISL 쌍), `faulted_stations`, `locked_links`가 들어가며 격자(`mesh`)에서 장애 쌍은 이미 빠져 있다. 장애가 생기면 트윈이 같은 임무를 다시 편성 요청하고 모듈은 남은 격자로 우회 경로를 배정한다.

`commit(notice)` — 실행 확정·중단 통보 (디지털 트윈 → 군집 운용, OR-03). `mission_id`, `decision`(`commit` 또는 `abort`), `version`, 확정하는 `tasks[]`를 받아 검사(시각 형식, 끝 ≥ 시작)한 뒤 `accepted`, `held_tasks`(모듈이 점유로 기억하는 작업 수), `sequence`를 답한다. 중단은 그 임무의 점유를 푼다. 서버 끝점은 `/api/orchestration/commit`이다. `status()` — 구현, 버전, 순번, 임무별 마지막 판정, 확정된 임무.

### 배정 규칙과 한계

- 관측 인도는 촬영 장비가 켜진 위성의 앞 여섯 관측 통과마다 최대 고각 시각을 중심으로 45초 촬영, `크기 × 8 / 처리 속도` 동안 처리, 그 뒤 가장 빠른 지상 전송을 고른다. 궤도상 연산과 외부 위성 수신도 같은 전달 규칙을 쓴다.
- 지상 전송은 그 위성의 다음 접속창이거나 현재 OISL 격자에서 여섯 홉 안의 위성이 가진 더 이른 접속창이다. 위성 간 전달은 접속창 직전에 두어 데이터가 원래 위성에 머물게 하고, 그 시간이 점유되어 있으면 앞으로 당겨 전달받는 위성이 보관한다. 격자는 계획 시점의 양방향 유지 쌍이며 계획 창 동안 유지된다고 가정한다.
- 중계 전송은 위성→지상국, 지상국→위성(상향 후 격자 전달), 위성→위성(격자 경로)을 다루고 홉당 8 ms로 종단 지연을 어림한다. 지상국 사이 전송은 군집 작업이 아니므로 거절한다.
- 군집 갱신은 위성마다 가장 이른 상향 접속창에 이미지를 올린 뒤 적용 시간 동안 적용하며 동시 적용 수를 넘지 않게 미룬다.
- 검사는 기한 여유, 탑재 저장 여유(동시에 든 데이터량), 배터리 여유(식 구간 소비와 발전 초과 소비의 시간 적분이 용량의 60 % 이내), 지연 한계다. 작업별 소비 전력은 촬영 150, 처리 60, 보관 30, 위성 간 전달 120, 지상 전송 90, 상향 40, 적용 40, 외부 수신 60 W다.
- 확정된 다른 임무의 작업은 5초 간격을 두고 피한다. 안전·대기 모드 위성과 제외 지정 위성은 배정하지 않는다. 같은 요청은 같은 계획을 낸다(완료 시각, 홉 수, 위성 번호 순).
- 자세 기동 시간, 촬영 각도 제약 이외의 탑재체 제약, 열, 통신 간섭, 우선순위 간 선점은 없다. 값은 대표 공학값이다.

## 실행 방식

기본은 내장 실행이다. `create_app()`이 `DataFabricStandIn`을 만들어 `/api/data-fabric/*`에 연결한다. 별도 프로세스의 패브릭 모듈을 쓰려면 같은 ICD를 제공하는 주소를 지정한다.

```powershell
python main.py --data-fabric-url http://127.0.0.1:8792
```

군집 운용 모듈도 같은 규칙이다. `python main.py --orchestration-url http://127.0.0.1:5103`으로 외부 모듈 주소를 지정하면 `communication/external/orchestration.py`가 요청을 전달한다.

이 경우 `communication/external/data_fabric.py`가 요청을 그 주소로 전달하고, 응답이 없으면 503으로 보고한다. 이 저장소에서는 두 번째 SpaceTwin 인스턴스(`--port 8792`)가 같은 ICD를 제공하므로 외부 연결 경로를 실제로 시험할 수 있다.
