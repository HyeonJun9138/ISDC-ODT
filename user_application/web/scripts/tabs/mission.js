import { api } from "/static/communication/api.js";
import { currentMission, emit, store } from "../state.js";

const $ = (selector) => document.querySelector(selector);
const laneIcon = { "관측": "◉", "처리": "▦", "저장": "▤", "전송": "⌁", "검증": "◆" };
let conflictTaskIds = new Set();

function statusBadge(status) {
  const map = { running: ["RUN","success"], planned:["PLAN","warning"], idle:["IDLE","info"], paused:["PAUSE","warning"], aborted:["ABORT","danger"], completed:["COMP","success"] };
  return map[status] || [status.toUpperCase(), "info"];
}

function renderMissionList() {
  $("#mission-list").innerHTML = store.missions.map((mission) => {
    const [label, cls] = statusBadge(mission.status);
    return `<button class="list-item ${store.selectedMission===mission.id?"active":""}" data-mission-id="${mission.id}"><span class="status-dot ${mission.status==="running"?"ok":mission.status==="aborted"?"danger":"warning"}"></span><span class="item-body"><b>${mission.name}</b><small>${mission.id} · ${mission.progress}%</small></span><span class="badge ${cls}">${label}</span></button>`;
  }).join("");
  $("#mission-list").querySelectorAll("[data-mission-id]").forEach((button)=>button.addEventListener("click",()=>{store.selectedMission=button.dataset.missionId;renderAll();}));
}

function renderTimeline() {
  const mission=currentMission(); const lanes=["관측","처리","저장","전송","검증"];
  $("#mission-timeline").innerHTML=lanes.map((lane)=>{
    const tasks=(mission?.tasks||[]).filter((task)=>task.lane===lane);
    return `<div class="timeline-lane"><span class="lane-name"><i>${laneIcon[lane]}</i>${lane}</span>${tasks.map((task)=>`<button class="task-card ${task.status} ${conflictTaskIds.has(task.id)?"conflict":""}" style="left:calc(105px + ${task.start*.86}%);width:${Math.max(7,task.duration*.86)}%" data-task-id="${task.id}"><b>${task.name}</b><small>T+${task.start} · ${task.duration}%${task.predecessor?` · ←${task.predecessor}`:""}</small></button>`).join("")}</div>`;
  }).join("");
  $("#mission-timeline").querySelectorAll("[data-task-id]").forEach((button)=>button.addEventListener("click",()=>openTaskDialog((mission.tasks||[]).find((task)=>task.id===button.dataset.taskId))));
}

function renderResources() {
  const resources=currentMission()?.resources||{}; const labels={power:["ϟ","전력"],link:["⌁","링크"],compute:["▦","연산"],storage:["▤","저장소"]};
  $("#mission-resources").innerHTML=Object.entries(labels).map(([key,[icon,label]])=>{const value=resources[key]||0;return `<article class="resource-card"><div class="resource-top"><span>${icon} <b>${label}</b></span><strong>${value}%</strong></div><div class="resource-bar"><i style="width:${value}%;background:${value>85?'var(--red)':value>70?'var(--orange)':'var(--blue)'}"></i></div></article>`;}).join("");
}

function renderConditions() {
  const mission=currentMission(); const conditions=mission?.success_conditions||[];
  $("#success-condition-list").innerHTML=conditions.map((item,index)=>{const passed=mission.status==="completed"||mission.progress>=(index+1)*30;return `<div class="check-item ${passed?"":"pending"}"><i>${passed?"✓":"·"}</i><span>${item}</span><small>${passed?"충족":"평가 대기"}</small></div>`;}).join("")||`<div class="empty-state">성공 조건 없음</div>`;
}

function renderSummary() {
  const mission=currentMission(); if(!mission)return;
  $("#mission-ring").style.setProperty("--value",mission.progress); $("#mission-ring strong").textContent=`${mission.progress}%`;
  $("#mission-start").textContent=mission.status==="running"?"일시정지":"실행";
  $("#plan-version").textContent=`PLAN v${mission.plan_version||1}`;
}

function renderDecisionLog() {
  const events=(store.events||[]).filter((item)=>item.type?.startsWith("mission")||item.type?.startsWith("fault")).slice(0,8);
  const fallback=[
    ["03:30:12","자동","전송(X-Band)","시작 시간 조정","적용"], ["08:15:47","자동","연산","우선순위 상향","성공"], ["15:05:22","사용자","저장","백업 추가 실행","적용"], ["20:10:05","자동","검증","검증 항목 추가","적용"],
  ];
  $("#decision-log-body").innerHTML=(events.length?events.map((e)=>[e.wall_time?.slice(11,19),e.type.includes("replan")?"자동":"시스템",e.payload?.mission_id||currentMission()?.id,e.message,e.severity]):fallback).map((row)=>`<tr><td>${row[0]}</td><td>${row[1]}</td><td>${row[2]}</td><td>${row[3]}</td><td><span class="badge ${row[4]==="warning"?"warning":"success"}">${row[4]==="warning"?"경고":row[4]}</span></td></tr>`).join("");
}

