"""Build the PoC walkthrough deck (16:9, editable) from the headless captures in
project_support/output/poc_deck/captures. Every text is a text box, every box a shape, every
capture a picture. Coordinates are pixels of a 1920x1080 canvas (144 px/in)."""
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Pt

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "project_support" / "output" / "poc_deck"
CAP = OUT_DIR / "captures"
ICONS = ROOT / "project_support" / "output" / "poc_slide" / "icons"
FONT = "맑은 고딕"

NAVY = RGBColor(0x0B, 0x1F, 0x5C)
NAVY2 = RGBColor(0x16, 0x3A, 0x8A)
PURPLE = RGBColor(0x5B, 0x3F, 0xA0)
TEAL = RGBColor(0x1D, 0x6B, 0x6B)
INK = RGBColor(0x1C, 0x1F, 0x2A)
MUTED = RGBColor(0x5C, 0x62, 0x70)
LINE = RGBColor(0xD9, 0xDD, 0xE8)
BOX = RGBColor(0xF7, 0xF8, 0xFC)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
YELLOW = RGBColor(0xFF, 0xE2, 0x7A)
GREEN = RGBColor(0x2E, 0xA5, 0x6A)
RED = RGBColor(0xC8, 0x40, 0x2F)
ORANGE = RGBColor(0xE0, 0x8A, 0x2E)
FRAME = RGBColor(0x1A, 0x1D, 0x24)
DARK_BG = RGBColor(0x0A, 0x14, 0x2E)

SECTION_COLORS = {1: NAVY2, 2: PURPLE, 3: TEAL, 4: ORANGE}
SECTION_NAMES = {1: "1. 디지털 트윈 기능", 2: "2. 연결된 운용 SW", 3: "3. 검증 시나리오 수행", 4: "4. 기대 효과"}


def px(value):
    return Emu(int(round(value * 914400 / 144)))


def pt(px_value):
    return Pt(px_value / 2)


prs = Presentation()
prs.slide_width = px(1920)
prs.slide_height = px(1080)
BLANK = prs.slide_layouts[6]
slide_no = 0


def set_font(run, size_px, bold=False, color=INK):
    font = run.font
    font.name = FONT
    font.size = pt(size_px)
    font.bold = bold
    font.color.rgb = color
    rpr = run._r.get_or_add_rPr()
    for tag in ("a:ea", "a:cs"):
        el = rpr.find(qn(tag))
        if el is None:
            el = rpr.makeelement(qn(tag), {})
            rpr.append(el)
        el.set("typeface", FONT)


def text_box(slide, x, y, w, h, paragraphs, anchor=MSO_ANCHOR.TOP, name=None):
    tb = slide.shapes.add_textbox(px(x), px(y), px(w), px(h))
    if name:
        tb.name = name
    tf = tb.text_frame
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.NONE
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    first = True
    for runs, options in paragraphs:
        p = tf.paragraphs[0] if first else tf.add_paragraph()
        first = False
        p.alignment = options.get("align", PP_ALIGN.LEFT)
        if "space_after" in options:
            p.space_after = pt(options["space_after"])
        if "space_before" in options:
            p.space_before = pt(options["space_before"])
        if "line_spacing" in options:
            p.line_spacing = options["line_spacing"]
        for text, size, bold, color in runs:
            r = p.add_run()
            r.text = text
            set_font(r, size, bold, color)
    return tb


def para(text, size, bold=False, color=INK, **options):
    return ([(text, size, bold, color)], options)


def shape(slide, kind, x, y, w, h, fill=WHITE, line=None, line_px=2, radius=None, name=None):
    s = slide.shapes.add_shape(kind, px(x), px(y), px(w), px(h))
    if name:
        s.name = name
    if radius is not None and kind == MSO_SHAPE.ROUNDED_RECTANGLE:
        s.adjustments[0] = min(0.5, radius / max(1, min(w, h)))
    if fill is None:
        s.fill.background()
    else:
        s.fill.solid()
        s.fill.fore_color.rgb = fill
    if line is None:
        s.line.fill.background()
    else:
        s.line.color.rgb = line
        s.line.width = pt(line_px)
    s.shadow.inherit = False
    s.text_frame.text = ""
    return s


def rect(slide, x, y, w, h, fill=WHITE, line=None, line_px=2, name=None):
    return shape(slide, MSO_SHAPE.RECTANGLE, x, y, w, h, fill, line, line_px, name=name)


def rounded(slide, x, y, w, h, fill=WHITE, line=LINE, line_px=2, radius=14, name=None):
    return shape(slide, MSO_SHAPE.ROUNDED_RECTANGLE, x, y, w, h, fill, line, line_px, radius, name)


def circle(slide, x, y, d, fill, name=None):
    return shape(slide, MSO_SHAPE.OVAL, x, y, d, d, fill, None, name=name)


def picture(slide, path, x, y, w, h, name=None):
    path = Path(path)
    if not path.exists():
        rect(slide, x, y, w, h, RGBColor(0x2A, 0x2F, 0x3A), None, name=f"missing {path.name}")
        text_box(slide, x, y, w, h, [para(f"캡처 없음: {path.name}", 16, True, WHITE, align=PP_ALIGN.CENTER)], anchor=MSO_ANCHOR.MIDDLE)
        return None
    pic = slide.shapes.add_picture(str(path), px(x), px(y), px(w), px(h))
    if name:
        pic.name = name
    return pic


