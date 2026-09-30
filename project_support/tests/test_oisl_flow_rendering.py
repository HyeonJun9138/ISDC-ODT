"""Render OISL packets and the schematic with the actual shader, markup and CSS."""
import base64
from pathlib import Path

import pytest

playwright = pytest.importorskip('playwright.sync_api')
ROOT = Path(__file__).resolve().parents[2]


def module_url(path):
    return 'data:text/javascript;base64,' + base64.b64encode(path.read_bytes()).decode()


@pytest.fixture
def flow_page():
    with playwright.sync_playwright() as driver:
        try:
            browser = driver.chromium.launch()
        except playwright.Error as error:
            if "Executable doesn't exist" in str(error):
                pytest.skip('Install Playwright Chromium to run UI tests')
            raise
        page = browser.new_page()
        css = (ROOT / 'user_application/web/styles/communication.css').read_text(encoding='utf-8')
        page.set_content(f'<style>{css}</style><div id="host"></div>')
        yield page
        browser.close()


@pytest.mark.parametrize('motion', ['no-preference', 'reduce'])
@pytest.mark.parametrize('kind', ['oisl', 'ground'])
def test_schematic_packets_move_both_ways_only_on_usable_links(flow_page, motion, kind):
    flow_page.emulate_media(reduced_motion=motion)
    result = flow_page.evaluate('''async ({url, kind}) => {
        const {diagramMarkup, layoutNetwork} = await import(url);
        const layout = layoutNetwork({satellites: [{id:'A'}, {id:'B'}], stations:[{id:'GS'}]});
        const b = kind === 'ground' ? 'GS' : 'B';
        const links = [
            {id:'up', a:'A', b, kind, usable:true, quality:95},
            {id:'down', a:'A', b, kind, usable:false, quality:0},
            {id:'terrestrial', a:'A', b:'GS', kind:'terrestrial', usable:true, quality:95},
        ];
        const host = document.querySelector('#host');
        // A ground contact is a tag beside its satellite; its packet line exists only while the
        // contact carries the computed route, so the ground case renders the usable link as routed.
        const options = seconds => ({flowTimeSeconds: seconds, routeLinkIds: kind === 'ground' ? new Set(['up']) : new Set()});
        const flowSelector = kind === 'ground' ? '.nd-ground-line.routed .nd-flow' : '[data-diagram-link="up"] .nd-flow';
        const render = seconds => { host.innerHTML = diagramMarkup(layout, links, options(seconds)); };
        render(0);
        const packets = [...host.querySelectorAll(flowSelector)];
        const animations = packets.map(packet => packet.getAnimations()[0]);
        if (packets.length !== 2 || animations.some(a => !a)) return null;
        const offsets = () => packets.map(p => parseFloat(getComputedStyle(p).strokeDashoffset));
        animations.forEach(a => { a.pause(); a.currentTime = 0; });
        const before = offsets();
        animations.forEach(a => { a.currentTime = 450; });
        const after = offsets();
        const otherFlows = host.querySelectorAll('[data-diagram-link="down"] .nd-flow, [data-diagram-link="terrestrial"] .nd-flow').length;
        render(.45);
        const updated = [...host.querySelectorAll(flowSelector)];
        updated.forEach(p => { const a = p.getAnimations()[0]; a.pause(); a.currentTime = 0; });
        return {before, after, otherFlows, resumed: updated.map(p => parseFloat(getComputedStyle(p).strokeDashoffset)),
            hit: updated.every(p => getComputedStyle(p).pointerEvents === 'none')};
    }''', {'url':module_url(ROOT / 'digital_twin/visualization/network_diagram.js'), 'kind':kind})
    assert result is not None, 'Usable satellite links need two animated packet paths'
    assert result['after'][0] < result['before'][0]
    assert result['after'][1] > result['before'][1]
    assert result['resumed'] == pytest.approx(result['after'], abs=.02), 'Snapshot refresh must not reset the packet phase'
    assert result['otherFlows'] == 0
    assert result['hit'], 'The packet decoration must not intercept link clicks'


def test_packet_shader_renders_opposite_motion_in_screen_pixels(flow_page):
    # Use a narrow horizontal line and distinct channels to measure each packet train independently.
    result = flow_page.evaluate('''async url => {
        const {LINK_FLOW_SOURCE} = await import(url);
        const canvas = document.createElement('canvas'); canvas.width = 384; canvas.height = 8;
        const gl = canvas.getContext('webgl2');
        if (!gl) return null;
        const compile = (type, source) => {
            const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
            return shader;
        };
        const vs = `#version 300 es
            out float v_polylineAngle; out vec2 uv;
            void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
                uv=p; v_polylineAngle=0.0; gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;
        const fs = `#version 300 es
            precision highp float; in vec2 uv; out vec4 outputColor;
            const float czm_pixelRatio = 1.0;
            struct czm_materialInput { vec2 st; };
            struct czm_material { vec3 diffuse; vec3 emission; float alpha; };
            czm_material czm_getDefaultMaterial(czm_materialInput i) { return czm_material(vec3(0),vec3(0),0.0); }
            ${LINK_FLOW_SOURCE}
            void main() { czm_material m=czm_getMaterial(czm_materialInput(uv)); outputColor=vec4(m.diffuse,1.0); }`;
        const program = gl.createProgram(); gl.attachShader(program,compile(gl.VERTEX_SHADER,vs));
        gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fs)); gl.linkProgram(program);
        if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
        gl.useProgram(program); gl.bindVertexArray(gl.createVertexArray());
        gl.uniform4f(gl.getUniformLocation(program,'color'),0,0,0,0);
        gl.uniform4f(gl.getUniformLocation(program,'downColor'),1,0,0,1);
        gl.uniform4f(gl.getUniformLocation(program,'upColor'),0,0,1,1);
        gl.uniform1f(gl.getUniformLocation(program,'spacing'),96);
        const sample = time => {
            gl.uniform1f(gl.getUniformLocation(program,'time'),time); gl.drawArrays(gl.TRIANGLES,0,3);
            const rgba = new Uint8Array(384*4); gl.readPixels(0,4,384,1,gl.RGBA,gl.UNSIGNED_BYTE,rgba);
            return [0,2].map(channel => Array.from({length:96},(_,x)=>rgba[(96+x)*4+channel]));
        };
        return {before:sample(0), after:sample(.25)};
    }''', module_url(ROOT / 'digital_twin/visualization/link_flow.js'))
    assert result is not None, 'WebGL2 is needed for the packet shader regression'
    peak = lambda values: max(range(len(values)), key=values.__getitem__)
    shifts = [(peak(after) - peak(before) + 48) % 96 - 48
              for before, after in zip(result['before'], result['after'])]
    assert 21 <= shifts[0] <= 27, 'Forward highlights must move about 24 screen pixels'
    assert -22 <= shifts[1] <= -16, 'Return highlights must move in the opposite direction'
