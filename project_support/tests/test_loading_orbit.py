"""Render the shipped loading screen; Playwright is an optional local UI-test dependency."""

import math
import re
from pathlib import Path

import pytest

playwright = pytest.importorskip('playwright.sync_api')
WEB = Path(__file__).resolve().parents[2] / 'user_application' / 'web'


@pytest.fixture
def loading_page():
    html = (WEB / 'index.html').read_text(encoding='utf-8')
    # Keep the real markup and stylesheet order, but do not start the app or fetch external assets.
    html = re.sub(r'<script\b[^>]*>.*?</script>', '', html, flags=re.S)
    html = re.sub(
        r'<link\b[^>]*>',
        lambda match: '<style>' + (WEB / path.group(1)).read_text(encoding='utf-8') + '</style>'
        if (path := re.search(r'href="/static/([^"?]+)', match.group())) else '',
        html,
    )
    with playwright.sync_playwright() as driver:
        try:
            browser = driver.chromium.launch()
        except playwright.Error as error:
            if 'Executable doesn\'t exist' in str(error):
                pytest.skip('Install the optional Playwright Chromium browser to run UI tests')
            raise
        page = browser.new_page(viewport={'width': 1000, 'height': 760}, reduced_motion='no-preference')
        page.set_content(html)
        yield page
        browser.close()


@pytest.mark.parametrize('motion', ['no-preference', 'reduce'])
def test_orbit_dots_visibly_counter_rotate_while_the_planet_stays_fixed(loading_page, motion):
    loading_page.emulate_media(reduced_motion=motion)
    samples = loading_page.evaluate('''() => {
        const rings = [...document.querySelectorAll('.loading-orbit i')];
        const planet = document.querySelector('.loading-orbit b');
        const animations = rings.map(ring => ring.getAnimations()[0]);
        if (animations.some(animation => !animation)) return null;
        animations.forEach(animation => { animation.pause(); animation.currentTime = 0; });
        const angles = () => rings.map(ring => {
            const matrix = new DOMMatrix(getComputedStyle(ring).transform);
            return Math.atan2(matrix.b, matrix.a) * 180 / Math.PI;
        });
        const before = angles();
        const centerBefore = planet.getBoundingClientRect().toJSON();
        animations.forEach(animation => { animation.currentTime = 600; });
        return { before, after: angles(), centerBefore,
            centerAfter: planet.getBoundingClientRect().toJSON(),
            planetTransform: getComputedStyle(planet).transform };
    }''')
    assert samples is not None, 'Both orbit dots must have a running animation'
    turns = [(after - before + 180) % 360 - 180
             for before, after in zip(samples['before'], samples['after'])]
    assert 45 <= turns[0] <= 120, 'The outer dot must visibly sweep around the planet within 600 ms'
    assert -120 <= turns[1] <= -45, 'The inner dot must sweep in the opposite direction'
    assert not math.isclose(samples['before'][0], samples['before'][1], abs_tol=5), 'Start dots apart'
    assert samples['centerBefore'] == samples['centerAfter']
    assert samples['planetTransform'] == 'none'


def test_reduced_motion_still_disables_other_loading_effects(loading_page):
    loading_page.emulate_media(reduced_motion='reduce')
    assert loading_page.evaluate('''() => [
        getComputedStyle(document.querySelector('.loading-bar i'), '::after').animationName,
        getComputedStyle(document.querySelector('.loading-step'), '::before').animationName,
    ].every(name => name === 'none')''')


@pytest.mark.parametrize('theme', ['light', 'dark'])
def test_loading_background_is_softened_without_blurring_the_foreground(loading_page, theme):
    styles = loading_page.evaluate('''theme => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty('--loading-background', 'url("/static/assets/loading/loading_1.png")');
        const background = getComputedStyle(document.querySelector('.loading-backdrop'), '::before');
        return {
            image: background.backgroundImage, size: background.backgroundSize,
            filter: background.filter, opacity: background.opacity,
            overlay: getComputedStyle(document.querySelector('.loading-backdrop'), '::after').backgroundImage,
            cardFilter: getComputedStyle(document.querySelector('.loading-card')).filter,
            rootFilter: getComputedStyle(document.querySelector('.app-loading')).filter,
            titleColor: getComputedStyle(document.querySelector('.loading-card h1')).color,
        };
    }''', theme)
    assert 'loading_1.png' in styles['image']
    assert styles['size'] == 'cover'
    blur = re.fullmatch(r'blur\(([\d.]+)px\)', styles['filter'])
    assert blur and 0 < float(blur.group(1)) <= 3, 'Only a subtle background blur'
    assert float(styles['opacity']) > 0
    assert 'gradient' in styles['overlay']
    assert styles['cardFilter'] == styles['rootFilter'] == 'none'
    assert all(int(value) > 200 for value in re.findall(r'\d+', styles['titleColor'])[:3])
