import { api } from "/static/communication/api.js";
import { drawSparkline, pushHistory } from "/static/visualization/charts.js";
import { emit, store } from "../state.js";

const $=(selector)=>document.querySelector(selector);
let localLogs=[];
let lastPreflight=null;
let sequenceRunning=false;

function log(message,type="success") { localLogs.unshift({time:new Date().toISOString().slice(11,19),message,type});localLogs=localLogs.slice(0,60);renderLogs(); }

function renderDevices(){
  $("#device-list").innerHTML=store.devices.map((device)=>`<article class="device-item" data-device-id="${device.id}"><div class="device-head"><span class="status-dot ${device.connected?device.health>=85?"ok":"warning":"danger"}"></span><span class="item-body"><b>${device.name}</b><small>${device.role} · ${device.protocol||"—"} · ${device.mode||"—"}</small></span><span class="badge ${device.connected?"success":"danger"}">${device.connected?"ONLINE":"OFFLINE"}</span></div><div class="device-channel-row"><span>${device.channels||0} ch</span><span>${device.clock_state||"UNSYNC"}</span><span>${device.clock_offset_us==null?"—":device.clock_offset_us+" µs"}</span></div><div class="device-health"><i style="width:${device.health}%;background:${device.health>=85?'var(--green)':device.health>=60?'var(--orange)':'var(--red)'}"></i></div><div class="device-actions"><button class="button tiny ${device.connected?'ghost':'primary'}" data-device-action="${device.connected?'disconnect':'connect'}">${device.connected?'분리':'연결'}</button><button class="button tiny ghost" data-device-action="sync" ${device.connected?'':'disabled'}>Sync</button><button class="button tiny ghost" data-device-action="loopback" ${device.connected?'':'disabled'}>Loopback</button></div></article>`).join("");
  $("#device-list").querySelectorAll("[data-device-action]").forEach((button)=>button.addEventListener("click",()=>{const deviceId=button.closest("[data-device-id]").dataset.deviceId;deviceAction(deviceId,button.dataset.deviceAction);}));
}

function renderGateway(){
  const svg=$("#hil-svg"); const center={x:500,y:300};
  const positions=[[150,115],[150,280],[150,445],[850,115],[850,280],[850,445]];
  const lines=store.devices.map((device,index)=>{const [x,y]=positions[index]||positions[0];return `<line class="hil-link ${device.connected?'active':'offline'}" x1="${x+(x<center.x?100:-100)}" y1="${y}" x2="${center.x+(x<center.x?-105:105)}" y2="${center.y}"/>`;}).join("");
  const nodes=store.devices.map((device,index)=>{const [x,y]=positions[index]||positions[0];return `<g class="hil-node" transform="translate(${x},${y})" data-hil-node="${device.id}"><rect x="-100" y="-38" width="200" height="76" rx="6"/><circle cx="-76" cy="0" r="7" fill="${device.connected?'#12a36d':'#e75555'}"/><text x="-58" y="-3">${device.name}</text><text class="hil-node-subtitle" x="-58" y="17" font-size="9" font-weight="500">${device.role}</text></g>`;}).join("");
  const core=`<g class="hil-node core" transform="translate(${center.x},${center.y})"><rect x="-105" y="-64" width="210" height="128" rx="8"/><text y="-8" text-anchor="middle" font-size="18">EM-HIL</text><text y="18" text-anchor="middle" font-size="18">GATEWAY</text><text class="hil-node-subtitle" y="42" text-anchor="middle" font-size="9" font-weight="500">SYNC · MAPPER · SAFETY</text></g>`;
  svg.innerHTML=`<defs><pattern id="hilDots" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="var(--diagram-grid)"/></pattern></defs><rect width="1000" height="590" fill="url(#hilDots)" opacity=".45"/>${lines}${nodes}${core}`;
  svg.querySelectorAll("[data-hil-node]").forEach((node)=>node.addEventListener("click",()=>{store.selectedDevice=node.dataset.hilNode;const device=store.devices.find((d)=>d.id===store.selectedDevice);emit("toast",{type:device.connected?"success":"warning",title:device.name,message:`${device.role} · Health ${device.health}%`});}));
}

function renderLogs(){
  const events=(store.events||[]).filter((e)=>e.type?.startsWith("hil.")).map((e)=>({time:e.wall_time?.slice(11,19),message:e.message,type:e.severity==="warning"?"warning":"success"}));
  const rows=[...localLogs,...events].slice(0,30);
  $("#hil-log").innerHTML=(rows.length?rows:[{time:"--:--:--",message:"기록 이벤트 없음",type:"warning"}]).map((item)=>`<div class="terminal-line ${item.type}"><time>${item.time}</time><span>${item.message}</span></div>`).join("");
}

async function deviceAction(deviceId,action){
  try{const updated=await api.deviceAction(deviceId,action);const index=store.devices.findIndex((d)=>d.id===updated.id);store.devices[index]=updated;renderDevices();renderGateway();log(`${deviceId} ${action} complete`);await runPreflight(false);emit("toast",{type:"success",title:"HIL 명령 완료",message:`${deviceId} · ${action}`});}
  catch(error){log(`${deviceId} ${action} failed: ${error.message}`,"error");emit("toast",{type:"error",title:"HIL 명령 실패",message:error.message});}
}

