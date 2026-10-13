import type { Status } from './server.js';

/** Render a live local status page or a self-contained read-only export. */
export function statusHtml(snapshot?: Status): string {
  const initial = snapshot ? JSON.stringify(snapshot).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029') : 'null';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Werk · Worker status</title><style>
:root {
  color-scheme: dark;
  font: 16px/1.6 system-ui, sans-serif;
  background: #111b22;
  color: #edf4f7;
  --muted: #b5c4cd;
  --mint: #8be0b8;
  --line: #3b4b56;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --space-12: 48px;
  --space-page: var(--space-8);
  --space-panel: var(--space-6);
  --space-section: var(--space-8);
  --space-field: var(--space-4);
  --space-inline: var(--space-2);
  scrollbar-color: #667a88 #111b22;
}
* { box-sizing: border-box; }
body { max-width: 1020px; margin: auto; padding: var(--space-page); }
header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; border-bottom: 1px solid var(--line); padding-bottom: var(--space-6); }
.brand { font-size: 28px; font-weight: 750; letter-spacing: -.03em; }
.brand span { color: var(--mint); }
h1 { font-size: clamp(2rem, 5vw, 2.7rem); letter-spacing: -.03em; line-height: 1.15; margin: var(--space-section) 0 var(--space-3); }
h2 { font-size: 1.2rem; margin: var(--space-section) 0 var(--space-3); }
a { color: var(--mint); text-underline-offset: 4px; }
p, dt, footer { color: var(--muted); }
p { max-width: 75ch; margin: 0 0 var(--space-4); }
dd { margin: 0; overflow-wrap: anywhere; }
dl { display: grid; grid-template-columns: minmax(170px, 1fr) 2fr; gap: var(--space-3) var(--space-6); border-top: 1px solid var(--line); padding-top: var(--space-6); margin: 0; }
code, pre { overflow-wrap: anywhere; }
code { color: var(--mint); }
#error { color: var(--muted); min-height: 26px; overflow-wrap: anywhere; }
#error[data-kind=error] { color: #edc47e; }
.skip { position: absolute; top: -80px; padding: var(--space-3); background: var(--mint); color: #102219; }
.skip:focus { top: var(--space-2); }
.toolbar { display: flex; gap: var(--space-inline); align-items: center; flex-wrap: wrap; }
button { font: inherit; cursor: pointer; border: 1px solid var(--line); border-radius: 8px; background: #23333e; color: #edf4f7; padding: var(--space-2) var(--space-4); min-height: 44px; }
button:hover { background: #304350; }
button:disabled { opacity: .6; cursor: wait; }
.table-wrap { overflow: auto; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
td, th { text-align: left; border-bottom: 1px solid var(--line); padding: var(--space-3); overflow-wrap: anywhere; }
th { font-size: 14px; color: var(--muted); }
caption { text-align: left; color: var(--muted); padding-bottom: var(--space-3); }
.empty { color: var(--muted); text-align: center; padding: var(--space-panel); }
.summary { border-block: 1px solid var(--line); padding-block: var(--space-4); display: flex; gap: var(--space-3) var(--space-6); flex-wrap: wrap; }
.summary strong { font-weight: 600; }
.summary span { color: var(--muted); }
.slots { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:24px 0; }
.slot { padding:16px; background:#17262f; border:1px solid var(--line); border-radius:8px; overflow-wrap:anywhere; }
.slot strong,.slot small { display:block; }
.slot strong { color:var(--mint); }
.slot[data-busy=true] { border-color:#81b6ee; }
.slot small { color:var(--muted); }
.measurement-note { margin-top: var(--space-6); }
footer { border-top: 1px solid var(--line); padding-top: var(--space-6); margin-top: var(--space-section); font-size: 14px; }
:focus-visible { outline: 2px solid var(--mint); outline-offset: 4px; }
::selection { background: var(--mint); color: #111b22; }
[hidden] { display: none !important; }
@media (max-width: 760px) {
  :root { --space-page: var(--space-4); --space-panel: var(--space-4); --space-section: var(--space-6); }
  dl { grid-template-columns: minmax(0, 1fr); gap: var(--space-1); }
  dd { margin-bottom: var(--space-3); }
  td, th { min-width: 110px; }
}
</style></head><body><a class="skip" href="#main">Skip to content</a><header><div class="brand">werk<span>.</span></div><div class="toolbar"><a id="json-link" href="/status">JSON status</a><button id="refresh" type="button">Refresh now</button><button id="pause" type="button" aria-pressed="false">Pause updates</button></div></header><main id="main" tabindex="-1"><h1>Worker status</h1><p id="execution-note">Local process · read-only · execution mode pending. Provider profiles are configuration entries; this view does not verify subscription login or quota.</p><p id="error" role="status">Loading worker status…</p><div class="summary"><strong id="state-label">Status pending</strong><span id="capacity">No capacity data</span><span id="freshness">Waiting for first response</span></div><section aria-label="Worker execution slots"><div id="slot-map" class="slots"></div><p id="slot-map-note"></p></section><h2>Active attempts</h2><div class="table-wrap" tabindex="0" role="region" aria-label="Active attempts; scroll horizontally"><table><caption id="active-caption">Current process assignments</caption><thead><tr><th scope="col">Task</th><th scope="col">Attempt</th><th scope="col">Profile</th></tr></thead><tbody id="active-rows"></tbody></table></div><h2>Process & health</h2><dl id="values"></dl><h2>Configured profiles</h2><div class="table-wrap" tabindex="0" role="region" aria-label="Configured profiles; scroll horizontally"><table><thead><tr><th scope="col">Profile</th><th scope="col">Provider</th><th scope="col">Mode</th></tr></thead><tbody id="profile-rows"></tbody></table></div><p class="measurement-note" id="measurement-note">Completed simulations and heartbeat errors describe this process lifetime. The latest error is historical; current process state and last orchestrator contact show whether communication has recovered. A simulation is not an implemented feature or a completed PR. Snapshot files contain attempt measurements; process resources overlap when tasks run in parallel.</p></main><footer id="update-note">Refreshes every 3 seconds while this page is visible. A reachable status endpoint does not confirm a healthy connection to the orchestrator.</footer><script>
  const exported=${initial};
  const fields={workerId:'Worker ID',project:'Project',state:'Process state',completedSimulations:'Acknowledged simulations (this process)',completedReviews:'Acknowledged change sets (this process)',lastContact:'Last orchestrator contact',lastError:'Latest error',updatedAt:'State recorded at',configurationHash:'Configuration hash',lastSnapshot:'Latest snapshot artifact',heartbeatErrors:'Heartbeat errors (this process)'};
  const labels={starting:'Starting',idle:'Idle',executing:'Executing simulations',disconnected:'Orchestrator disconnected',stopping:'Stopping',stopped:'Stopped'};
  const byId=id=>document.getElementById(id);let inFlight=false,paused=false,lastFetched=null,lastFailure=false;
  const timestamp=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString():'Not recorded';
  function cell(row,value){const td=document.createElement('td');td.textContent=value??'—';row.append(td)}
  function empty(rows,text){const row=document.createElement('tr');cell(row,text);row.firstElementChild.colSpan=3;row.firstElementChild.className='empty';rows.append(row)}
  function render(data){
    const live=data.mode==='cli';
    byId('execution-note').textContent='Local process · read-only · '+(live?'Codex CLI execution: real changes in the configured workspace.':'mock execution: simulated attempts.')+' Provider profiles are configuration entries; this view does not verify subscription login or quota.';
    byId('measurement-note').textContent=(live?'Acknowledged change sets are pending human review. Build, tests and acceptance are not verified; no automatic push or merge.':'A simulation is not an implemented feature or a completed PR.')+' Simulation, change-set and heartbeat counters describe this process lifetime. The latest error is historical; current process state and last orchestrator contact show whether communication has recovered. Snapshot files contain attempt measurements; process resources overlap when tasks run in parallel.';
    const list=byId('values');list.replaceChildren();for(const [key,label] of Object.entries(fields)){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=['lastContact','updatedAt'].includes(key)?timestamp(data[key]):data[key]??'None';list.append(dt,dd)}
    const active=data.activeTasks??[];byId('state-label').textContent=data.state==='executing'&&live?'Executing Codex CLI':labels[data.state]||data.state;byId('capacity').textContent=active.length+' / '+data.maxParallel+' task slots occupied';
    const slots=byId('slot-map');slots.replaceChildren();for(let i=0;i<Math.min(data.maxParallel,24);i++){const slot=document.createElement('div'),title=document.createElement('strong'),detail=document.createElement('small');slot.className='slot';slot.dataset.busy=String(Boolean(active[i]));title.textContent='Slot '+(i+1)+' · '+(active[i]?'Occupied':'Unoccupied');detail.textContent=active[i]?active[i].id+' · '+active[i].profile:'No active attempt reported';slot.append(title,detail);slots.append(slot)}byId('slot-map-note').textContent=(data.maxParallel>24?'First 24 configured slots shown. ':'')+'Occupancy is observed locally. An unoccupied slot still needs an eligible profile and a healthy orchestrator connection.';
    const contactAge=data.lastContact?Math.max(0,Date.now()-Date.parse(data.lastContact)):null;
    byId('freshness').textContent=exported?'Exported '+timestamp(data.updatedAt):contactAge===null?'No orchestrator contact recorded':contactAge>60000?'Orchestrator contact older than 60 seconds':'Orchestrator contacted '+Math.round(contactAge/1000)+' seconds ago';
    const rows=byId('active-rows');rows.replaceChildren();for(const task of active){const row=document.createElement('tr');cell(row,task.id);cell(row,task.attempt);cell(row,task.profile);rows.append(row)}if(!active.length)empty(rows,'No active attempts in this process.');
    const profiles=byId('profile-rows');profiles.replaceChildren();for(const profile of data.profiles??[]){const row=document.createElement('tr');cell(row,profile.id);cell(row,profile.provider);cell(row,profile.mode);profiles.append(row)}if(!data.profiles?.length)empty(profiles,'No profiles reported.');
  }
  function validateStatus(data){
    const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
    if(!record(data)||(data.mode!==undefined&&!['mock','cli'].includes(data.mode))||(data.completedReviews!==undefined&&(!Number.isSafeInteger(data.completedReviews)||data.completedReviews<0))||typeof data.state!=='string'||!Number.isInteger(data.maxParallel)||data.maxParallel<1||!Array.isArray(data.activeTasks)||!Array.isArray(data.profiles)||
      data.activeTasks.some(task=>!record(task)||typeof task.id!=='string'||!Number.isInteger(task.attempt)||(task.profile!==null&&typeof task.profile!=='string'))||
      data.profiles.some(profile=>!record(profile)||['id','provider','mode'].some(key=>typeof profile[key]!=='string')))throw Error('Invalid worker status response');
    return data;
  }
  function connectionMessage(){
    byId('error').dataset.kind=lastFailure?'error':'info';
    const message=lastFailure?'Status unavailable. '+(lastFetched?'Showing the last response from '+lastFetched.toLocaleTimeString()+'. ':'No status received yet. ')+(paused?'Automatic updates paused. Use Refresh now to retry.':'Retrying in 3 seconds.'):
      paused?'Automatic updates paused. Refresh now remains available.':'Live status available. Automatic updates are enabled.';
    if(byId('error').textContent!==message)byId('error').textContent=message;
    if(lastFailure)byId('freshness').textContent='Live status unavailable · displayed values may be stale';
    else if(paused&&lastFetched)byId('freshness').textContent='Updates paused · last response '+lastFetched.toLocaleTimeString();
  }
  async function refresh(){
    if(inFlight||exported)return;inFlight=true;byId('refresh').disabled=true;byId('refresh').textContent='Refreshing…';
    try{const response=await fetch('/status',{cache:'no-store',signal:AbortSignal.timeout(2500)});if(!response.ok)throw Error('HTTP '+response.status);const data=validateStatus(await response.json());render(data);lastFetched=new Date();lastFailure=false;connectionMessage();}
    catch(error){lastFailure=true;connectionMessage();}
    finally{inFlight=false;byId('refresh').disabled=false;byId('refresh').textContent='Refresh now';}
  }
  byId('refresh').onclick=refresh;byId('pause').onclick=()=>{paused=!paused;byId('pause').setAttribute('aria-pressed',String(paused));byId('pause').textContent=paused?'Resume updates':'Pause updates';connectionMessage();if(!paused)refresh()};
  if(exported){render(exported);for(const id of ['refresh','pause','json-link'])byId(id).hidden=true;byId('error').textContent='Static export · measurements reflect the captured state.';byId('update-note').textContent='Exported snapshot. Values do not update; this file does not contact the worker.';}else{refresh();setInterval(()=>{if(!paused&&!document.hidden)refresh()},3000);}
  </script></body></html>`;
}
