/** Docker daemon required. Wrappers deliberately have no host Node on PATH. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, symlink, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { checkDockerGit } from './check-docker-git.mjs';
const exec=promisify(execFile), root=resolve(process.env.WERK_DOCKER_RELEASE_ROOT??'.');
const scratch=await mkdtemp(join(tmpdir(),'werk-docker-system-')), state=join(scratch,'private system with spaces'), file=join(scratch,'system.yaml');
const image=`werk-release:system-smoke-${process.pid}`, env={...process.env,WERK_DOCKER_IMAGE:image};
let project;
const step=name=>console.error(`Docker system smoke: ${name}`);
async function ports() {
  for(let attempt=0;attempt<100;attempt++) {
    const start=30000+Math.floor(Math.random()*25000), servers=[];
    try { for(let i=0;i<6;i++) { const server=createServer(); await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(start+i,'127.0.0.1',resolve);});servers.push(server); } return start; }
    catch { /* Retry occupied contiguous port range. */ }
    finally { await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve)))); }
  }
  throw Error('Cannot allocate smoke ports');
}
try {
  const path=join(scratch,'host-tools'); await mkdir(path);
  for(const name of ['bash','docker','id','mkdir','dirname']) await symlink((await exec('/bin/sh',['-c','command -v '+name])).stdout.trim(),join(path,name));
  env.PATH=path;
  const logs=[];
  const run=async command=> { const result=await exec(join(path,'bash'),[join(root,'werk-docker.sh'),'system',command,'--file',file,'--state-dir',state,'--json','--no-open'],{env,cwd:root,timeout:240000,maxBuffer:8*1024*1024});logs.push(result.stdout,result.stderr);return JSON.parse(result.stdout); };
  const port=await ports();
  const definition={schemaVersion:1,id:'docker-system-smoke',environment:'docker',factory:{id:'factory',name:'Factory',port,subFactories:[{id:'child',name:'Child',parentId:'factory'}]},productionLines:[
    {id:'alpha',name:'Alpha',factoryId:'child',project:'alpha',orchestrator:{port:port+1},workers:{count:2,statusPort:port+3}},
    {id:'beta',name:'Beta',project:'beta',orchestrator:{port:port+2},workers:{count:1,statusPort:port+5}}
  ]};await writeFile(file,JSON.stringify(definition));
  step('pure plan'); assert.equal((await run('plan')).totals.workers,3); await assert.rejects(readFile(join(state,'system.json')),e=>e.code==='ENOENT');
  step('setup twice'); const setup=await run('setup'); project=setup.project;
  const secrets=await Promise.all(['factory/credentials.json','lines/alpha/credentials.json','lines/beta/credentials.json'].map(path=>readFile(join(state,path),'utf8')));
  await run('setup');
  step('offline Git runtime'); const gitRuntime=await checkDockerGit(image); assert.equal(gitRuntime.localCommit,true);
  step('start all services'); const ready=await run('up');assert.equal(ready.ready,true);assert.equal(ready.productionLines.length,2);assert.equal(ready.productionLines[0].workers.length,2);
  assert.equal((await fetch(ready.url)).status,200);
  const factoryToken=JSON.parse(secrets[0]).WERK_FACTORY_ADMIN_TOKEN;
  const tokens=secrets.slice(1).map(raw=>JSON.parse(raw).WERK_ADMIN_TOKEN);
  const request=async (index,path,options={})=> { const response=await fetch(`http://127.0.0.1:${port+1+index}${path}`,{...options,headers:{authorization:`Bearer ${tokens[index]}`,...options.headers}});return {status:response.status,body:await response.json()}; };
  const overview=await fetch(`http://127.0.0.1:${port}/v1/overview`,{headers:{authorization:`Bearer ${factoryToken}`}}).then(r=>r.json());assert.equal(overview.lines.length,2);assert.equal(overview.factories.length,2);
  step('independent tasks'); const tasks=[];
  for(let index=0;index<2;index++) { const result=await request(index,'/v1/tasks',{method:'POST',headers:{'content-type':'application/json','idempotency-key':'system-smoke'},body:JSON.stringify({project:index?'beta':'alpha',title:'Isolated Docker mock task',criteria:['Persisted evidence']})});assert.equal(result.status,201);tasks.push(result.body); }
  for(let attempt=0;attempt<80;attempt++) { const states=await Promise.all(tasks.map((task,i)=>request(i,`/v1/tasks/${task.id}`)));if(states.every(result=>result.body.status==='simulated'))break;if(attempt===79)throw Error('Mock tasks did not complete');await new Promise(resolve=>setTimeout(resolve,250)); }
  assert.equal((await request(1,`/v1/tasks/${tasks[0].id}`)).status,404);
  const wrong=await fetch(`http://127.0.0.1:${port+2}/v1/overview`,{headers:{authorization:`Bearer ${tokens[0]}`}});assert.equal(wrong.status,401);
  const workerIds=await Promise.all([0,1].map(async i=>(await request(i,'/v1/workers?limit=100')).body.workers.map(worker=>worker.id).sort()));assert.deepEqual(workerIds.map(ids=>ids.length),[2,1]);
  const compose=['compose','--project-directory',root,'--file',join(state,'docker-compose.json'),'--project-name',project];
  await exec('docker',[...compose,'exec','-T','line-1-worker-1','node','-e',"const fs=require('fs');for(const p of ['/state/credentials.json','/state/orchestrator.sqlite','/state/factory'])if(fs.existsSync(p))process.exit(1);if(!fs.existsSync('/state/enrollment.json'))process.exit(2)"],{timeout:30000});
  step('stop and restart');await run('stop');await run('start');assert.equal((await run('doctor')).ready,true);
  for(let i=0;i<2;i++) {assert.equal((await request(i,`/v1/tasks/${tasks[i].id}`)).body.status,'simulated');assert.deepEqual((await request(i,'/v1/workers?limit=100')).body.workers.map(worker=>worker.id).sort(),workerIds[i]);}
  for(let i=0;i<secrets.length;i++) {const path=['factory/credentials.json','lines/alpha/credentials.json','lines/beta/credentials.json'][i];assert.equal(await readFile(join(state,path),'utf8'),secrets[i]);for(const secret of Object.values(JSON.parse(secrets[i])))assert.ok(logs.every(output=>!output.includes(secret)));}
  console.log(JSON.stringify({ok:true,journey:'docker-system',hostNodeInWrapperPath:false,gitRuntime:true,factories:2,lines:2,workers:3,isolatedTasks:true,workerMountBoundary:true,restartPersistence:true,credentialOutput:false}));
} finally {
  if(project) await exec('docker',['compose','--project-directory',root,'--file',join(state,'docker-compose.json'),'--project-name',project,'down','--remove-orphans'],{timeout:90000}).catch(()=>{});
  await exec('docker',['image','rm',image],{timeout:30000}).catch(()=>{});
  await rm(scratch,{recursive:true,force:true});
}
