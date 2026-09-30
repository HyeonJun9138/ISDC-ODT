"""Capture every screen of the PoC flow for the walkthrough deck (headless Chromium, 1600x900, dark)."""
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8795"
OUT = Path(r"D:\ICDCDT\project_support\output\poc_deck\captures")
OUT.mkdir(parents=True, exist_ok=True)
TAB_JS = "(name) => { const b = [...document.querySelectorAll('.tab-button, [role=tab], nav button')].find(b => b.textContent.trim() === name); if (b) b.click(); return !!b; }"
HIDE_GUIDE = "(() => { const g = document.getElementById('scenario-guide'); if (g) g.hidden = true; })()"
SHOW_GUIDE = "(() => { const g = document.getElementById('scenario-guide'); if (g) g.hidden = false; })()"


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


def phase(page):
    return page.evaluate("document.getElementById('sd-phase')?.textContent || ''")


def step_no(page):
    return page.evaluate("(() => { const k = document.querySelector('#scenario-guide .sg-kicker'); const m = k && k.textContent.match(/(\\d+)단계/); return m ? Number(m[1]) : 0; })()")


def shot(page, name):
    path = OUT / f"{name}.png"
    page.screenshot(path=str(path))
    log("saved", path.name)


def tab(page, name, wait=2.5):
    page.evaluate(TAB_JS, name)
    time.sleep(wait)


def wait_step(page, wanted, timeout=120):
    started = time.time()
    while time.time() - started < timeout:
        if step_no(page) >= wanted:
            return True
        time.sleep(0.5)
    return False


