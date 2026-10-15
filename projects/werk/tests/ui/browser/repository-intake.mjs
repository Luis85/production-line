import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.WERK_PLAYWRIGHT_MODULE||'playwright');
// Use an isolated mock system: this check saves one Factory intake and one line task.
if(!process.env.WERK_VISUAL_STATE)throw Error('Set WERK_VISUAL_STATE to an isolated mock system state directory.');
const root=process.env.WERK_VISUAL_STATE;
const out=process.env.WERK_VISUAL_EVIDENCE_DIR||`/tmp/werk-intake-browser-${Date.now()}`;
const factory=process.env.WERK_VISUAL_FACTORY_URL||'http://127.0.0.1:3100';
const line=process.env.WERK_VISUAL_LINE_URL||'http://127.0.0.1:3001';
const lineId=process.env.WERK_VISUAL_LINE_ID||'alpha';
const factoryToken=JSON.parse(await readFile(root+'/factory/credentials.json')).WERK_FACTORY_ADMIN_TOKEN;
const lineToken=JSON.parse(await readFile(root+'/lines/'+lineId+'/credentials.json')).WERK_ADMIN_TOKEN;
const overview=await fetch(line+'/v1/overview',{headers:{Authorization:`Bearer ${lineToken}`}});
assert.equal(overview.status,200,'The isolated line must accept its credentials');
const project=(await overview.json()).project;
assert.match(project,/^[a-zA-Z0-9_-]{1,100}$/);
await mkdir(out,{recursive:true});
const checks=[],errors=[];
const browser=await chromium.launch({executablePath:process.env.WERK_CHROMIUM||'/usr/bin/chromium',args:['--no-sandbox']});
async function snapshot(page){await page.locator('body').ariaSnapshot();}
async function click(page,locator){await snapshot(page);await locator.click();}
async function capture(page,name,locator){
 await snapshot(page);
 await (locator||page).screenshot({path:out+'/'+name+'.png',...(!locator?{fullPage:true}:{})});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,name+' page overflow');
 await writeFile(out+'/'+name+'.txt',await page.locator('body').ariaSnapshot());
}
async function select(page,name,option){await click(page,page.getByRole('combobox',{name,exact:true}));await click(page,page.getByRole('option',{name:option,exact:true}));}
async function login(page,url,label,token){await page.goto(url);await snapshot(page);await page.getByLabel(label,{exact:true}).fill(token);await click(page,page.getByRole('button',{name:'Verbinden',exact:true}));}
async function nav(page,name){await click(page,page.getByRole('navigation',{name:'Ansichten dieser Linie'}).getByRole('link',{name,exact:true}));}
try{
 for(const [device,width] of [['desktop',1440],['mobile',390]]){
  const page=await browser.newPage({viewport:{width,height:1000},hasTouch:width<500,isMobile:width<500,reducedMotion:'reduce'});
  page.on('pageerror',e=>errors.push(e.message));
  await login(page,factory,'Zugangstoken der Fabrikverwaltung',factoryToken);
  await page.locator('#overview-heading').waitFor();
  await click(page,page.getByRole('button',{name:'Factory-Intake öffnen'}));
  await snapshot(page);
  await page.getByLabel('Projekt',{exact:true}).fill(project);
  await page.getByLabel('Titel',{exact:true}).fill('Audit live mode selection');
  await page.getByLabel('Akzeptanzkriterien · eine pro Zeile',{exact:true}).fill('The selected provider matches the execution mode.');
  const factoryRepo=page.getByLabel('Repository-Zuweisung (optional)',{exact:true});
  await factoryRepo.fill('/local/path');assert.equal(await factoryRepo.evaluate(e=>e.checkValidity()),false);
  await factoryRepo.fill('portal-ui');assert.equal(await factoryRepo.evaluate(e=>e.checkValidity()),true);
  assert.equal(await factoryRepo.getAttribute('aria-describedby'),'factory-repository-hint');
  await select(page,'Ausführung','Live Codex · Review erforderlich');
  assert.equal(await page.getByRole('combobox',{name:'Provider',exact:true}).innerText(),'Codex');
  assert.equal(await page.getByRole('combobox',{name:'Provider',exact:true}).isDisabled(),true);
  await capture(page,'factory-live-'+device,page.locator('#factory-intake'));
  await select(page,'Ausführung','Simulation');
  assert.equal(await page.getByRole('combobox',{name:'Provider',exact:true}).isEnabled(),true);
  if(device==='desktop'){
   const response=page.waitForResponse(r=>r.url()===factory+'/v1/intake'&&r.request().method()==='POST');
   await click(page,page.getByRole('button',{name:'Auftrag im Factory-Intake speichern',exact:true}));
   const saved=await response;assert.equal(saved.status(),201);
   assert.equal(saved.request().postDataJSON().task.repository,'portal-ui');
   assert.equal(saved.request().postDataJSON().task.project,project);
   assert.equal(saved.request().postDataJSON().task.executionMode,'mock');
   const result=await saved.json();assert(result.id);
   await page.getByText('Repository-Zuweisung: portal-ui',{exact:true}).first().waitFor();
   checks.push('Factory real submission preserves assignment and project; simulation only');
  }
  checks.push(device+': Factory live mode selects and locks Codex, simulation unlocks provider, repository has accessible hint and validates IDs');
  await login(page,line,'Zugangstoken',lineToken);
  await page.locator('#system').waitFor();
  await nav(page,'Intake');await page.locator('#intake').waitFor();
  const repo=page.getByLabel('Repository-Zuweisung (optional)',{exact:true});
  await snapshot(page);await repo.fill('portal-ui');
  assert.equal(await repo.getAttribute('aria-describedby'),'repository-hint');
  assert.match(await page.locator('.preview').innerText(),/Repository-Zuweisung:\s*portal-ui/);
  await capture(page,'line-intake-'+device);
  await nav(page,'Worker');await nav(page,'Intake');
  assert.equal(await repo.inputValue(),'portal-ui');
  await snapshot(page);await repo.fill('../wrong');assert.equal(await repo.evaluate(e=>e.checkValidity()),false);
  await repo.fill('portal-ui');
  if(device==='desktop'){
   await click(page,page.getByRole('button',{name:'Feature beschreiben',exact:true}));
   await snapshot(page);await page.getByLabel('Feature',{exact:true}).fill('Audit repository assignment');
   await page.getByLabel('Akzeptanzkriterien · eines pro Zeile',{exact:true}).fill('Selected assignment is retained in task details.');
   const response=page.waitForResponse(r=>r.url()===line+'/v1/tasks'&&r.request().method()==='POST');
   await click(page,page.getByRole('button',{name:'Auftrag speichern',exact:true}));
   const saved=await response;assert.equal(saved.status(),201);
   const result=await saved.json();assert.equal(result.repository,'portal-ui');assert.equal(result.project,project);
   await page.locator('#task-detail-heading').waitFor();
   assert.match(await page.locator('section.detail').innerText(),/Repository-Zuweisung:\s*portal-ui/);
   await capture(page,'line-task-detail-'+device,page.locator('section.detail'));
   checks.push('Line real simulation submission roundtrips repository independently of project and shows task assignment');
  }
  await nav(page,'Dashboard');await page.locator('#system').waitFor();
  const trigger=page.getByRole('button',{name:'Tour starten',exact:true});
  await click(page,trigger);
  const tour=page.getByRole('dialog');await tour.waitFor();
  await tour.getByRole('button',{name:'Weiter',exact:true}).waitFor();
  assert.notEqual(await tour.getAttribute('aria-modal'),'true');
  assert.notEqual(await page.locator('body').evaluate(e=>getComputedStyle(e).pointerEvents),'none');
  await click(page,page.getByRole('button',{name:'Updates pausieren',exact:true}));
  await page.getByRole('button',{name:'Updates fortsetzen',exact:true}).waitFor();
  assert.equal(await tour.isVisible(),true);
  await capture(page,'line-tour-'+device);
  await page.keyboard.press('Escape');await tour.waitFor({state:'hidden'});
  assert.equal(await trigger.evaluate(e=>document.activeElement===e),true);
  await click(page,trigger);await tour.waitFor();
  await click(page,tour.getByRole('button',{name:'Weiter',exact:true}));
  await tour.getByText('Interaktion und Auftragsübergabe',{exact:true}).waitFor();
  await click(page,tour.getByRole('button',{name:'Zurück',exact:true}));
  await tour.getByText('Diese Produktionslinie verstehen',{exact:true}).waitFor();
  await page.locator('#system').waitFor();
  for(let index=0;index<3;index++)await click(page,tour.getByRole('button',{name:'Weiter',exact:true}));
  await page.locator('#tasks').waitFor();
  await click(page,tour.getByRole('button',{name:'Tour schließen',exact:true}).last());
  await tour.waitFor({state:'hidden'});
  checks.push(device+': walkthrough German, nonmodal, page controls usable, Escape restores trigger, Back/Next/Close route correctly');
  await page.goto(factory+'/guide');
  await page.locator('#views').waitFor();
  assert.match(await page.locator('#views').innerText(),/Worker workspace/);
  assert.match(await page.locator('#boundaries').innerText(),/Repository assignment/);
  await capture(page,'guide-views-'+device,page.locator('#views'));
  await capture(page,'guide-boundaries-'+device,page.locator('#boundaries'));
  await page.close();
 }
 assert.deepEqual(errors,[]);
 await writeFile(out+'/result.json',JSON.stringify({checks,errors},null,2));
 console.log(JSON.stringify({checks:checks.length,errors,evidence:out}));
}finally{await browser.close();}
