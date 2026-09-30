"""Re-capture the section-3 step screens with the runtime paused between steps so every
capture shows exactly the step it names."""
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8795"
OUT = Path(r"D:\ICDCDT\project_support\output\poc_deck\captures")
TAB_JS = "(name) => { const b = [...document.querySelectorAll('.tab-button, [role=tab], nav button')].find(b => b.textContent.trim() === name); if (b) b.click(); return !!b; }"
HIDE_GUIDE = "(() => { const g = document.getElementById('scenario-guide'); if (g) g.hidden = true; })()"
SHOW_GUIDE = "(() => { const g = document.getElementById('scenario-guide'); if (g) g.hidden = false; })()"


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


def phase(page):
    return page.evaluate("document.getElementById('sd-phase')?.textContent || ''")


def step_no(page):
    return page.evaluate("(() => { const k = document.querySelector('#scenario-guide .sg-kicker'); const m = k && k.textContent.match(/(\\d+)단계/); return m ? Number(m[1]) : 0; })()")


def elapsed(page):
    return page.evaluate("document.getElementById('sd-elapsed')?.textContent || ''")


def shot(page, name):
    path = OUT / f"{name}.png"
    page.screenshot(path=str(path))
    log("saved", path.name, "|", phase(page), elapsed(page), "step", step_no(page))


def tab(page, name, wait=2.5):
    page.evaluate(TAB_JS, name)
    time.sleep(wait)


def play(page):
    if "재생 중" not in phase(page):
        page.click("#sd-play")
        time.sleep(0.6)


def pause(page):
    if "재생 중" in phase(page):
        page.click("#sd-play")
        time.sleep(0.6)


def wait_step(page, wanted, timeout=60):
    started = time.time()
    while time.time() - started < timeout:
        if step_no(page) >= wanted:
            return True
        time.sleep(0.2)
    return False


def select_mission(page, text):
    page.evaluate("(t) => { const row = [...document.querySelectorAll('#msn-list [data-msn-id]')].find(r => r.textContent.includes(t)); if (row) row.click(); }", text)
    time.sleep(1.5)


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
    page.click("#scenario-button")
    time.sleep(1.5)
    page.click('#scenario-dialog button.sc-item[data-scenario="SDC_POC_01"]')
    time.sleep(2)
    page.evaluate("[...document.querySelectorAll('#scenario-dialog button')].find(b => b.textContent.trim().includes('세팅')).click()")
    started = time.time()
    while "준비 완료" not in phase(page):
        if time.time() - started > 180:
            raise TimeoutError(phase(page))
        time.sleep(1)
    time.sleep(1)
    page.evaluate("document.getElementById('scenario-dialog')?.close()")
    tab(page, "임무", 2)
    select_mission(page, "N1→N4")

    # Step 1: play, capture, then pause.
    play(page)
    wait_step(page, 1, 30)
    time.sleep(5)
    pause(page)
    shot(page, "s3_04_step1_mission")
    page.evaluate(HIDE_GUIDE)
    tab(page, "통신", 5)
    shot(page, "s3_05_step1_comm_primary")
    page.evaluate(SHOW_GUIDE)
    tab(page, "임무", 1)

    # Steps 2-4: the skip button only works while playing, so play, skip, and pause as soon as
    # the step fires (the next step is at least 4 s of clock time away).
    def fire_next(wanted):
        play(page)
        time.sleep(0.8)
        page.click("#sd-skip")
        ok = wait_step(page, wanted, 40)
        pause(page)
        time.sleep(2.5)
        log("step", wanted, "fired" if ok else "NOT fired", elapsed(page))

    fire_next(2)
    shot(page, "s3_06_step2_fault_status")

    fire_next(3)
    shot(page, "s3_07_step3_sync_comm")
    page.evaluate(HIDE_GUIDE)
    tab(page, "보안", 3)
    shot(page, "s3_08_step3_security")
    tab(page, "데이터", 3)
    shot(page, "s3_09_step3_data")
    page.evaluate(SHOW_GUIDE)
    tab(page, "통신", 1)

    fire_next(4)
    select_mission(page, "N1→N4")
    time.sleep(1)
    shot(page, "s3_10_step4_reroute_mission")
    page.evaluate(HIDE_GUIDE)
    tab(page, "통신", 5)
    shot(page, "s3_11_step4_comm_detour")
    page.evaluate(SHOW_GUIDE)
    tab(page, "임무", 1)

    # Step 5: skip to the verdict and let it judge.
    play(page)
    time.sleep(0.8)
    page.click("#sd-skip")
    started = time.time()
    while time.time() - started < 120:
        if "완료" in phase(page) or page.evaluate("!!document.querySelector('#scenario-result-dialog[open]')"):
            break
        time.sleep(1)
    time.sleep(3)
    page.evaluate("document.getElementById('scenario-result-dialog')?.close()")
    select_mission(page, "N1→N4")
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