with sync_playwright() as p:
    browser = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    context = browser.new_context(viewport={"width": 1600, "height": 900}, device_scale_factor=1, color_scheme="dark")
    page = context.new_page()
    page.goto(BASE, wait_until="domcontentloaded")
    for _ in range(25):
        if page.evaluate("(() => { const l = document.getElementById('app-loading'); return !l || l.hidden || getComputedStyle(l).display === 'none'; })()"):
            break
        time.sleep(1)
    page.evaluate("(() => { const l = document.getElementById('app-loading'); if (l) l.hidden = true; })()")
    if page.evaluate("document.documentElement.dataset.theme") != "dark":
        page.click("#theme-toggle")
    time.sleep(1)

    # --- Scenario selection and setup (section 3 opening) ---
    page.click("#scenario-button")
    time.sleep(1.5)
    page.click('#scenario-dialog button.sc-item[data-scenario="SDC_POC_01"]')
    time.sleep(2)
    shot(page, "s3_01_scenario_select")
    page.evaluate("[...document.querySelectorAll('#scenario-dialog button')].find(b => b.textContent.trim().includes('세팅')).click()")
    time.sleep(4)
    shot(page, "s3_02_setup_progress")
    started = time.time()
    while "준비 완료" not in phase(page):
        if time.time() - started > 180:
            raise TimeoutError(phase(page))
        time.sleep(1)
    time.sleep(1)
    shot(page, "s3_03_setup_done")
    page.evaluate("document.getElementById('scenario-dialog')?.close()")
    time.sleep(1)

    # --- Section 1: DT functions, nominal state after setup ---
    tab(page, "대시보드", 4)
    shot(page, "s1_01_dashboard")
    tab(page, "노드", 4)
    shot(page, "s1_02_nodes")
    page.evaluate("(() => { const rows = [...document.querySelectorAll('#view-nodes [data-node-id], #view-nodes .node-row, #view-nodes tbody tr')]; const r = rows.find(r => /SDC-A3/.test(r.textContent)); if (r) r.click(); })()")
    time.sleep(2)
    for _ in range(10):
        page.evaluate("(() => { const b = [...document.querySelectorAll('#view-nodes .map-controls button, #view-nodes [class*=\"map-control\"] button')].find(b => (b.getAttribute('aria-label') || b.title) === '지도 확대'); if (b) b.click(); })()")
        time.sleep(0.3)
    time.sleep(10)
    shot(page, "s1_03_node_model")
    tab(page, "통신", 5)
    shot(page, "s1_04_communication")
    page.evaluate("(() => { const b = [...document.querySelectorAll('button')].find(b => b.offsetParent !== null && b.textContent.trim() === '연결도'); if (b) b.click(); })()")
    time.sleep(4)
    shot(page, "s1_05_network_diagram")
    page.evaluate("(() => { const b = [...document.querySelectorAll('button')].find(b => b.offsetParent !== null && b.textContent.trim() === '지구 3D'); if (b) b.click(); })()")
    time.sleep(2)
    tab(page, "데이터", 3)
    shot(page, "s1_06_data")
    tab(page, "보안", 3)
    shot(page, "s1_07_security")
    tab(page, "임무", 3)
    shot(page, "s1_08_mission")
    tab(page, "상태", 3)
    shot(page, "s1_09_status")

    # --- Section 2: connected software ---
    tab(page, "설정", 3)
    shot(page, "s2_01_topology")
    for icd in ("ICD-01", "ICD-02", "ICD-03", "ICD-08", "ICD-06"):
        page.evaluate("(id) => { const b = document.querySelector(`[data-open-icd=\"${id}\"]`); if (b) { b.scrollIntoView({block: 'center'}); b.click(); } }", icd)
        time.sleep(1.5)
        shot(page, f"s2_icd_{icd.lower().replace('-', '')}")
        page.evaluate("document.getElementById('icd-dialog')?.close()")
        time.sleep(0.5)

    # --- Section 3: playback ---
    tab(page, "임무", 2)
    page.click("#sd-play")
    wait_step(page, 1, 30)
    time.sleep(6)
    shot(page, "s3_04_step1_mission")
    page.evaluate(HIDE_GUIDE)
    tab(page, "통신", 5)
    shot(page, "s3_05_step1_comm_primary")
    page.evaluate(SHOW_GUIDE)
    tab(page, "임무", 1)
    page.click("#sd-skip")
    wait_step(page, 2, 40)
    time.sleep(4)
    shot(page, "s3_06_step2_fault_status")
    wait_step(page, 3, 60)
    time.sleep(4)
    shot(page, "s3_07_step3_sync_comm")
    page.evaluate(HIDE_GUIDE)
    tab(page, "보안", 3)
    shot(page, "s3_08_step3_security")
    tab(page, "데이터", 3)
    shot(page, "s3_09_step3_data")
    page.evaluate(SHOW_GUIDE)
    wait_step(page, 4, 90)
    time.sleep(5)
    shot(page, "s3_10_step4_reroute_mission")
    page.evaluate(HIDE_GUIDE)
    tab(page, "통신", 5)
    shot(page, "s3_11_step4_comm_detour")
    page.evaluate(SHOW_GUIDE)
    tab(page, "임무", 1)
    page.click("#sd-skip")
    started = time.time()
    while time.time() - started < 120:
        if "완료" in phase(page) or page.evaluate("!!document.querySelector('#scenario-result-dialog[open]')"):
            break
        time.sleep(1)
    time.sleep(3)
    page.evaluate("document.getElementById('scenario-result-dialog')?.close()")
    time.sleep(1)
    shot(page, "s3_12_step5_verdict_mission")
    page.click("#sd-result")
    time.sleep(2)
    shot(page, "s3_13_verdict_dialog")
    page.evaluate("(() => { const b = document.getElementById('scenario-result-body'); if (b) b.scrollTop = 900; })()")
    time.sleep(1)
    shot(page, "s3_14_verdict_dialog_log")
    page.evaluate("document.getElementById('scenario-result-dialog')?.close()")
    page.evaluate(HIDE_GUIDE)
    tab(page, "데이터", 3)
    shot(page, "s3_15_after_data")
    tab(page, "상태", 3)
    shot(page, "s3_16_after_status")
    browser.close()
    log("done")
