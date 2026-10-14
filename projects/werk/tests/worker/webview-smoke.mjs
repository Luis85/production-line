import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
// Optional browser qualification; requires Playwright Core and a Chromium executable.
const cwd=fileURLToPath(new URL('../../', import.meta.url));
const { chromium }=await import(pathToFileURL(resolve(process.env.WERK_PLAYWRIGHT_MODULE ?? join(cwd, '../../bin/browser-runtime/playwright-core/index.mjs'))).href);
const evidence=process.env.WERK_BROWSER_EVIDENCE ? resolve(process.env.WERK_BROWSER_EVIDENCE) : await mkdtemp(join(tmpdir(), 'werk-browser-evidence-'));
await mkdir(evidence,{recursive:true});
const state=await mkdtemp(join(tmpdir(),'werk-overhaul-browser-'));
const fixture=join(state,'model-fixture');
await writeFile(fixture,`#!${process.execPath}\nif(process.argv.slice(2).join(' ')==='login status'){console.log('Logged in using protocol fixture');process.exit(0)}let input='';for await(const part of process.stdin)input+=part;setTimeout(()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'**Review complete — protocol fixture**\\n\\n- Keep one task in one session.\\n- Verify serial execution and saved history.\\n\\n\`\`\`js\\nconst next = "Review the saved patch";\\n\`\`\`\\n\\n<svg onload="window.unsafeMessage=true"> is plain text here.'}})),1800);`,{mode:0o700});
async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const p=server.address().port;await new Promise(r=>server.close(r));return p;}
const port=await freePort(),url=`http://127.0.0.1:${port}`;
const log=await open(join(evidence,'worker.log'),'w');
let worker,browser;const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let n=0;n<200;n++){try{if(await fn())return;}catch{}await delay(100);}throw Error('Timed out: '+label);}
async function start(){worker=spawn(process.execPath,['werk.mjs','worker','run','--state-dir',state,'--status-port',String(port)],{cwd,stdio:['ignore',log.fd,log.fd]});await until(async()=> (await fetch(url+'/healthz')).ok,'worker');}
async function stop(){if(!worker||worker.exitCode!==null)return;worker.kill('SIGTERM');await Promise.race([new Promise(r=>worker.once('exit',r)),delay(10000)]);if(worker.exitCode===null)worker.kill('SIGKILL');}
const result={screenshots:[],checks:[],pageErrors:[],liveProvider:false};
try{
 await start(); const token=(await readFile(join(state,'webview-token'),'utf8')).trim();
 const api=async(path,body)=>{const r=await fetch(url+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const v=await r.json();assert.ok(r.ok,v.error);return v;};
 browser=await chromium.launch({executablePath:process.env.WERK_CHROMIUM ?? '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 const ctx=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write']}),page=await ctx.newPage();
 page.on('pageerror',e=>result.pageErrors.push(e.message));
 async function shot(name){await page.evaluate(()=>scrollTo(0,0));await delay(150);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${name} overflow`);await page.screenshot({path:join(evidence,name+'.png'),fullPage:true});result.screenshots.push(name);}
 async function refresh(){await page.getByRole('button',{name:'Refresh worker',exact:true}).click();await delay(180);}
 async function choose(label,option){await page.getByLabel(label,{exact:true}).click();await page.getByRole('option',{name:option,exact:true}).click();}
 await page.goto(url);await page.getByRole('button',{name:'Unlock worker',exact:true}).waitFor();
 assert.equal(await page.getByRole('navigation',{name:'Worker pages'}).count(),0); await shot('login-desktop');
 await page.setViewportSize({width:390,height:844});await shot('login-mobile');await page.setViewportSize({width:1440,height:1000});
 await page.getByLabel('Worker access token',{exact:true}).fill('invalid');await page.getByRole('button',{name:'Unlock worker',exact:true}).click();await page.getByRole('alert').filter({hasText:'incorrect'}).waitFor();
 await page.getByLabel('Worker access token',{exact:true}).fill(token);await page.getByRole('button',{name:'Unlock worker',exact:true}).click();await page.getByRole('button',{name:'Lock',exact:true}).waitFor();
 await page.reload();await page.getByRole('button',{name:'Lock',exact:true}).waitFor();assert.equal(await page.getByLabel('Worker access token').count(),0);result.checks.push('dedicated unlock, invalid token, reload retains session');
 await page.getByRole('button',{name:'Connections',exact:true}).click();await page.getByLabel('CLI executable on this machine').fill(fixture);await page.getByRole('button',{name:'Save provider',exact:true}).click();await page.getByText('Settings saved.',{exact:true}).waitFor();await page.getByRole('button',{name:'Check sign-in',exact:true}).click();await page.locator('.chat-provider-setup [role="status"]').filter({hasText:'Codex reports a signed-in account. No model request was made.'}).waitFor();await shot('connection-desktop');await page.getByRole('button',{name:'Close provider connections',exact:true}).click();
 await page.getByRole('button',{name:'Agent definitions',exact:true}).click();await page.getByLabel('Definition name',{exact:true}).fill('Project reviewer');
 await page.getByLabel('Or paste Docker Agent YAML',{exact:true}).fill('version: "15"\nagents:\n  root:\n    description: Review requirements\n    instruction: Review acceptance criteria before proposing work.\n    toolsets:\n      - type: filesystem\n');
 await page.getByRole('button',{name:'Preview definition',exact:true}).click();await page.getByRole('heading',{name:'Review before importing',exact:true}).waitFor();await shot('definition-preview-desktop');await page.getByRole('button',{name:'Import definition',exact:true}).click();await page.getByText('Definition saved. Choose it when creating a new task.',{exact:true}).waitFor();await page.getByRole('button',{name:'Close agent definitions',exact:true}).click();
 await page.getByRole('button',{name:'New task',exact:true}).click();await choose('Agent definition','Project reviewer');
 assert.equal(await page.getByRole('button',{name:'Create draft task',exact:true}).isDisabled(),true);await page.getByLabel('Use instructions only. I accept the omitted features listed above.',{exact:true}).check();await page.getByLabel('Task name · optional',{exact:true}).fill('Review worker lifecycle');await shot('new-task-desktop');await page.getByRole('button',{name:'Create draft task',exact:true}).click();await page.getByRole('heading',{name:'Review worker lifecycle',exact:true}).waitFor();
 await api('/api/settings',{board:{paused:true}});await page.getByLabel('Task instructions',{exact:true}).fill('Define acceptance criteria for the worker lifecycle.');await page.getByRole('button',{name:'Queue task',exact:true}).click();await page.getByRole('button',{name:'Cancel queued task',exact:true}).waitFor();await shot('queued-desktop');
 await page.getByLabel('Follow-up for this task',{exact:true}).fill('Explain restart behavior next.');await api('/api/settings',{board:{paused:false}});await until(async()=>!(await api('/api/chat')).busy,'reply');await refresh();assert.equal(await page.getByLabel('Follow-up for this task',{exact:true}).inputValue(),'Explain restart behavior next.');assert.equal(await page.evaluate(()=>window.unsafeMessage),undefined);await page.getByRole('button',{name:'Copy code',exact:true}).click();assert.ok((await page.evaluate(()=>navigator.clipboard.readText())).includes('Review the saved patch'));await shot('chat-desktop');
 await page.setViewportSize({width:900,height:900});await shot('chat-tablet');await page.setViewportSize({width:390,height:844});await shot('chat-mobile');await page.setViewportSize({width:1440,height:1000});
 const task=(await api('/api/sessions')).selected;await page.getByRole('button',{name:'Send follow-up',exact:true}).click();await until(async()=>!(await api('/api/chat')).busy,'followup');await refresh();assert.equal((await api('/api/sessions')).selected,task);assert.equal((await api('/api/chat')).messages.length,4);result.checks.push('definition preview/adaptation, task snapshot, queue, draft while busy, same-session follow-up, escaped HTML, code copy');
 await page.getByRole('link',{name:'History',exact:true}).click();await shot('history-desktop');await page.getByRole('link',{name:'Dashboard',exact:true}).click();await shot('dashboard-desktop');await page.getByRole('button',{name:'Tour',exact:true}).click();await page.locator('[data-werk-tour]').waitFor();await shot('tour-desktop');await page.getByRole('button',{name:'Close tour',exact:true}).click();
 await page.getByRole('link',{name:'Chat',exact:true}).click();await page.getByLabel('Follow-up for this task',{exact:true}).fill('Unsent draft survives access expiry.');await stop();await start();await until(async()=>await page.getByRole('button',{name:'Unlock worker',exact:true}).isVisible(),'restart relock');await page.getByLabel('Worker access token',{exact:true}).fill(token);await page.getByRole('button',{name:'Unlock worker',exact:true}).click();await page.getByLabel('Follow-up for this task',{exact:true}).waitFor();assert.equal(await page.getByLabel('Follow-up for this task',{exact:true}).inputValue(),'Unsent draft survives access expiry.');assert.equal((await api('/api/chat')).messages.length,4);result.checks.push('restart relocks, transcript/profile persists, unsent draft restored');
 await page.getByRole('button',{name:'Lock',exact:true}).click();await page.getByRole('button',{name:'Unlock worker',exact:true}).waitFor();await page.reload();await page.getByRole('button',{name:'Unlock worker',exact:true}).waitFor();assert.equal(await page.getByRole('navigation',{name:'Worker pages'}).count(),0);result.checks.push('explicit lock revokes saved browser access');
 assert.deepEqual(result.pageErrors,[]);
 await writeFile(join(evidence,'result.json'),JSON.stringify(result,null,2));await rm(join(evidence,'failure.json'),{force:true});console.log(JSON.stringify({evidence,...result}));
}catch(error){console.error(error.stack);await writeFile(join(evidence,'failure.json'),JSON.stringify({...result,error:error.message},null,2));process.exitCode=1;}
finally{await browser?.close();await stop();await log.close();await rm(state,{recursive:true,force:true});}