async function allAction(action){for(const device of store.devices.filter((d)=>d.connected)){await deviceAction(device.id,action);}}

async function runPreflight(showToast=true){
  try{lastPreflight=await api.hilPreflight();const chip=$("#hil-readiness");chip.innerHTML=`<span class="status-dot ${lastPreflight.passed?'ok':'warning'}"></span>${lastPreflight.status} · ${lastPreflight.mode}`;$("#preflight-checks").innerHTML=lastPreflight.checks.map((check)=>`<span class="${check.passed?'':'failed'}">${check.passed?'✓':'×'} ${check.name}<small>${check.value}</small></span>`).join("");if(showToast)emit("toast",{type:lastPreflight.passed?'success':'warning',title:`Preflight ${lastPreflight.status}`,message:`${lastPreflight.checks.filter((c)=>c.passed).length}/${lastPreflight.checks.length} checks`});return lastPreflight;}catch(error){emit("toast",{type:"error",title:"Preflight 실패",message:error.message});}
}

async function runSequence(){if(sequenceRunning)return;sequenceRunning=true;$("#run-sequence").disabled=true;$("#sequence-progress").classList.add("running");$("#sequence-progress b").textContent="실행";try{const result=await api.hilSequence("closed_loop");result.steps.forEach((step)=>log(`${step.id} ${step.name} ${step.status}`,step.status==="passed"?"success":"error"));$("#sequence-progress").classList.remove("running");$("#sequence-progress").classList.toggle("failed",result.status!=="completed");$("#sequence-progress i").style.width="100%";$("#sequence-progress b").textContent=result.status.toUpperCase();await runPreflight(false);emit("toast",{type:result.status==="completed"?"success":"warning",title:"시험 시퀀스",message:`${result.sequence_id} · ${result.status}`});}catch(error){emit("toast",{type:"error",title:"시퀀스 실패",message:error.message});}finally{sequenceRunning=false;$("#run-sequence").disabled=false;}}

async function toggleRecording(){const enabled=!store.runtime.recording;try{const result=await api.recording(enabled);store.runtime.recording=result.recording;updateRecordingButton();log(`recording ${result.recording?'started':'stopped'}`,result.recording?'success':'warning');await runPreflight(false);}catch(error){emit("toast",{type:"error",title:"기록 제어 실패",message:error.message});}}

function updateRecordingButton(){const button=$("#recording-toggle");button.textContent=store.runtime.recording?"● REC":"○ REC OFF";button.classList.toggle("danger",store.runtime.recording);button.classList.toggle("ghost",!store.runtime.recording);}

function bind(){
  $("#sync-all").addEventListener("click",()=>allAction("sync"));
  $("#hil-preflight").addEventListener("click",()=>runPreflight(true));
  $("#run-sequence").addEventListener("click",runSequence);
  $("#recording-toggle").addEventListener("click",toggleRecording);
  $("#loopback-all").addEventListener("click",()=>allAction("loopback"));
  $("#clear-hil-log").addEventListener("click",()=>{localLogs=[];store.events=store.events.filter((e)=>!e.type?.startsWith("hil."));renderLogs();});
  $("#device-refresh").addEventListener("click",()=>{renderDevices();renderGateway();log("device registry refreshed");});
}

export function initHil(){renderDevices();renderGateway();renderLogs();bind();window.addEventListener("spacetwin:themechange",renderGateway);updateRecordingButton();runPreflight(false);}
export function updateHilTelemetry(payload){if(payload.devices)store.devices=payload.devices;if(payload.events)store.events=payload.events;store.runtime=payload.runtime||store.runtime;if(store.activeTab==="hil"){renderDevices();renderGateway();renderLogs();}const online=store.devices.filter((d)=>d.connected);const avg=online.length?online.reduce((a,d)=>a+d.latency_ms,0)/online.length:0;const offsets=online.map((d)=>Number(d.clock_offset_us||0));const jitters=online.map((d)=>Number(d.jitter_us||0));const allLocked=online.length>0&&online.every((d)=>d.clock_state==="LOCKED");$("#clock-state").textContent=allLocked?"LOCKED":online.some((d)=>d.clock_state==="LOCKING")?"LOCKING":"UNSYNC";$("#clock-state").className=`badge ${allLocked?'success':'warning'}`;$("#clock-offset").textContent=`${Math.max(...offsets,0).toFixed(1)} µs`;$("#clock-jitter").textContent=`${Math.max(...jitters,0).toFixed(1)} µs`;$("#hil-latency").textContent=`${avg.toFixed(1)} ms`;$("#io-ingest").textContent=`${(3.8+(payload.telemetry?.throughput_mbps||0)/100).toFixed(1)}k/s`;$("#io-command").textContent=`${Math.round(30+(payload.runtime?.sequence||0)%17)}/s`;$("#io-error").textContent=String(store.devices.filter((d)=>!d.connected).length);$("#io-channels").textContent=String(store.devices.reduce((sum,d)=>sum+(d.channels||0),0));updateRecordingButton();drawSparkline($("#io-chart"),pushHistory("hil-io",payload.telemetry?.throughput_mbps||0),"#2d7ff9");}
