import test from 'node:test';
import assert from 'node:assert/strict';

test('polling cancels on exit, ignores late results and retains external failure diagnostics',async()=>{
  const originals = Object.fromEntries(['document','window','location','fetch','setTimeout','clearTimeout','setInterval','clearInterval'].map(k=>[k,globalThis[k]]));
  const elements = new Map(), timers = new Map(), calls = []; let nextTimer=0;
  globalThis.document={hidden:false,getElementById(id){if(!elements.has(id)) elements.set(id,{textContent:'',innerHTML:'',dataset:{}});return elements.get(id);},addEventListener(){}};
  globalThis.window={addEventListener(){}}; globalThis.location={protocol:'http:'};
  globalThis.setTimeout=(fn,delay)=>{timers.set(++nextTimer,{fn,delay});return nextTimer;};
  globalThis.clearTimeout=id=>timers.delete(id);globalThis.setInterval=()=>0;globalThis.clearInterval=()=>{};
  globalThis.fetch=(url,options)=>new Promise(resolve=>calls.push({url,options,resolve}));
  const flush=async()=>{for(let i=0;i<10;i++) await Promise.resolve();};
  try {
    const ui=await import('../../../user_application/web/scripts/tabs/security.js?lifecycle');
    ui.initSecurity();ui.updateSecuritySocket('open');ui.updateSecurityTelemetry({runtime:{run_id:'R1',running:true}});
    ui.setSecurityActive(true);assert.equal(calls.length,1);
    ui.setSecurityActive(false);assert.equal(calls[0].options.signal.aborted,true);
    calls[0].resolve({ok:true,json:async()=>({runtime:{run_id:'R1'},module:{reachable:true},overview:{observation:{run_id:'OLD'}}})});await flush();
    assert.equal(elements.get('security-run').textContent,'—');assert.equal(timers.size,0);
    ui.setSecurityActive(true);assert.equal(calls.length,2);
    calls[1].resolve({ok:false,json:async()=>({module:{reachable:false,placement:'remote',endpoint:'http://security.example',detail:'외부 모듈 응답 없음'},overview:null})});await flush();
    assert.equal(elements.get('security-placement').textContent,'외부 HTTP 모듈');
    assert.equal(elements.get('security-endpoint').textContent,'http://security.example');
    assert.equal(elements.get('security-flow').dataset.moving,'false');
    assert.match(elements.get('security-evidence').textContent,/외부 모듈 응답 없음/);
    assert.equal([...timers.values()].filter(t=>t.delay===2000).length,1);
    ui.setSecurityActive(false);assert.equal(timers.size,0);
  }finally{for(const [key,value] of Object.entries(originals))globalThis[key]=value;}
});
