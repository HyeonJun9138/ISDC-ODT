# 위성 3D 모델 자산

이 폴더의 GLB 모델과 JPG 썸네일은 궤도 탭의 선택 위성 표시에 쓰인다. 매핑 규칙과 대표 치수는 `manifest.json`에 있으며, NASA 모델 수집과 전체 검증은 `project_support/tools/fetch_nasa_models.py`, 자체 제작 모델 생성은 `project_support/tools/build_generic_models.py`가 수행한다.

## 출처

- **NASA 3D Resources**: [NASA 3D Resources](https://github.com/nasa/NASA-3D-Resources), 고정 commit `11ebb4ee043715aefbba6aeec8a61746fad67fa7`, 사용 지침 https://www.nasa.gov/nasa-brand-center/images-and-media/. NASA 자료는 일반적으로 저작권 대상이 아니며 출처를 NASA로 밝힌다. NASA 휘장과 로고는 별도 보호 대상이므로 이 앱은 모델 형상만 사용하고 NASA의 보증이나 승인을 뜻하지 않는다.
- **SpaceTwin 자체 제작**: 공개 3D 자료가 없는 Starlink, OneWeb, GNSS, 3U 큐브샛 등을 위해 build_generic_models.py로 생성한 단순 박스와 원통 조립 형상이다. 제조사 형상이 아니며 치수는 공개 자료를 어림한 근사값이다.

표시되는 형상은 실제 촬영 이미지가 아니며, 대표 형상으로 표시하는 경우 실제 기체 외형과 다를 수 있다. `size_m`은 전개 상태의 최대 치수를 공개 자료에서 어림한 근사값이며 정밀 제원이 아니다.

| key | 출처 | 모델 | 원본 경로 | 대표 치수 m | bytes | sha256 |
|---|---|---|---|---:|---:|---|
| `iss` | nasa | International Space Station (ISS) (B) | `3D Models/International Space Station (ISS) (B)/International Space Station (ISS) (B).glb` | 109 | 476,992 | `2ba4427413b0dd89…` |
| `hubble` | nasa | Hubble Space Telescope (A) | `3D Models/Hubble Space Telescope (A)/Hubble Space Telescope (A).glb` | 13.2 | 1,694,988 | `e5ba4de15c7d359a…` |
| `landsat_7` | nasa | Landsat 7 | `3D Models/Landsat 7/Landsat 7.glb` | 9 | 160,156 | `0ecb0a11a405d6f2…` |
| `landsat_8` | nasa | Landsat 8 | `3D Models/Landsat 8/Landsat 8.glb` | 11 | 780,280 | `8b599e867be20589…` |
| `terra` | nasa | Terra | `3D Models/Terra/Terra.glb` | 15 | 2,150,600 | `8794857595f7a7d4…` |
| `aqua` | nasa | Aqua (B) | `3D Models/Aqua (B)/Aqua (B).glb` | 16.7 | 1,104,016 | `f0761181a1d378b6…` |
| `aura` | nasa | Aura (A) | `3D Models/Aura (A)/Aura (A).glb` | 17 | 476,264 | `99d46cd9af551c75…` |
| `suomi_npp` | nasa | Suomi National Polar-orbiting Partnership (Suomi NPP) | `3D Models/Suomi National Polar-orbiting Partnership (Suomi NPP)/Suomi National Polar-orbiting Partnership (Suomi NPP).glb` | 9.5 | 2,283,576 | `885278277ed8fa86…` |
| `goes_r` | noaa_goesr | GOES-R Series (NASA VTAD) | `3D Models/GOES-R_1m.glb` | 8.5 | 6,409,168 | `26f2f289ec9fc786…` |
| `goes` | nasa | Geostationary Operational Environmental Satellites | `3D Models/Geostationary Operational Environmental Satellites/Geostationary Operational Environmental Satellites.glb` | 7 | 335,620 | `e2f690d3d59e101d…` |
| `tdrs` | nasa | Tracking and Data Relay Satellites (TRDS) (E) | `3D Models/Tracking and Data Relay Satellites (TRDS) (E)/Tracking and Data Relay Satellites (TRDS) (E).glb` | 17.3 | 216,892 | `4508756798d82772…` |
| `oco_2` | nasa | Orbiting Carbon Observatory (OCO) 2 | `3D Models/Orbiting Carbon Observatory (OCO) 2/Orbiting Carbon Observatory (OCO) 2.glb` | 4 | 280,060 | `5aba302aaf91fe1a…` |
| `sdo` | nasa | Solar Dynamics Observatory | `3D Models/Solar Dynamics Observatory/Solar Dynamics Observatory.glb` | 6.25 | 497,844 | `8ce4607bd65f098e…` |
| `swift` | nasa | Swift | `3D Models/Swift/Swift.glb` | 5.6 | 211,404 | `e7074fe159055074…` |
| `tess` | nasa | Transiting Exoplanet Survey Satellite (TESS) (A) | `3D Models/Transiting Exoplanet Survey Satellite (TESS) (A)/Transiting Exoplanet Survey Satellite (TESS) (A).glb` | 3.7 | 206,576 | `2b82a0191af6f060…` |
| `icesat_2` | nasa | Ice, Clouds, and Land Elevation Satellite-2 (ICESat-2) (A) | `3D Models/Ice, Clouds, and Land Elevation Satellite-2 (ICESat-2) (A)/Ice, Clouds, and Land Elevation Satellite-2 (ICESat-2) (A).glb` | 7 | 1,499,504 | `e7d260d69852fcd3…` |
| `grace` | nasa | Gravity Recovery and Climate Experiment (GRACE) (A) | `3D Models/Gravity Recovery and Climate Experiment (GRACE) (A)/Gravity Recovery and Climate Experiment (GRACE) (A).glb` | 3.1 | 22,620 | `b376141db89a708a…` |
| `jason` | nasa | Jason 1 | `3D Models/Jason 1/Jason 1.glb` | 9.5 | 592,740 | `22139020d17a118a…` |
| `sentinel_6` | nasa | Jason Continuity of Service (Sentinel-6) | `3D Models/Jason Continuity of Service (Sentinel-6)/Jason Continuity of Service (Sentinel-6).glb` | 5.13 | 2,108,496 | `cd257b8d63deef01…` |
| `chandra` | nasa | Chandra X-ray Observatory | `3D Models/Chandra X-ray Observatory/Chandra X-ray Observatory.glb` | 19.5 | 998,500 | `9383f44fc4c6eba7…` |
| `van_allen` | nasa | Van Allen Probes | `3D Models/Van Allen Probes/Van Allen Probes.glb` | 100 | 933,260 | `be9ed53e1452c615…` |
| `poes` | nasa | Polar Operational Environmental Satellite (POES) | `3D Models/Polar Operational Environmental Satellite (POES)/Polar Operational Environmental Satellite (POES).glb` | 8 | 1,158,944 | `30a8bfdb6585bb87…` |
| `eo_1` | nasa | Earth Observing-1 (EO-1) | `3D Models/Earth Observing-1 (EO-1)/Earth Observing-1 (EO-1).glb` | 7 | 224,580 | `2d26422a45147e86…` |
| `sac_c` | nasa | Satellite for Scientific Applications (SAC-C) | `3D Models/Satellite for Scientific Applications (SAC-C)/Satellite for Scientific Applications (SAC-C).glb` | 6 | 73,608 | `cf1e9ad3923ded6f…` |
| `radarsat_1` | nasa | Radar Satellite-1 (RADARSAT-1) | `3D Models/Radar Satellite-1 (RADARSAT-1)/Radar Satellite-1 (RADARSAT-1).glb` | 15 | 68,148 | `db609daaf38354f6…` |
| `cubesat_1u` | nasa | CubeSat - 1 RU Generic | `3D Models/CubeSat - 1 RU Generic/CubeSat - 1 RU Generic.glb` | 0.25 | 149,424 | `bae308ea2e33778c…` |
| `ssl_1300` | nasa | Space Systems Loral (SSL-1300) | `3D Models/Space Systems Loral (SSL-1300)/Space Systems Loral (SSL-1300).glb` | 26 | 510,324 | `63cd644d67ee49ab…` |
| `mms` | nasa | Magnetospheric Multiscale (MMS) (A) | `3D Models/Magnetospheric Multiscale (MMS) (A)/Magnetospheric Multiscale (MMS) (A).glb` | 3.5 | 335,808 | `e3688a8db82f1918…` |
| `cygnss` | nasa | Cyclone Global Navigation Satellite System (CYGNSS) | `3D Models/Cyclone Global Navigation Satellite System (CYGNSS)/Cyclone Global Navigation Satellite System (CYGNSS).glb` | 1.65 | 1,622,924 | `830321f2d30099b4…` |
| `gpm` | nasa | Global Precipitation Measurement | `3D Models/Global Precipitation Measurement/Global Precipitation Measurement.glb` | 13 | 2,257,008 | `7068c880770bb2ac…` |
| `hinode` | nasa | Hinode (Solar-B) | `3D Models/Hinode (Solar-B)/Hinode (Solar-B).glb` | 10 | 276,248 | `104f23212d379541…` |
| `calipso` | nasa | Cloud-Aerosol Lidar and Infrared Pathfinder Satellite (CALIPSO) | `3D Models/Cloud-Aerosol Lidar and Infrared Pathfinder Satellite (CALIPSO)/Cloud-Aerosol Lidar and Infrared Pathfinder Satellite (CALIPSO).glb` | 4.7 | 536,084 | `4abd7708d0f2629b…` |
| `cloudsat` | nasa | CloudSat (A) | `3D Models/CloudSat (A)/CloudSat (A).glb` | 4.6 | 267,656 | `293aab60f12decc0…` |
| `topex` | nasa | TOPEX-Poseidon | `3D Models/TOPEX-Poseidon/TOPEX-Poseidon.glb` | 11.5 | 214,264 | `e5ff3cae87bbdc59…` |
| `ibex` | nasa | Interstellar Boundary Explorer (IBEX) | `3D Models/Interstellar Boundary Explorer (IBEX)/Interstellar Boundary Explorer (IBEX).glb` | 1.0 | 1,306,616 | `6ce15c60467673f5…` |
| `fermi` | nasa | Fermi Gamma-ray Large Area Space Telescope | `3D Models/Fermi Gamma-ray Large Area Space Telescope/Fermi Gamma-ray Large Area Space Telescope.glb` | 15 | 1,379,016 | `d345f3b0595f7792…` |
| `aquarius` | nasa | Aquarius (A) | `3D Models/Aquarius (A)/Aquarius (A).glb` | 7 | 1,137,428 | `dc81055c83e5da56…` |
| `geotail` | nasa | GeoTailSAT | `3D Models/GeoTailSAT/GeoTailSAT.glb` | 100 | 91,504 | `3b39a3fc15773142…` |
| `themis` | nasa | Time History of Events and Macroscale Interactions During Substorms (THEMIS) | `3D Models/Time History of Events and Macroscale Interactions During Substorms (THEMIS)/Time History of Events and Macroscale Interactions During Substorms (THEMIS).glb` | 2.5 | 682,092 | `2dfe2a2e07de211f…` |
| `sorce` | nasa | Solar Radiation and Climate Experiment (SORCE) | `3D Models/Solar Radiation and Climate Experiment (SORCE)/Solar Radiation and Climate Experiment (SORCE).glb` | 3.4 | 366,492 | `8ec505080199227d…` |
| `toms` | nasa | Total Ozone Mapping Spectrometer (TOMS) | `3D Models/Total Ozone Mapping Spectrometer (TOMS)/Total Ozone Mapping Spectrometer (TOMS).glb` | 1.6 | 98,620 | `36578255a6584907…` |
| `polar` | nasa | Polar | `3D Models/Polar/Polar.glb` | 6 | 98,592 | `0ffe9e41f6686db7…` |
| `swas` | nasa | Submillimeter Wave Astronomy Satellite (SWAS) | `3D Models/Submillimeter Wave Astronomy Satellite (SWAS)/Submillimeter Wave Astronomy Satellite (SWAS).glb` | 1.6 | 150,296 | `c1d58e66cb2f1185…` |
| `fuse` | nasa | Far Ultraviolet Spectroscopic Explorer | `3D Models/Far Ultraviolet Spectroscopic Explorer/Far Ultraviolet Spectroscopic Explorer.glb` | 5.6 | 236,704 | `056c26e4f48bc362…` |
| `wire` | nasa | Wide-Field Infrared Explorer (WIRE) | `3D Models/Wide-Field Infrared Explorer (WIRE)/Wide-Field Infrared Explorer (WIRE).glb` | 1.8 | 375,404 | `adffb87ebd6d884f…` |
| `hete_2` | nasa | High Energy Transient Explorer | `3D Models/High Energy Transient Explorer/High Energy Transient Explorer.glb` | 1.0 | 61,836 | `f514f7cff65c0d4d…` |
| `starlink_flat` | spacetwin | Starlink형 평판 위성 (자체 제작) | 생성 | 29 | 14,096 | `1f2bd994bca491b8…` |
| `gnss_bus` | spacetwin | GNSS 항법위성 버스 (자체 제작) | 생성 | 14 | 43,068 | `caa606c93deae360…` |
| `oneweb` | spacetwin | OneWeb형 소형 통신위성 (자체 제작) | 생성 | 6.3 | 15,896 | `aba350d67d392924…` |
| `kuiper` | spacetwin | Kuiper형 통신위성 (자체 제작) | 생성 | 12 | 15,896 | `aba350d67d392924…` |
| `iridium` | spacetwin | Iridium NEXT형 통신위성 (자체 제작) | 생성 | 9.4 | 15,896 | `aba350d67d392924…` |
| `globalstar` | spacetwin | Globalstar형 통신위성 (자체 제작) | 생성 | 10 | 15,896 | `aba350d67d392924…` |
| `orbcomm` | spacetwin | Orbcomm형 통신위성 (자체 제작) | 생성 | 6 | 15,896 | `aba350d67d392924…` |
| `o3b` | spacetwin | O3b형 MEO 통신위성 (자체 제작) | 생성 | 12 | 15,896 | `aba350d67d392924…` |
| `china_leo_comms` | spacetwin | 중국 저궤도 통신망 위성 (자체 제작) | 생성 | 12 | 15,896 | `aba350d67d392924…` |
| `cubesat_3u` | spacetwin | 3U 큐브샛 (자체 제작) | 생성 | 0.7 | 10,608 | `8657ecec5c182900…` |

## 매핑 의미

- `exact`: NORAD 번호 또는 이름이 해당 기체와 일치한다. UI는 해당 기체의 모델로 표시한다.
- `series`: 같은 계열 또는 같은 버스의 기체다. UI는 동일 계열 모델로 표시한다.
- `family`: 이름 규칙으로 식별한 위성군이다. UI는 대표 형상으로 표시한다.
- `representatives`: 궤도 구분 및 객체 유형별 대표 형상이다. UI는 대표 형상임을 명시한다.
- 로켓 본체와 파편은 모델을 배정하지 않는다.
