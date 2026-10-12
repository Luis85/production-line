import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { assertFreePort, childEnvironment } from './fleet.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const secretKeys=['WERK_FACTORY_ADMIN_TOKEN','WERK_LINE_ALPHA_TOKEN','WERK_LINE_BETA_TOKEN','WERK_ALPHA_ENROLLMENT_TOKEN','WERK_BETA_ENROLLMENT_TOKEN'];
export function factoryFleetOptions(args,env,previous={}){
  if(!previous||typeof previous!=='object'||Array.isArray(previous)||Object.keys(previous).some(key=>!['workers','factoryPort','alphaPort','betaPort','statusBase'].includes(key)))throw Error('Invalid saved factory fleet configuration; inspect .state/factory-fleet/config.json');
  if(args.length&&(args.length!==2||args[0]!=='--workers'))throw Error('Usage: npm run dev:factory -- --workers 1 (per line)');
  const workers=args.length?Number(args[1]):previous.workers??1;
  const factoryPort=Number(env.WERK_FACTORY_PORT??previous.factoryPort??3100);
  const alphaPort=Number(env.WERK_LINE_A_PORT??previous.alphaPort??3001);
  const betaPort=Number(env.WERK_LINE_B_PORT??previous.betaPort??3002);
  const statusBase=Number(env.WERK_FACTORY_STATUS_BASE??previous.statusBase??4201);
  if(!Number.isInteger(workers)||workers<1||workers>8)throw Error('--workers must be 1–8 per line');
  const ports=[factoryPort,alphaPort,betaPort,...Array.from({length:workers*2},(_,i)=>statusBase+i)];
  if(ports.some(p=>!Number.isInteger(p)||p<1||p>65535)||new Set(ports).size!==ports.length)throw Error('Factory, line and status ports must be distinct integers in 1–65535');
  return {workers,factoryPort,alphaPort,betaPort,statusBase};
}
export function validateFactorySecrets(value){
  if(!value||secretKeys.some(k=>typeof value[k]!=='string'||!/^[a-f0-9]{64}$/.test(value[k]))||new Set(secretKeys.map(k=>value[k])).size!==secretKeys.length)throw Error('Invalid factory fleet credentials; restore credentials.json from backup');
  return Object.fromEntries(secretKeys.map(k=>[k,value[k]]));
}
export async function bootstrapHierarchy(call,{alphaUrl,betaUrl}){
  const factory={id:'demo-factory',name:'Demo factory',parentId:null};
  const {factories}=await call('/v1/factories');
  const existing=factories.find(f=>f.id===factory.id);
  if(!existing)await call('/v1/factories','POST',factory);
  else if(existing.parentId!==null)throw Error('Demo factory hierarchy changed; launcher will not overwrite it');
  const {lines}=await call('/v1/lines');
  for(const [id,name,url,tokenEnv] of [['demo-alpha','Alpha',alphaUrl,'WERK_LINE_ALPHA_TOKEN'],['demo-beta','Beta',betaUrl,'WERK_LINE_BETA_TOKEN']]){
    const line={id,name,factoryId:factory.id,orchestratorUrl:url,webviewUrl:url,tokenEnv};
    const current=lines.find(item=>item.id===id);
    if(!current)await call('/v1/lines','POST',line);
    else if(['factoryId','orchestratorUrl','webviewUrl','tokenEnv'].some(key=>String(current[key]).replace(/\/$/,'')!==String(line[key]).replace(/\/$/,'')))throw Error(`Line ${id} settings differ; update them explicitly in Factory or restore prior launcher ports. No existing line was overwritten.`);
  }
}
export async function main(args=process.argv.slice(2),env=process.env){
  const state=join(root,'.state/factory-fleet');await mkdir(state,{recursive:true,mode:0o700});
  const lock=join(state,'fleet.lock');await writeFile(lock,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600}).catch(e=>{if(e.code==='EEXIST')throw Error('Factory fleet lock exists; stop old processes before removing stale lock');throw e;});
  const children=[];let stopping=false,forceTimer;
  const stop=()=>{
    if(stopping)return;stopping=true;
    const terminate=role=>{for(const item of children)if(item.role===role&&item.child.exitCode===null)item.child.kill('SIGTERM');};
    const wait=role=>Promise.all(children.filter(p=>p.role===role).map(p=>p.done));
    terminate('worker');void wait('worker').then(()=>{terminate('line');return wait('line');}).then(()=>terminate('factory'));
    forceTimer=setTimeout(()=>{for(const item of children)if(item.child.exitCode===null)item.child.kill('SIGKILL');},20000);forceTimer.unref();
  };
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  function launch(role,app,args,vars){
    if(stopping)throw Error('Factory fleet is stopping');
    const child=spawn(process.execPath,[join(root,'src',app,'dist',app,'cli.js'),...args],{cwd:root,stdio:'inherit',detached:process.platform!=='win32',windowsHide:true,env:childEnvironment(env,vars)});
    const done=new Promise(resolve=>{child.once('error',e=>{console.error(e.message);process.exitCode=1;stop();resolve();});child.once('exit',(code,signal)=>{if(!stopping){console.error(`${app} exited unexpectedly (${code??signal}); stopping fleet`);process.exitCode=1;stop();}resolve();});});
    children.push({child,role,done});return child;
  }
  async function ready(url,token,path){
    for(let n=0;n<60&&!stopping;n++){try{const r=await fetch(url+path,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(500)});if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error(`Service did not become ready: ${url}`);
  }
  try{
    let previous={};try{previous=JSON.parse(await readFile(join(state,'config.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    const config=factoryFleetOptions(args,env,previous);
    const {workers,factoryPort,alphaPort,betaPort,statusBase}=config;
    for(const app of ['factory','orchestrator','worker'])await access(join(root,'src',app,'dist',app,'cli.js')).catch(()=>{throw Error('Run npm run build first');});
    for(const port of [factoryPort,alphaPort,betaPort,...Array.from({length:workers*2},(_,i)=>statusBase+i)])await assertFreePort(port).catch(()=>{throw Error(`Port ${port} unavailable; configure distinct factory/line/status ports`);});
    let secrets;try{secrets=validateFactorySecrets(JSON.parse(await readFile(join(state,'credentials.json'),'utf8')));}catch(e){if(e.code!=='ENOENT')throw e;secrets=Object.fromEntries(secretKeys.map(k=>[k,randomBytes(32).toString('hex')]));await writeFile(join(state,'credentials.json'),JSON.stringify(secrets,null,2)+'\n',{flag:'wx',mode:0o600});}
    const factoryUrl=`http://127.0.0.1:${factoryPort}`,alphaUrl=`http://127.0.0.1:${alphaPort}`,betaUrl=`http://127.0.0.1:${betaPort}`;
    const environments={factory:{WERK_FACTORY_URL:factoryUrl,WERK_FACTORY_ADMIN_TOKEN:secrets.WERK_FACTORY_ADMIN_TOKEN},alpha:{WERK_URL:alphaUrl,WERK_ADMIN_TOKEN:secrets.WERK_LINE_ALPHA_TOKEN},beta:{WERK_URL:betaUrl,WERK_ADMIN_TOKEN:secrets.WERK_LINE_BETA_TOKEN}};
    for(const [name,values]of Object.entries(environments)){
      await writeFile(join(state,name+'.env.sh'),Object.entries(values).map(([k,v])=>`export ${k}='${v}'`).join('\n')+'\n',{mode:0o600});
      await writeFile(join(state,name+'.env.ps1'),Object.entries(values).map(([k,v])=>`$env:${k} = '${v}'`).join('\n')+'\n',{mode:0o600});
    }
    launch('factory','factory',['serve','--host','127.0.0.1','--port',String(factoryPort),'--db',join(state,'factory.sqlite')],{WERK_FACTORY_ADMIN_TOKEN:secrets.WERK_FACTORY_ADMIN_TOKEN,WERK_LINE_ALPHA_TOKEN:secrets.WERK_LINE_ALPHA_TOKEN,WERK_LINE_BETA_TOKEN:secrets.WERK_LINE_BETA_TOKEN});
    for(const [name,url,port,admin,enroll]of [['alpha',alphaUrl,alphaPort,secrets.WERK_LINE_ALPHA_TOKEN,secrets.WERK_ALPHA_ENROLLMENT_TOKEN],['beta',betaUrl,betaPort,secrets.WERK_LINE_BETA_TOKEN,secrets.WERK_BETA_ENROLLMENT_TOKEN]]){
      launch('line','orchestrator',['serve','--host','127.0.0.1','--port',String(port),'--db',join(state,name,'orchestrator.sqlite'),'--project','demo'],{WERK_ADMIN_TOKEN:admin,WERK_ENROLLMENT_TOKEN:enroll});
      await ready(url,admin,'/v1/tasks');
      for(let n=0;n<workers;n++)launch('worker','worker',['run','--url',url,'--state-dir',join(state,name,'worker-'+(n+1)),'--status-port',String(statusBase+(name==='beta'?workers:0)+n)],{WERK_ENROLLMENT_TOKEN:enroll});
    }
    await ready(factoryUrl,secrets.WERK_FACTORY_ADMIN_TOKEN,'/v1/factories');
    const call=async(path,method='GET',body)=>{const r=await fetch(factoryUrl+path,{method,headers:{Authorization:'Bearer '+secrets.WERK_FACTORY_ADMIN_TOKEN,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});const value=await r.json();if(!r.ok)throw Error(value.error??`Factory HTTP ${r.status}`);return value;};
    await bootstrapHierarchy(call,{alphaUrl,betaUrl});
    await writeFile(join(state,'config.json'),JSON.stringify(config,null,2)+'\n',{mode:0o600});
    console.error(`Factory: ${factoryUrl}/\nAlpha: ${alphaUrl}/ · Beta: ${betaUrl}/\nWorker status ports ${statusBase}–${statusBase+workers*2-1}\nCredentials and client environments: .state/factory-fleet/\nCtrl+C stops workers, lines, then Factory.`);
    await Promise.all(children.map(p=>p.done));
  }finally{stop();await Promise.all(children.map(p=>p.done));clearTimeout(forceTimer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await unlink(lock);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