function renderAll(){renderMissionList();renderTimeline();renderResources();renderConditions();renderSummary();renderDecisionLog();}

function openTaskDialog(task=null){
  $("#task-dialog-title").textContent=task?`${task.id} 작업 편집`:"새 작업"; $("#task-id").value=task?.id||""; $("#task-name").value=task?.name||""; $("#task-lane").value=task?.lane||"관측"; $("#task-status").value=task?.status||"planned"; $("#task-start").value=task?.start??10; $("#task-duration").value=task?.duration??10; $("#task-predecessor").value=task?.predecessor||""; $("#task-priority").value=task?.priority||5; $("#task-delete").hidden=!task; $("#task-dialog").showModal();
}

async function saveTask(operation="update"){
  const mission=currentMission(); const taskId=$("#task-id").value||null;
  const payload={mission_id:mission.id,task_id:taskId,operation:taskId?operation:"create",name:$("#task-name").value.trim(),lane:$("#task-lane").value,status:$("#task-status").value,start:Number($("#task-start").value),duration:Number($("#task-duration").value),predecessor:$("#task-predecessor").value.trim()||null,priority:Number($("#task-priority").value)};
  if(operation==="delete")Object.assign(payload,{operation:"delete",name:null,lane:null,status:null,start:null,duration:null,predecessor:null,priority:null});
  try{const result=await api.missionTask(payload);const index=store.missions.findIndex((item)=>item.id===result.mission.id);store.missions[index]=result.mission;conflictTaskIds=new Set(result.validation.conflicts.flatMap((item)=>item.task_ids||[]));$("#task-dialog").close();renderAll();emit("toast",{type:result.validation.valid?"success":"warning",title:`작업 ${operation}`,message:`PLAN v${result.mission.plan_version} · 충돌 ${result.validation.conflict_count}`});}
  catch(error){emit("toast",{type:"error",title:"작업 저장 실패",message:error.message});}
}

async function validatePlan(){try{const result=await api.validateMission(currentMission().id);conflictTaskIds=new Set(result.conflicts.flatMap((item)=>item.task_ids||[]));renderTimeline();emit("toast",{type:result.valid?"success":"warning",title:result.valid?"계획 검증 통과":`충돌 ${result.conflict_count}건`,message:result.valid?`PLAN v${result.plan_version}`:result.conflicts.map((item)=>item.message).join(" · ")});return result;}catch(error){emit("toast",{type:"error",title:"계획 검증 실패",message:error.message});}}

async function replan(){try{const result=await api.replanMission(currentMission().id,true);const index=store.missions.findIndex((item)=>item.id===result.mission.id);store.missions[index]=result.mission;conflictTaskIds=new Set(result.validation.conflicts.flatMap((item)=>item.task_ids||[]));renderAll();emit("toast",{type:result.validation.valid?"success":"warning",title:"재계획 적용",message:`${result.diff.length}개 작업 이동 · PLAN v${result.mission.plan_version}`});}catch(error){emit("toast",{type:"error",title:"재계획 실패",message:error.message});}}

async function action(action) {
  const mission=currentMission(); if(!mission)return;
  try { const updated=await api.missionAction(mission.id,action); const index=store.missions.findIndex((item)=>item.id===updated.id); store.missions[index]=updated; renderAll(); emit("toast",{type:action==="abort"?"warning":"success",title:"임무 명령",message:`${mission.id} · ${action}`}); }
  catch(error){emit("toast",{type:"error",title:"임무 명령 실패",message:error.message});}
}

function bind(){
  $("#mission-start").addEventListener("click",()=>action(currentMission()?.status==="running"?"pause":"start"));
  $("#mission-abort").addEventListener("click",()=>action("abort"));
  $("#mission-replan").addEventListener("click",replan);
  $("#mission-validate").addEventListener("click",validatePlan);
  $("#mission-add-task").addEventListener("click",()=>openTaskDialog(null));
  $("#task-form").addEventListener("submit",(event)=>{event.preventDefault();saveTask("update");});
  $("#task-delete").addEventListener("click",()=>saveTask("delete"));
  $("#export-decision-log").addEventListener("click",()=>{const blob=new Blob([$("#decision-log-body").innerText],{type:"text/plain;charset=utf-8"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="mission-decision-log.txt";a.click();URL.revokeObjectURL(a.href);});
}

export function initMission(){renderAll();bind();}
export function updateMissionTelemetry(payload){if(payload.missions)store.missions=payload.missions;if(payload.events)store.events=payload.events;if(store.activeTab==="mission")renderAll();}
