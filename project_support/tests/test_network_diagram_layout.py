"""Browser checks for the diagram's card legibility and link-label placement."""
import base64
from pathlib import Path

import pytest

playwright = pytest.importorskip('playwright.sync_api')
ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize('theme', ['dark', 'light'])
def test_ring_cards_keep_long_names_inside_and_preserve_full_accessible_names(theme):
    with playwright.sync_playwright() as driver:
        try:
            browser = driver.chromium.launch()
        except playwright.Error as error:
            if "Executable doesn't exist" in str(error):
                pytest.skip('Install Playwright Chromium to run UI tests')
            raise
        page = browser.new_page(viewport={'width': 1200, 'height': 800})
        css = (ROOT / 'user_application/web/styles/communication.css').read_text(encoding='utf-8')
        page.set_content(f'<html data-theme="{theme}"><style>{css}</style><div id="host"></div></html>')
        source = (ROOT / 'digital_twin/visualization/network_diagram.js').read_bytes()
        result = page.evaluate('''async url => {
            const {layoutNetwork,diagramMarkup} = await import(url);
            const names = ['ODT-123456789012345', '대한민국초장문시험위성'];
            const satellites = Array.from({length:12},(_,i)=>({id:String(i),name:names[i%2],formation:{id:'F',plane:0,index:i}}));
            const layout = layoutNetwork({satellites,stations:[{id:'GS',name:'아주긴이름의지상국관제센터'}]});
            document.querySelector('#host').innerHTML = diagramMarkup(layout,[{id:'L',a:'0',b:'11',kind:'oisl',usable:true,quality:90}],
                {selected:{type:'link',id:'L'},nodeStates:new Map([['0',{badge:'1,234 MB'}]])});
            const nodes = [...document.querySelectorAll('.nd-node')];
            const fits = nodes.every(node=> {
                const box = node.querySelector('.body').getBBox();
                return [...node.querySelectorAll('.label,.badge')].every(label=>{
                    const b=label.getBBox();
                    return b.x>=box.x+3 && b.x+b.width<=box.x+box.width-3 && b.y>=box.y && b.y+b.height<=box.y+box.height;
                });
            });
            const path = document.querySelector('[data-diagram-link="L"] .line');
            const midpoint=path.getPointAtLength(path.getTotalLength()/2);
            const pill=document.querySelector('[data-diagram-link="L"] .nd-pill').transform.baseVal.consolidate().matrix;
            const pillBox=document.querySelector('.nd-pill rect').getBoundingClientRect();
            const pillClear=nodes.every(node=>{
                const b=node.querySelector('.body').getBoundingClientRect();
                return pillBox.right<=b.left || pillBox.left>=b.right || pillBox.bottom<=b.top || pillBox.top>=b.bottom;
            });
            return {fits, count:nodes.length, name:nodes[0].getAttribute('aria-label'),
                pillClear,
                midpointError:Math.hypot(pill.e-midpoint.x,pill.f-midpoint.y),
                glow:getComputedStyle(nodes[0].querySelector('.body')).filter};
        }''', 'data:text/javascript;base64,' + base64.b64encode(source).decode())
        assert result['fits'], 'Visible names and badges must stay within the compact node cards'
        assert result['count'] == 13
        assert result['name'] == 'ODT-123456789012345'
        assert result['pillClear'], 'Link quality labels must not overlap satellite cards'
        assert result['midpointError'] < 35, 'The quality label stays beside the curved link, not inside the ring'
        assert result['glow'] == 'none'
        browser.close()
