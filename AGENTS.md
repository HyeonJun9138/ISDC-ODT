# SpaceTwin 공동 작업 규칙

작업 전 README.md, project_support/docs/DEVELOPMENT.md, project_support/docs/architecture/design.md와 변경 영역의 시험을 읽는다.

1. 현재 구현만 다룬다. 빈 계층, 추상 manager, 내부 event bus와 AI placeholder를 만들지 않는다.
2. 루트 main.py는 실행 진입점이다. 조립은 user_application에서 한다. import 시 서버, 네트워크 또는 시계를 시작하지 않는다.
3. 하위 계층에서 user_application을 import하지 않는다. runtime은 communication이나 data의 구체 구현에 의존하지 않는다. 외부 객체는 조립 지점에서 전달한다.
4. 현재 상태는 runtime이 소유한다. UI, 계산, export에 전달하는 값은 사본이며 외부에서 내부 상태를 수정하지 않는다.
5. 폴더와 Python 파일은 lower_snake_case. 클래스는 PascalCase. layer/module 접미사와 core/common/utils/manager/backend 같은 모호한 새 이름은 사용하지 않는다.
6. 모델 정의와 운용 설정, 실행 데이터는 별개다. 모델은 digital_twin/model_library, 운용 구성은 user_application/configs, 생성물은 data/workspace에 둔다.
7. 기존 API와 계산식 변경은 구조 변경과 분리한다. 변경 이유와 영향 및 시험을 문서에 기록한다.
8. 코드 변경에 앞서 관련 회귀시험을 추가하고 실패 원인을 확인한다. 완료 전 `python -m pytest -q`를 실행한다. 검증하지 않은 동작을 성공이라고 쓰지 않는다.
9. 문서, 저장소 시험, 도구, 참조 자료는 project_support 아래에 둔다. reference와 backup에서 실행 코드를 import하지 않는다.
10. GP/SGP4, SIM, MOCK-HIL을 실측이나 실제 HIL로 표현하지 않는다. 규칙 기반 재계획을 AI로 부르지 않는다.
11. 논문 및 기술 설명은 자연스러운 서술형 한국어를 사용한다. 단어 사이 중간점으로 내용을 나열하지 않는다. 필요한 부분만 코딩한다.