def framed_capture(slide, path, x, y, w, name=None):
    """A 16:9 capture with a dark frame; returns the bottom y."""
    h = round(w * 9 / 16)
    rect(slide, x - 3, y - 3, w + 6, h + 6, FRAME, None, name=f"frame {name or ''}".strip())
    picture(slide, path, x, y, w, h, name=name)
    return y + h


def chrome(slide, section, title, subtitle=None):
    """Section chip, title, subtitle and footer of a content slide."""
    global slide_no
    slide_no += 1
    color = SECTION_COLORS.get(section, NAVY)
    rounded(slide, 48, 34, 250, 32, color, None, 0, 16, name="section chip")
    text_box(slide, 48, 34, 250, 32, [para(SECTION_NAMES.get(section, ""), 14, True, WHITE, align=PP_ALIGN.CENTER)], anchor=MSO_ANCHOR.MIDDLE, name="section chip text")
    text_box(slide, 48, 72, 1500, 52, [para(title, 36, True, NAVY)], anchor=MSO_ANCHOR.MIDDLE, name="title")
    if subtitle:
        text_box(slide, 48, 124, 1700, 28, [para(subtitle, 17, False, MUTED)], anchor=MSO_ANCHOR.MIDDLE, name="subtitle")
    rect(slide, 48, 1024, 1824, 1, LINE, None, name="footer line")
    text_box(slide, 48, 1032, 900, 24, [para("ISDC ODT PoC · 시나리오 수행 흐름 · 건국대학교", 12, False, MUTED)], anchor=MSO_ANCHOR.MIDDLE, name="footer")
    text_box(slide, 1772, 1032, 100, 24, [para(str(slide_no), 12, True, MUTED, align=PP_ALIGN.RIGHT)], anchor=MSO_ANCHOR.MIDDLE, name="page number")


def bullets_panel(slide, x, y, w, h, heading, items, flow=None, section=1):
    """Right-hand explanation panel: heading, bullet list, optional flow strip."""
    color = SECTION_COLORS.get(section, NAVY)
    rounded(slide, x, y, w, h, BOX, LINE, 1.5, 14, name="panel")
    text_box(slide, x + 22, y + 18, w - 44, 30, [para(heading, 19, True, NAVY)], anchor=MSO_ANCHOR.MIDDLE, name="panel heading")
    rect(slide, x + 22, y + 54, w - 44, 1.5, LINE, None)
    cy = y + 68
    for title, desc in items:
        circle(slide, x + 22, cy + 7, 12, color)
        paragraphs = [para(title, 16, True, INK, space_after=2)]
        if desc:
            paragraphs.append(para(desc, 13.5, False, MUTED))
        text_box(slide, x + 44, cy, w - 66, 66, paragraphs, name=f"bullet {title}")
        cy += 78 if desc else 40
    if flow:
        fy = y + h - 96
        rounded(slide, x + 22, fy, w - 44, 78, WHITE, LINE, 1, 10, name="flow strip")
        text_box(slide, x + 36, fy + 8, w - 72, 20, [para("흐름", 12, True, color)], name="flow label")
        text_box(slide, x + 36, fy + 30, w - 72, 44, [para(flow, 13.5, True, INK)], anchor=MSO_ANCHOR.MIDDLE, name="flow text")


def capture_slide(section, title, subtitle, capture, heading, items, flow=None):
    slide = prs.slides.add_slide(BLANK)
    chrome(slide, section, title, subtitle)
    framed_capture(slide, CAP / capture, 48, 172, 1210, name=capture)
    bullets_panel(slide, 1300, 169, 572, 690, heading, items, flow, section)
    return slide


