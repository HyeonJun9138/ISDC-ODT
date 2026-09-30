"""Check settings diagram sizing with the shipped DOM and CSS in Chromium."""

import re
import json
from pathlib import Path
from urllib.parse import urlparse

import pytest

playwright = pytest.importorskip('playwright.sync_api')
WEB = Path(__file__).resolve().parents[2] / 'user_application' / 'web'


@pytest.fixture
def settings_page():
    html = (WEB / 'index.html').read_text(encoding='utf-8')
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
            if "Executable doesn't exist" in str(error):
                pytest.skip('Install Playwright Chromium to run UI tests')
            raise
        page = browser.new_page(reduced_motion='reduce')
        def serve(route):
            path = urlparse(route.request.url).path
            if path.startswith('/static/'):
                target = WEB / path.removeprefix('/static/')
                return route.fulfill(body=target.read_text(encoding='utf-8'), content_type='text/javascript')
            if path == '/api/security/status':
                return route.fulfill(status=503, content_type='application/json', body=json.dumps({
                    'placement': 'remote', 'endpoint': 'http://actual-security.test:9000',
                    'contract_version': '1.0', 'reachable': False, 'implementation': 'security-sim',
                }))
            route.fulfill(body=html, content_type='text/html')
        page.route('http://settings.test/**', serve)
        page.goto('http://settings.test/')
        page.evaluate('''() => {
            document.querySelector('#app-loading').remove();
            document.querySelectorAll('.tab-view').forEach(view =>
                view.classList.toggle('active', view.id === 'view-settings'));
            document.querySelector('#settings-mode-note').textContent = 'DT 코어와 운용 SW 모듈만 운용한다.';
            // The diagram's real intrinsic size; this fixture isolates CSS from network probes.
            document.querySelector('#settings-topology').innerHTML =
                '<svg width="1320" height="720" viewBox="0 0 1320 720" preserveAspectRatio="xMidYMin meet"><rect width="1320" height="720"/></svg>';
        }''')
        yield page
        browser.close()


@pytest.mark.parametrize('width,height', [(3406, 1275), (1920, 1080), (1366, 768), (1280, 720)])
def test_diagram_fits_before_the_link_table_without_overscaling(settings_page, width, height):
    settings_page.set_viewport_size({'width': width, 'height': height})
    boxes = settings_page.evaluate('''() => {
        const host = document.querySelector('#settings-topology');
        const svg = host.querySelector('svg');
        return {
            svg: svg.getBoundingClientRect().toJSON(),
            diagram: svg.querySelector('rect').getBoundingClientRect().toJSON(),
            legend: document.querySelector('.topo-legend').getBoundingClientRect().toJSON(),
            table: document.querySelector('.settings-links-panel').getBoundingClientRect().toJSON(),
            overflow: host.scrollWidth - host.clientWidth,
        };
    }''')
    assert boxes['diagram']['height'] <= 721, 'Do not enlarge diagram text beyond its native scale on wide screens'
    assert boxes['legend']['bottom'] < height, 'The full diagram and legend must be visible without vertical scrolling'
    assert boxes['table']['top'] < height - 50, 'Leave room to discover the link table below the diagram'
    assert boxes['overflow'] <= 1, 'The diagram must fit narrower desktop viewports without horizontal scrolling'
    assert boxes['diagram']['bottom'] <= boxes['svg']['bottom'] + 1


@pytest.mark.parametrize('theme', ['dark', 'light'])
def test_security_cards_show_actual_deployment_and_diagnostic_separation(settings_page, theme):
    page = settings_page
    page.set_viewport_size({'width': 1280, 'height': 720})
    page.evaluate('''async theme => {
        document.documentElement.dataset.theme = theme;
        document.querySelector('#settings-topology').innerHTML = '';
        const {store} = await import('/static/scripts/state.js');
        store.activeTab = 'settings';
        const {initSettings} = await import('/static/scripts/tabs/settings.js');
        initSettings({api: {integrationProbe: async links => ({results: Object.fromEntries(
            links.map(link => [link.id, {state: 'up', method: 'in-process', detail: 'SIM 응답'}]))})}});
    }''', theme)
    page.wait_for_function("document.querySelector('[data-module=security-ops] .placement').textContent.includes('외부')")
    page.locator('[data-module="security-ops"]').click()
    detail = page.locator('#settings-detail')
    assert 'http://actual-security.test:9000' in detail.inner_text()
    assert '응답 불가' in detail.inner_text()
    assert '실제 보안 검증이 아닙니다' in detail.inner_text()
    assert '진단 주소와 무관' in detail.inner_text()
    assert page.locator('[data-module="security-ops"]').get_attribute('class').endswith('selected')
    assert 'warn' in page.locator('[data-module="security-ops"]').get_attribute('class')
    assert 'disabled' in page.locator('[data-link="L17"]').get_attribute('class')
    page.locator('[data-link-row="L16"]').click()
    assert '저장해도 실제 모듈 배치는 바뀌지 않습니다' in detail.inner_text()
    assert 'SPACETWIN_SECURITY_URL' in detail.inner_text()
    fits = page.evaluate('''() => [...document.querySelectorAll('.topo-node')].every(node => {
        const body = node.querySelector('.body').getBBox();
        return [...node.querySelectorAll('.name,.placement')].every(label => {
            const box = label.getBBox();
            return box.x >= 3 && box.x + box.width <= body.width - 3 && box.y >= 0 && box.y + box.height <= body.height;
        });
    })''')
    assert fits, 'All topology card names and placement labels stay within their card'
