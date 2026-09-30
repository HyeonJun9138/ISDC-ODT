import { api, telemetrySocket } from "/static/communication/api.js?v=20260907-2";
import { emit, on, setState, store } from "./state.js";
import { loading } from "./loading.js";
import { initOrbit, updateOrbitTelemetry } from "./tabs/orbit.js?v=20260908-oisl-flow1";
import { initCommunication, updateCommunicationTelemetry } from "./tabs/communication.js?v=20260908-scenario1";
import { initDataManagement, updateDataManagementTelemetry } from "./tabs/data_management.js?v=20260908-deployment1";
import { initMission, updateMissionTelemetry } from "./tabs/mission.js?v=20260908-scenario2";
import { initNodes, updateNodesTelemetry } from "./tabs/nodes.js?v=20260908-scenario1";
import { initStatus, updateStatusTelemetry } from "./tabs/status.js";
import { initSecurity, setSecurityActive, updateSecurityTelemetry, updateSecuritySocket } from "./tabs/security.js?v=20260908-1";
import { initSettings, updateSettingsTelemetry } from "./tabs/settings.js?v=20260908-scenario1";
import { initScenario, setScenarioActiveTab, updateScenarioTelemetry } from "./scenario/console.js?v=20260908-scenario3";

const $=(selector)=>document.querySelector(selector);
const THEME_KEY="spacetwin-theme";

function switchTab(tab){
  store.activeTab=tab;
  setSecurityActive(tab==="security");
  document.querySelectorAll(".nav-tab").forEach((button)=>button.classList.toggle("active",button.dataset.tabTarget===tab));
  document.querySelectorAll(".tab-view").forEach((view)=>view.classList.toggle("active",view.dataset.view===tab));
  const cesiumContainer=$("#cesium-container");
  if(cesiumContainer)cesiumContainer.style.visibility=tab==="orbit"?"visible":"hidden";
  setScenarioActiveTab(tab);
}

function bindNavigation(){
  document.querySelectorAll("[data-tab-target]").forEach((button)=>button.addEventListener("click",()=>switchTab(button.dataset.tabTarget)));
  $("#fullscreen-button").addEventListener("click",async()=>{try{if(!document.fullscreenElement)await document.documentElement.requestFullscreen();else await document.exitFullscreen();}catch(error){toast({type:"error",title:"전체화면 오류",message:error.message});}});
  $("#theme-toggle").addEventListener("click",()=>applyTheme(document.documentElement.dataset.theme==="dark"?"light":"dark"));
}

function updateClock(){const now=new Date();$("#utc-clock").textContent=now.toISOString().slice(11,19);}

function toast({type="success",title="알림",message=""}){
  const item=document.createElement("div");item.className=`toast ${type}`;item.innerHTML=`<b>${title}</b><small>${message}</small>`;$("#toast-region").append(item);setTimeout(()=>{item.style.opacity="0";item.style.transform="translateY(8px)";setTimeout(()=>item.remove(),250);},3600);
}

function applyTheme(theme,{persist=true}={}){
  const next=theme==="dark"?"dark":"light";
  document.documentElement.dataset.theme=next;
  document.documentElement.style.colorScheme=next;
  const button=$("#theme-toggle");
  if(button){
    const dark=next==="dark";
    button.textContent=dark?"☀":"☾";
    button.title=dark?"라이트 모드":"다크 모드";
    button.setAttribute("aria-label",dark?"라이트 모드로 전환":"다크 모드로 전환");
    button.setAttribute("aria-pressed",String(dark));
  }
  $("#theme-color")?.setAttribute("content",next==="dark"?"#080d14":"#e9eef5");
  if(persist)localStorage.setItem(THEME_KEY,next);
  window.dispatchEvent(new CustomEvent("spacetwin:themechange",{detail:{theme:next}}));
  requestAnimationFrame(()=>window.dispatchEvent(new Event("resize")));
}

function bindFaultDialog(){
  $("#fault-form").addEventListener("submit",async(event)=>{
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    const payload={target:form.get("target"),kind:form.get("kind"),severity:form.get("severity"),duration_seconds:Number(form.get("duration_seconds"))};
    try{const fault=await api.injectFault(payload);$("#fault-dialog").close();toast({type:"warning",title:"장애 주입 완료",message:`${fault.target} · ${fault.kind} · ${fault.duration_seconds}s`});}
    catch(error){toast({type:"error",title:"장애 주입 실패",message:error.message});}
  });
}

function routeTelemetry(payload){
  updateSecurityTelemetry(payload);
  loading.report("telemetry",1);
  setState({runtime:payload.runtime||store.runtime,telemetry:payload.telemetry||{},events:payload.events||store.events,devices:payload.devices||store.devices,missions:payload.missions||store.missions},"telemetry");
  const runtime=payload.runtime||store.runtime;
  $("#run-mode").textContent=runtime.mode||"SIM"; $("#run-id").textContent=runtime.run_id||"RUN-—"; $("#run-context").textContent=`${runtime.scenario_id||"SCN"} · v${runtime.scenario_version||"—"} · ${runtime.data_quality||"UNKNOWN"}`; $("#record-dot").classList.toggle("off",!runtime.recording);
  updateOrbitTelemetry(payload);updateNodesTelemetry(payload);updateCommunicationTelemetry(payload);updateDataManagementTelemetry(payload);updateMissionTelemetry(payload);updateStatusTelemetry(payload);updateSettingsTelemetry(payload);updateScenarioTelemetry(payload);
}

function socketStatus(status){
  updateSecuritySocket(status);
  setState({socket:status},"socket");
  if(status==="open")toast({type:"success",title:"실시간 스트림 연결",message:"WebSocket telemetry online"});
  if(status==="closed"||status==="error")toast({type:"warning",title:"실시간 스트림 재연결",message:"연결 상태를 확인하세요."});
}

async function bootstrap(){
  try{
    const payload=await api.bootstrap();
    loading.report("bootstrap",1);
    setState({runtime:payload.runtime,scenarios:payload.scenarios,communication:payload.communication,missions:payload.missions,analytics:payload.analytics,devices:payload.devices,events:payload.events},"bootstrap");
    const orbitReady=initOrbit();initNodes();initCommunication();initDataManagement();initMission();initStatus();initSecurity();initSettings({api});initScenario();
    telemetrySocket(routeTelemetry,socketStatus);
    await orbitReady;
    loading.finish();
    toast({type:"success",title:"SpaceTwin VVP 준비 완료",message:"모든 운용 모듈이 초기화되었습니다."});
  }catch(error){
    console.error(error);loading.fail(`초기화 실패: ${error.message}`);toast({type:"error",title:"초기화 실패",message:error.message});
    $("#globe-loading").innerHTML=`<strong>초기화 실패</strong><small>${error.message}</small>`;
  }
}

on("toast",toast);
// The scenario player and its guide move the console between tabs.
on("tab:switch",(tab)=>{if(document.querySelector(`.tab-view[data-view="${tab}"]`))switchTab(tab);});
applyTheme(document.documentElement.dataset.theme,{persist:false});
bindNavigation();bindFaultDialog();
updateClock();setInterval(updateClock,1000);
switchTab("orbit");
bootstrap();