def grid_slide(section, title, subtitle, cells, note=None):
    """cells: list of (capture, caption, description) for a 2x2 grid."""
    slide = prs.slides.add_slide(BLANK)
    chrome(slide, section, title, subtitle)
    w, gap = 880, 40
    h = round(w * 9 / 16)
    for index, (capture, caption, desc) in enumerate(cells):
        cx = 48 + (index % 2) * (w + gap + 24)
        cy = 172 + (index // 2) * (h + 74)
        rect(slide, cx - 3, cy - 3, w + 6, h + 6, FRAME, None)
        picture(slide, CAP / capture, cx, cy, w, h, name=capture)
        text_box(slide, cx, cy + h + 8, w, 24, [([(caption, 16, True, INK), ("  " + desc, 13.5, False, MUTED)], {})], anchor=MSO_ANCHOR.MIDDLE, name=f"caption {caption}")
    if note:
        text_box(slide, 48, 1000, 1824, 22, [para(note, 13, False, MUTED)], anchor=MSO_ANCHOR.MIDDLE, name="note")
    return slide


def divider_slide(section, title, lines):
    global slide_no
    slide_no += 1
    slide = prs.slides.add_slide(BLANK)
    rect(slide, 0, 0, 1920, 1080, DARK_BG, None, name="background")
    rect(slide, 96, 300, 12, 220, SECTION_COLORS.get(section, NAVY2), None, name="accent")
    text_box(slide, 140, 290, 1500, 60, [para(f"SECTION {section}", 24, True, YELLOW)], anchor=MSO_ANCHOR.MIDDLE)
    text_box(slide, 140, 350, 1600, 90, [para(title, 60, True, WHITE)], anchor=MSO_ANCHOR.MIDDLE, name="title")
    text_box(slide, 140, 460, 1600, 120, [para(line, 22, False, RGBColor(0xC9, 0xD2, 0xE8), space_after=4) for line in lines], name="lines")
    text_box(slide, 1772, 1032, 100, 24, [para(str(slide_no), 12, True, RGBColor(0x8A, 0x96, 0xB4), align=PP_ALIGN.RIGHT)], anchor=MSO_ANCHOR.MIDDLE)
    return slide


# ---------------------------------------------------------------- cover
slide_no += 1
cover = prs.slides.add_slide(BLANK)
rect(cover, 0, 0, 1920, 1080, DARK_BG, None, name="background")
rect(cover, 0, 0, 1920, 8, YELLOW, None)
text_box(cover, 120, 250, 1400, 40, [para("PoC 추진 현황 및 주요 결과", 24, True, YELLOW)], anchor=MSO_ANCHOR.MIDDLE, name="kicker")
text_box(cover, 120, 300, 1600, 160, [para("ISDC ODT PoC 시나리오 수행 흐름", 64, True, WHITE)], anchor=MSO_ANCHOR.MIDDLE, name="title")
text_box(cover, 120, 470, 1600, 60, [para("디지털 트윈 기능 · 연결된 운용 SW · 검증 시나리오 수행 · 기대 효과", 26, False, RGBColor(0xC9, 0xD2, 0xE8))], anchor=MSO_ANCHOR.MIDDLE, name="subtitle")
picture(cover, CAP / "s3_11_step4_comm_detour.png", 1040, 560, 760, 428, name="cover capture")
rect(cover, 1037, 557, 766, 434, None, RGBColor(0x3A, 0x4A, 0x74), 1.5)
text_box(cover, 120, 940, 900, 40, [para("건국대학교 · ISDC ODT v0.2 · 2026-09-08", 18, False, RGBColor(0x8A, 0x96, 0xB4))], anchor=MSO_ANCHOR.MIDDLE, name="credit")

# ---------------------------------------------------------------- agenda
agenda = prs.slides.add_slide(BLANK)
chrome(agenda, 0, "이 자료의 구성", "실제 화면 캡처를 따라가며 시나리오가 어떻게 수행되는지 설명합니다")
agenda_items = [
    (1, "디지털 트윈 기능", "위성·링크·임무·데이터·보안 상태를 한 화면에서 보고 조작한다", "대시보드 · 노드 배치 · 통신망 · 임무 · 데이터 · 보안 · 상태"),
    (2, "연결된 운용 SW", "데이터 관리, 데이터 송수신, 군집 운용, 보안 SW 4종을 표준 인터페이스로 잇는다", "모듈 연결 토폴로지 · ICD 관리표 · SW별 판정 화면"),
    (3, "검증 시나리오 수행", "링크 장애 → 상태 전달 → 우회 재전송 → 복구 판정을 단계별 화면으로 확인한다", "시나리오 선택·세팅 · 5단계 재생 · 판정 결과"),
    (4, "기대 효과", "없는 체계의 사전 시험, EM·HW 연동 검증, 운용 SW 검증, 운용 기준 확보", "다음 단계 계획"),
]
for index, (num, title, desc, tags) in enumerate(agenda_items):
    y = 190 + index * 200
    rounded(agenda, 48, y, 1824, 170, BOX, LINE, 1.5, 16, name=f"agenda {num}")
    circle(agenda, 80, y + 45, 80, SECTION_COLORS[num])
    text_box(agenda, 80, y + 45, 80, 80, [para(str(num), 34, True, WHITE, align=PP_ALIGN.CENTER)], anchor=MSO_ANCHOR.MIDDLE)
    text_box(agenda, 200, y + 30, 1600, 44, [para(title, 28, True, NAVY)], anchor=MSO_ANCHOR.MIDDLE)
    text_box(agenda, 200, y + 76, 1600, 34, [para(desc, 18, False, INK)], anchor=MSO_ANCHOR.MIDDLE)
    text_box(agenda, 200, y + 112, 1600, 30, [para(tags, 15, True, SECTION_COLORS[num])], anchor=MSO_ANCHOR.MIDDLE)

# ---------------------------------------------------------------- section 1
divider_slide(1, "디지털 트윈 기능", ["위성 40기의 궤도·광 링크·지상국 접속·임무 일정·데이터·보안 상태를 한 콘솔에서 본다.",
                                  "모든 값은 디지털 트윈이 계산한 모의값이며, 실제 위성 텔레메트리가 아니다."])
capture_slide(1, "대시보드 — 실제 위성과 내 군집을 한 지구에", "공개 궤도 데이터로 실제 위성을 띄우고, SDC 필터로 우리 군집 40기만 골라 본다",
              "s1_01_dashboard.png", "화면에서 보이는 것",
              [("실제 위성 카탈로그", "공개 궤도 데이터(GP)로 수천 기의 실제 위성 위치를 표시한다"),
               ("SDC 필터", "노드 탭에서 배치한 우리 군집만 골라 본다"),
               ("위성 선택", "위성을 고르면 3D 모델과 궤도·관측창 정보가 나온다"),
               ("분석 시계", "시간을 앞뒤로 옮기며 위치와 접속을 예측한다")],
              "카탈로그 → 궤도 전파 → 지구 위 표시 → 선택 위성 분석")
capture_slide(1, "노드 배치 — 편대 프리셋으로 40기를 한 번에", "Walker Δ 4개 궤도면 × 10기, 550 km, 53°",
              "s1_02_nodes.png", "화면에서 보이는 것",
              [("편대 프리셋", "궤도면 수·면당 위성 수·고도·경사각 슬라이더로 군집을 만든다"),
               ("위성별 편집", "이름, 버스, 장비, 궤도, 운용 모드를 위성마다 바꿀 수 있다"),
               ("광 링크 격자", "위성마다 앞·뒤·좌·우 4개 광 단말이 이웃 위성을 잡는다"),
               ("배치 완료", "서버가 같은 구성을 수락해야 배치가 확정된다")],
              "프리셋 → 위성 정의 → 서버 수락 → 대시보드·통신·임무 탭에 반영")
capture_slide(1, "노드 상세 — 3D 모델과 광 링크 빔", "NASA 3D 모델을 실제 축척으로 표시하고 광 단말 상태를 본다",
              "s1_03_node_model.png", "화면에서 보이는 것",
              [("3D 모델", "NASA 3D Resources의 Earth Observing-1 모델을 대표 형상으로 사용"),
               ("광 링크 빔", "이웃 위성과 맺은 링크가 빔으로 그려지고 포착·유지 상태가 바뀐다"),
               ("상태 패널", "궤도 요소, 현재 위치, 일조 여부, 전력 수지, 장비 목록"),
               ("모의 계산", "위치는 Kepler+J2 계산이고 링크는 기하 모델이다")],
              "궤도 계산 → 단말 지향 → 포착 → 양방향 유지")
capture_slide(1, "통신망 — 광 링크, 지상국 접속, 경로 계산", "출발과 도착 위성을 고르면 지금 네트워크에서 가장 빠른 길을 보여 준다",
              "s1_04_communication.png", "화면에서 보이는 것",
              [("네트워크 구성", "위성 40기, 지상국 3곳, 사용 가능한 링크 수"),
               ("경로 계산", "SDC-A3 → SDC-A5 최저 지연 경로와 홉별 지연·용량·품질"),
               ("지상국 접속창", "위성별 다음 접속 시각과 최대 고각"),
               ("저장 전달", "지상 경로가 없을 때 데이터를 보관했다가 보내는 상태")],
              "매초 위성 상태 → 송수신 SW → 링크 판정·경로 → 화면")
capture_slide(1, "연결도 — 격자를 한눈에", "궤도면별 링으로 배치해 어느 링크가 살아 있는지 바로 읽는다",
              "s1_05_network_diagram.png", "화면에서 보이는 것",
              [("궤도면 링", "같은 궤도면 위성을 한 링에 놓아 앞·뒤 링크와 좌·우 링크를 구분한다"),
               ("링크 상태 색", "유지·포착 중·차단·장애를 색으로 표시한다"),
               ("지상 링크", "접속 중인 지상국이 위성 옆에 붙는다"),
               ("데이터 흐름", "양방향으로 움직이는 표식으로 전달 방향을 보여 준다")],
              None)
grid_slide(1, "임무 · 데이터 · 보안 · 상태 탭", "나머지 탭도 같은 군집과 같은 시계를 본다",
           [("s1_08_mission.png", "임무", "위성 일정표, 배정된 작업, 검토 결과"),
            ("s1_06_data.png", "데이터", "저장 노드, 데이터 안정성 점수, 복제 상태"),
            ("s1_07_security.png", "보안", "인증률 기준 판정과 전환 이력"),
            ("s1_09_status.png", "상태", "런타임 시계, 활성 장애, 이벤트 이력")],
           "탭마다 담당 운용 SW가 다르지만, 위성 배치와 시계는 디지털 트윈이 하나로 관리한다.")

# ---------------------------------------------------------------- section 2
divider_slide(2, "연결된 운용 SW", ["디지털 트윈은 상태를 계산하고, 운용 SW 4종은 그 상태를 받아 판단한다.",
                                  "지금은 임시 구현이 자리를 대신하며, 협력사 SW가 오면 주소만 바꿔 연결한다."])
capture_slide(2, "모듈 연결 토폴로지", "설정 탭에서 디지털 트윈과 운용 SW의 연결 상태를 실제로 확인한다",
              "s2_01_topology.png", "화면에서 보이는 것",
              [("DT 쪽", "DT 엔진, DT 모델, 운용 콘솔, 시험 관리(시나리오 재생기)"),
               ("운용 SW 쪽", "데이터 관리, 데이터 송수신(패브릭), 군집 운용, 보안 운용"),
               ("연결 상태", "링크마다 실제 접속 검사를 해서 연결·단절·대기를 표시한다"),
               ("배치 방식", "내장(임시 구현)과 외부 주소를 링크별로 고른다")],
              "DT 상태 계산 → 표준 메시지(ICD) → 운용 SW 판단 → DT 화면 표시")
capture_slide(2, "ICD 관리표 — 메시지 단위 구현 현황", "군집 운용 연동(ICD-03)의 메시지 목록과 구현 여부",
              "s2_icd_icd03.png", "화면에서 보이는 것",
              [("메시지 목록", "임무 편성 요청, 배정 결과, 실행 확정 통보, 모듈 상태"),
               ("구현 배지", "구현 / 모의 / 계획으로 지금 코드가 실제로 주고받는지 표시"),
               ("방향·주기·크기", "메시지마다 누가 보내고 얼마나 자주 보내는지"),
               ("개정 이력", "PoC를 거치며 바뀐 항목을 기록한다")],
              None)
grid_slide(2, "운용 SW 4종의 판정 화면", "같은 시나리오에서 각 SW가 무엇을 판단하는지",
           [("s1_06_data.png", "데이터 관리", "데이터를 어디에 몇 벌 둘지, 안정성 점수"),
            ("s3_07_step3_sync_comm.png", "데이터 송수신", "링크 사용 가능 여부와 우회 경로"),
            ("s1_08_mission.png", "군집 운용", "위성별 작업 배정과 기한·저장·전력 검사"),
            ("s1_07_security.png", "보안", "인증률 기준 충족 여부와 전환 이력")],
           "네 SW 모두 디지털 트윈이 보낸 같은 시각의 상태를 받으므로, 장애가 나면 모든 판단이 함께 바뀐다.")
grid_slide(2, "ICD 관리표 — 데이터 관리 · 데이터 송수신 · 보안 · 검증 지원", "메시지마다 구현 여부를 표시한다",
           [("s2_icd_icd01.png", "ICD-01 데이터 관리", "수집 등록, 서비스 요청, 운영 조치, 상태 보고"),
            ("s2_icd_icd02.png", "ICD-02 데이터 송수신", "네트워크 상태 갱신, 링크 판정, 경로 계산"),
            ("s2_icd_icd08.png", "ICD-08 보안", "관측 전달, 판정 조회, 전환 이력"),
            ("s2_icd_icd06.png", "ICD-06 검증 지원", "시나리오 정의, KPI 표본, 결과 기록")])

# ---------------------------------------------------------------- section 3
divider_slide(3, "검증 시나리오 수행", ["SDC_POC_01 · OISL 주 링크 단절과 우회 복구",
                                    "정상 운용 → Fault 주입 → 상태 전달 → 우회·재전송 → 복구 판정, 다섯 단계를 실제 화면으로 따라간다."])
capture_slide(3, "시나리오 선택", "상단 '시나리오' 버튼에서 PoC 시나리오를 고르면 단계·임무·판정 기준이 미리 보인다",
              "s3_01_scenario_select.png", "화면에서 보이는 것",
              [("시나리오 목록", "SIM 시나리오와 PoC 시나리오가 함께 있고, PoC는 전체 정의를 가진다"),
               ("5단계 흐름", "정상 운용 → Fault 주입 → 상태 전달 → 우회·재전송 → 복구 판정"),
               ("군집·임무", "Walker Δ 4면 × 10기, 지상국 3곳, 임무 3건, 표시 모델 EO-1"),
               ("판정 기준", "도달 · 자원 · 상태 세 그룹의 규칙")],
              "정의(서버 설정) → 선택 → 세팅 → 재생")
capture_slide(3, "시나리오 세팅 — 군집·지상국·임무를 한 번에", "세팅이 끝나면 위성 40기가 서버에 수락되고 임무가 편성·확정된다",
              "s3_03_setup_done.png", "세팅이 하는 일",
              [("런타임 준비", "서버 시뮬레이션 시계를 시나리오 실행으로 맞춘다"),
               ("군집 조립", "정의대로 위성 40기를 만들고 서버가 수락한다"),
               ("지상국·임무", "지상국 3곳 배치, 임무 3건 편성, 2건 실행 확정"),
               ("첫 교환·화면 준비", "첫 네트워크 상태를 송수신 SW에 보내고 각 탭을 준비한다")],
              "런타임 → 군집 → 지상국 → 임무 → 네트워크 → 화면")
capture_slide(3, "1단계 정상 운용 — 기준 상태 기록", "T+0. 안내 카드가 단계마다 무엇을 보는지 알려 주고 해당 탭으로 옮긴다",
              "s3_04_step1_mission.png", "이 단계에서",
              [("임무 확정", "N1→N4 데이터 중계와 독도 관측 임무가 실행 중이다"),
               ("안내 카드", "단계 설명, 관련 모듈 흐름, 확인 항목, 함께 볼 탭"),
               ("하단 도크", "단계 목록, 경과 시각, 배속, 다음 단계, ICD 메시지 이력"),
               ("기준 KPI", "정상 구간의 경로·지연·임무 여유를 표본으로 남긴다")],
              "재생 → 안내 카드 → 자동 탭 이동 → KPI 표본")
capture_slide(3, "1단계 정상 운용 — 주 경로 2홉", "통신 탭: SDC-A3 → SDC-A4 → SDC-A5, 편도 지연 31.6 ms",
              "s3_05_step1_comm_primary.png", "이 단계에서",
              [("주 경로", "같은 궤도면 이웃 두 링크를 지나는 가장 빠른 길"),
               ("경로 신뢰도", "경로 위 링크 품질의 곱(57 % × 57 % ≈ 32.5 %)"),
               ("사용 가능 링크", "40기 격자에서 양방향 유지 중인 링크 수"),
               ("모든 탭 동기", "통신·임무·데이터·보안 탭의 시계가 서버 시계를 따른다")],
              "위성 상태 → 송수신 SW → 경로 계산 → 화면")
capture_slide(3, "2단계 Fault 주입 — 주 링크 단절", "T+21 s. 편성된 주 링크 SDC-A3–SDC-A4에 link_loss 장애(300초)를 넣는다",
              "s3_06_step2_fault_status.png", "이 단계에서",
              [("장애 주입", "시나리오가 서버 런타임에 장애를 등록한다(운용자가 직접 넣을 수도 있다)"),
               ("상태 탭", "활성 장애 목록과 이벤트 이력에 즉시 나타난다"),
               ("공통 상태", "장애는 런타임 상태이므로 모든 SW가 같은 사실을 받는다"),
               ("실제 편성 링크", "장애 대상은 계획된 첫 위성 간 전달 링크에서 자동으로 정한다")],
              "장애 등록 → 런타임 상태 → 텔레메트리 → 모든 탭·SW")
capture_slide(3, "3단계 상태 전달 — 송수신 SW가 링크를 사용 불가로 판정", "T+26 s. 통신 탭에서 끊긴 링크와 새로 계산된 우회 경로가 보인다",
              "s3_07_step3_sync_comm.png", "이 단계에서",
              [("네트워크 상태 갱신", "장애가 표시된 링크 상태를 매초 송수신 SW에 보낸다"),
               ("링크 판정", "송수신 SW가 그 링크를 사용 불가로 판정한다"),
               ("우회 경로", "SDC-A3 → SDC-C2 → SDC-C3 → SDC-A4 → SDC-A5, 4홉 40.4 ms"),
               ("재수렴 1초 이내", "장애 직후 대체 경로가 확보됐다")],
              "장애 상태 → 링크 판정 → 경로 재계산 → 안내 카드 확인")
grid_slide(3, "3단계 상태 전달 — 보안·데이터 SW도 같은 상태를 받는다", "장애 중에도 보안 판정은 유지되고 데이터 관리는 저장 노드 상태를 계속 받는다",
           [("s3_08_step3_security.png", "보안 탭", "인증률 기준 충족 유지, 전환 이력에 변화 없음"),
            ("s3_09_step3_data.png", "데이터 탭", "저장 노드 40기 가용, 데이터 안정성 점수 유지")],
           "한 곳의 장애가 모든 운용 SW에 같은 시각의 공통 상태로 전달되는 것이 이 단계의 핵심이다.")
capture_slide(3, "4단계 우회·재전송 — 임무를 새 경로로 다시 편성", "T+36 s. 군집 운용 SW가 장애 링크를 뺀 격자로 중계 임무를 다시 배정한다",
              "s3_10_step4_reroute_mission.png", "이 단계에서",
              [("재편성 요청", "장애 링크와 장애 지상국을 제외한 격자로 편성을 다시 요청한다"),
               ("새 작업 사슬", "N1부터 4홉으로 다시 보내는 위성 간 전달 작업이 일정표에 오른다"),
               ("실행 확정", "새 계획을 확정하면 군집 운용 SW에 통보한다"),
               ("검사 통과", "기한 여유 6,769 s, 종단 지연 32 ms ≤ 40 ms")],
              "장애 링크 제외 → 재편성 → 확정 통보 → 일정표 갱신")
capture_slide(3, "4단계 우회·재전송 — 통신 탭의 우회 경로", "임무 경로와 송수신 SW의 경로가 같은 우회 길을 가리킨다",
              "s3_11_step4_comm_detour.png", "이 단계에서",
              [("우회 4홉", "궤도면을 건너 C면을 거쳐 관문으로 돌아간다"),
               ("지연 증가", "31.6 ms → 40.4 ms, 홉마다 전파·처리 지연이 더해진다"),
               ("저장 전달", "경로가 잠시 없어도 데이터를 보관했다 보내는 상태를 함께 본다"),
               ("장애 만료 대기", "300초 뒤 장애가 풀리면 주 경로로 돌아가는지 본다")],
              None)
capture_slide(3, "5단계 복구 판정 — 정상 대비 KPI 비교", "T+437 s. 장애 해제 후 주 경로 복귀를 확인하고 세 그룹 판정을 낸다",
              "s3_13_verdict_dialog.png", "판정 결과",
              [("도달 통과", "중계 임무 완료, 기한 여유 6,769 s ≥ 0"),
               ("자원 통과", "N1 보관량 0 % ≤ 60 %, 데이터 안정성 75 ≥ 70"),
               ("상태 통과", "대체 경로 재수렴 1초 이내(기준 90 s), 주 경로 복귀, 보안 판정 유지"),
               ("구간별 표", "정상·장애·우회·복구 구간의 홉·지연·여유·안정성을 나란히 비교")],
              "장애 해제 → 주 경로 복귀 → 서비스 요청 → 표본 비교 → 판정 기록")
capture_slide(3, "5단계 복구 판정 — 사건 시각과 메시지 이력", "무슨 일이 언제 일어났는지 시각과 메시지로 남긴다",
              "s3_14_verdict_dialog_log.png", "기록에 남는 것",
              [("사건 시각", "장애 주입 T+20 → 대체 경로 T+21 → 재구성 T+32 → 장애 해제 T+320 → 주 경로 복귀 T+436"),
               ("ICD 메시지 이력", "어느 모듈이 어떤 메시지를 언제 주고받았는지"),
               ("결과 기록", "JSON으로 내려받아 보고서에 붙일 수 있다"),
               ("한계", "값은 모의 계산과 임시 구현의 대표값이며 실측이 아니다")],
              None)

# results summary slide
slide = prs.slides.add_slide(BLANK)
chrome(slide, 3, "시나리오 수행 결과 요약", "다섯 단계의 시각과 복구 판정 3/3 통과")
steps = [("1", "정상 운용", "T+0", "주 경로 2홉 · 31.6 ms · 기준 KPI 표본", NAVY),
         ("2", "Fault 주입", "T+21 s", "SDC-A3–SDC-A4 link_loss 300 s", RED),
         ("3", "상태 전달", "T+26 s", "링크 사용 불가 판정 · 우회 경로 1초 만에 확보", NAVY),
         ("4", "우회·재전송", "T+36 s", "재편성 4홉 · 기한 여유 6,769 s · 종단 지연 32 ms", NAVY),
         ("5", "복구 판정", "T+437 s", "주 경로 복귀 · 도달/자원/상태 3/3 통과", GREEN)]
for index, (num, title, when, desc, color) in enumerate(steps):
    y = 180 + index * 96
    rounded(slide, 48, y, 1000, 80, BOX, LINE, 1.5, 12, name=f"summary step {num}")
    circle(slide, 70, y + 20, 40, color)
    text_box(slide, 70, y + 20, 40, 40, [para(num, 18, True, WHITE, align=PP_ALIGN.CENTER)], anchor=MSO_ANCHOR.MIDDLE)
    text_box(slide, 130, y + 12, 300, 56, [para(title, 22, True, INK)], anchor=MSO_ANCHOR.MIDDLE)
    text_box(slide, 330, y + 12, 140, 56, [para(when, 20, True, color)], anchor=MSO_ANCHOR.MIDDLE)
    text_box(slide, 480, y + 12, 550, 56, [para(desc, 16, False, MUTED)], anchor=MSO_ANCHOR.MIDDLE)
rounded(slide, 1090, 180, 782, 464, WHITE, LINE, 2, 16, name="kpi box")
text_box(slide, 1112, 196, 740, 34, [para("구간별 KPI 비교", 20, True, NAVY)], anchor=MSO_ANCHOR.MIDDLE)
rows = [["지표", "정상", "장애", "우회", "복구"],
        ["경로 홉 수", "2", "4", "4", "2"],
        ["편도 지연", "31.6 ms", "40.4 ms", "40.4 ms", "31.6 ms"],
        ["임무 경로 홉 / 종단 지연", "2 / 16 ms", "2 / 16 ms", "4 / 32 ms", "4 / 32 ms"],
        ["기한 여유", "7,003 s", "7,003 s", "6,769 s", "6,769 s"],
        ["데이터 안정성", "—", "—", "75", "77"],
        ["보안 판정", "기준 충족", "기준 충족", "기준 충족", "기준 충족"]]
highlight = {(1, 2): RED, (1, 4): GREEN, (2, 2): RED, (2, 4): GREEN, (3, 3): RED, (4, 4): GREEN}
table_shape = slide.shapes.add_table(len(rows), 5, px(1112), px(240), px(740), px(len(rows) * 40))
table_shape.name = "KPI table"
table = table_shape.table
tbl_pr = table._tbl.tblPr
tbl_pr.set("firstRow", "0")
tbl_pr.set("bandRow", "0")
style = tbl_pr.find(qn("a:tableStyleId"))
if style is None:
    style = tbl_pr.makeelement(qn("a:tableStyleId"), {})
    tbl_pr.append(style)
style.text = "{2D5ABB26-0587-4C30-8999-92F81FD0307C}"
for column, width in zip(table.columns, [260, 120, 120, 120, 120]):
    column.width = px(width)
for r, row in enumerate(rows):
    table.rows[r].height = px(40)
    for c, value in enumerate(row):
        cell = table.cell(r, c)
        cell.margin_left = cell.margin_right = px(8)
        cell.margin_top = cell.margin_bottom = px(2)
        cell.vertical_anchor = MSO_ANCHOR.MIDDLE
        cell.fill.solid()
        cell.fill.fore_color.rgb = BOX if r == 0 else WHITE
        tc_pr = cell._tc.get_or_add_tcPr()
        ln = tc_pr.makeelement(qn("a:lnB"), {"w": "9525", "cap": "flat", "cmpd": "sng", "algn": "ctr"})
        fill = ln.makeelement(qn("a:solidFill"), {})
        clr = fill.makeelement(qn("a:srgbClr"), {"val": "E6E9F2"})
        fill.append(clr)
        ln.append(fill)
        tc_pr.insert(0, ln)
        p = cell.text_frame.paragraphs[0]
        p.alignment = PP_ALIGN.LEFT if c == 0 else PP_ALIGN.RIGHT
        run = p.add_run()
        run.text = value
        set_font(run, 15 if r == 0 else 16, r == 0 or c == 0 or (r, c) in highlight, highlight.get((r, c), MUTED if r == 0 else INK))
rounded(slide, 1090, 668, 782, 176, RGBColor(0xED, 0xF8, 0xF1), RGBColor(0xBF, 0xE5, 0xCC), 2, 16, name="verdict box")
text_box(slide, 1112, 684, 740, 40, [para("복구 판정 통과 · 3/3 항목", 24, True, GREEN)], anchor=MSO_ANCHOR.MIDDLE)
text_box(slide, 1112, 728, 740, 100, [para("도달: 중계 임무 완료, 기한 여유 6,769 s", 16, False, INK, space_after=4),
                                      para("자원: N1 보관량 0 %, 데이터 안정성 75", 16, False, INK, space_after=4),
                                      para("상태: 재수렴 1초 이내, 주 경로 복귀, 보안 판정 유지", 16, False, INK)])
text_box(slide, 48, 680, 1000, 160, [para("장애가 나도 ① 모든 SW가 같은 상태를 받고 ② 우회 경로와 재편성이 자동으로 이어지며 ③ 장애가 풀리면 원래 경로로 돌아온다는 것을, 화면과 수치로 확인했다.", 18, True, NAVY, line_spacing=1.3)], anchor=MSO_ANCHOR.MIDDLE, name="takeaway")

# ---------------------------------------------------------------- section 4
divider_slide(4, "기대 효과", ["이런 디지털 트윈 체계가 있으면 무엇이 달라지는가.",
                             "구축 전에 시험하고, 연동하며 검증하고, 운용하며 개선한다."])
slide = prs.slides.add_slide(BLANK)
chrome(slide, 4, "기대 효과 — 이런 시스템이 있으면", "PoC에서 확인한 것을 바탕으로 앞으로 할 수 있는 일")
benefits = [("w_nodes", "없는 체계의 사전 시험", "아직 구축되지 않은 군집·데이터 센터 운용 체계를 시나리오로 미리 시험한다.", "장애·재구성처럼 실물로는 위험한 상황도 안전하게 반복해 볼 수 있다.", "예) 아직 없는 40기 군집의 링크 장애와 우회 복구를 오늘 화면에서 시험했다."),
            ("w_power", "EM 연동 HW 검증", "EM(공학 모델)과 연동해 노드 HW의 텔레메트리 취득과 명령 반응을 시나리오 안에서 검증한다.", "IPMC/Chassis Manager 기반 장비 관리 기능을 같은 시나리오로 확인한다.", "예) 장애 주입 단계에서 실제 노드 장비의 상태 보고와 복구 명령을 함께 본다."),
            ("w_refresh", "운용 SW 검증", "데이터 관리·송수신·군집 운용·보안 SW를 같은 시나리오, 같은 상태로 비교 검증한다.", "임시 모듈을 실제 SW로 바꿔도 시험 절차는 그대로다.", "예) 협력사 SW가 오면 주소만 바꿔 같은 시나리오를 다시 돌리고 판정을 비교한다."),
            ("w_monitor", "기대되는 것", "요구사항과 인터페이스를 조기에 확정하고 운용 절차와 KPI 기준을 확보한다.", "장애 대응 훈련과 설계 개선을 반복할 수 있다.", "예) 이번 PoC로 인터페이스 8종의 메시지가 구현·계획으로 정리됐다.")]
for index, (icon, title, line1, line2, line3) in enumerate(benefits):
    cx = 48 + (index % 2) * 924
    cy = 176 + (index // 2) * 360
    rounded(slide, cx, cy, 900, 330, BOX, LINE, 1.5, 18, name=f"benefit {index + 1}")
    circle(slide, cx + 28, cy + 28, 76, ORANGE)
    picture(slide, ICONS / f"{icon}.png", cx + 28 + 18, cy + 28 + 18, 40, 40, name=f"benefit icon {index + 1}")
    text_box(slide, cx + 124, cy + 30, 740, 70, [para(f"{index + 1}. {title}", 28, True, NAVY)], anchor=MSO_ANCHOR.MIDDLE)
    text_box(slide, cx + 28, cy + 120, 844, 200, [para(line1, 19, False, INK, space_after=8, line_spacing=1.25), para(line2, 17, False, MUTED, space_after=12, line_spacing=1.25), para(line3, 16, True, ORANGE, line_spacing=1.25)])
rounded(slide, 48, 906, 1824, 96, NAVY, None, 0, 18, name="banner")
text_box(slide, 78, 906, 1764, 96, [([("구축 전에 시험하고, ", 26, True, WHITE), ("연동하며 검증하고", 26, True, YELLOW), (", 운용하며 개선한다.", 26, True, WHITE)], {"align": PP_ALIGN.CENTER})], anchor=MSO_ANCHOR.MIDDLE)

slide = prs.slides.add_slide(BLANK)
chrome(slide, 4, "다음 단계", "PoC 결과를 설계에 이렇게 반영한다")
nexts = [("SW 상세 설계 지원", "시나리오 중심으로 군집 운용 SW의 기능을 상세화·고도화한다.", "다양한 시나리오와 What-if 상황을 DT에서 미리 돌려 SW 요구사항과 판정 기준을 도출한다."),
         ("실제 운용 SW 연동", "PoC의 임시 모듈을 협력사 운용 SW로 교체하고 인터페이스는 그대로 둔다.", "지연·상태 값 등 메시지 항목을 실제 SW 기준으로 보완해 ICD를 확정한다."),
         ("검증 기능 확장", "시험 결과 저장·조회로 시나리오 반복 실행과 결과 비교를 지원한다.", "데이터 전달 상태와 군집 상태 보고를 추가해 운용 지표를 넓힌다.")]
for index, (title, line1, line2) in enumerate(nexts):
    y = 190 + index * 250
    rounded(slide, 48, y, 1824, 220, BOX, LINE, 1.5, 18, name=f"next {index + 1}")
    circle(slide, 84, y + 70, 80, TEAL)
    text_box(slide, 84, y + 70, 80, 80, [para(str(index + 1), 34, True, WHITE, align=PP_ALIGN.CENTER)], anchor=MSO_ANCHOR.MIDDLE)
    text_box(slide, 200, y + 32, 1600, 50, [para(title, 30, True, NAVY)], anchor=MSO_ANCHOR.MIDDLE)
    text_box(slide, 200, y + 92, 1620, 110, [para("· " + line1, 19, False, INK, space_after=8), para("· " + line2, 19, False, INK)])

out = OUT_DIR / "poc_deck_v1.pptx"
prs.save(out)
print("saved", out, out.stat().st_size, "bytes;", len(prs.slides), "slides")
