import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function fixture(fetchDashboard) {
  let source=await readFile(new URL('../../../user_application/web/scripts/tabs/data_management.js',import.meta.url),'utf8');
  const vm=new URL('../../../user_application/web/scripts/data_management/view_model.js',import.meta.url).href;
  source=source.replace(/import \{ api \} from [^;]+;/, 'const api=globalThis.__dmApi;')
    .replace(/import \{ drawSparkline, history, pushHistory \} from [^;]+;/, 'const histories=new Map(); const history=k=>histories.get(k)||[]; const pushHistory=(k,v)=>{const a=history(k);a.push(v);histories.set(k,a)}; const drawSparkline=()=>{};')
    .replace(/import \{ emit, on, store \} from [^;]+;/, 'const store={runtime:{run_id:"R1"}}; const emit=()=>{}; const on=()=>()=>{};')
    .replace(/import \{ escapeMarkup as esc \} from [^;]+;/, 'const esc=String;')
    .replace('"../data_management/view_model.js"',JSON.stringify(vm));
  source+='\nrender=()=>{}; renderControls=()=>{}; active=true; export {refresh,invalidateDeployment,runAction,renderNodes}; export const inspect=()=>({events,eventCursor,scopeId,dashboard,histories}); export const exitTab=()=>{active=false;epoch++}; export const setQueryError=value=>{queryError=value};';
  globalThis.__dmApi={dataManagementDashboard:fetchDashboard};
  globalThis.document={querySelector:()=>null};
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Math.random()}`);
}
const report=(scope,revision,items,latest)=>({deployment:{scope_id:scope,revision,run_id:'R1',nodes:[]},runtime:{run_id:'R1'},nodes:[],objects:{items:[],total:0},events:{items,latest},overview:{metrics:{ingest_mbps:revision}}});
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};

test('new remote deployment reloads events from zero instead of losing its initial events',async()=>{
  const requests=[]; let round=0;
  const ui=await fixture(async params=>{
    requests.push({...params}); round++;
    if(round===1)return report('A',1,[{sequence:100,message:'old'}],100);
    return report('B',2,params.after===0?[{sequence:1,message:'new'}]:[],1);
  });
  await ui.refresh();await ui.refresh();await flush();
  assert.deepEqual(requests.map(p=>p.after),[0,100,0]);
  assert.equal(ui.inspect().events.length,1);
  assert.equal(ui.inspect().events[0].message,'new');
  assert.deepEqual(ui.inspect().histories.get('dm-ingest'),[2]);
});

test('accepted deployment invalidates late dashboard and resets the visible scope',async()=>{
  const calls=[]; const ui=await fixture(params=>new Promise(resolve=>calls.push({params,resolve})));
  const pending=ui.refresh();
  ui.invalidateDeployment({scope_id:'B',run_id:'R1',revision:2,nodes:[]});
  calls[0].resolve(report('A',1,[{sequence:100}],100));await pending;await flush();
  assert.equal(calls.length,2);assert.equal(calls[1].params.after,0);
  assert.equal(ui.inspect().events.length,0);
  calls[1].resolve(report('B',2,[],0));await flush();
  assert.equal(ui.inspect().scopeId,'B');
});

test('tab exit ignores an outstanding response',async()=>{
  let resolve;const ui=await fixture(()=>new Promise(r=>resolve=r));
  const pending=ui.refresh();ui.exitTab();resolve(report('A',1,[{sequence:1}],1));await pending;
  assert.equal(ui.inspect().dashboard,null);
});

test('empty node list removes temporary synchronization error after recovery',async()=>{
  const ui=await fixture(async()=>report('A',1,[],0));await ui.refresh();
  const elements=new Map();globalThis.document={querySelector:s=>{if(!elements.has(s))elements.set(s,{});return elements.get(s);}};
  ui.setQueryError('동기화 중');ui.renderNodes();
  assert.match(elements.get('#dm-nodes').innerHTML,/실패/);
  ui.setQueryError('');ui.renderNodes();
  assert.match(elements.get('#dm-nodes').innerHTML,/배치된 SDC/);
  assert.doesNotMatch(elements.get('#dm-nodes').innerHTML,/실패/);
});
