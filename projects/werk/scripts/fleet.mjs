import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
/** Do not leak another service's Werk credentials through the launching shell. */
export function childEnvironment(inherited, credentials) {
  const environment = Object.fromEntries(Object.entries(inherited).filter(([name]) => !/^WERK_.*TOKEN$/.test(name)));
  return { ...environment, ...credentials };
}
export function fleetOptions(args, env) {
  if(args.length && (args.length!==2 || args[0]!=='--workers')) throw Error('Usage: npm run dev:fleet -- --workers 3');
  const count=args.length?Number(args[1]):3;
  const port=Number(env.WERK_DEV_PORT??3000),statusStart=Number(env.WERK_STATUS_BASE??4101);
  if(!Number.isInteger(count)||count<1||count>50)throw Error('--workers: integer 1–50');
  if(!Number.isInteger(port)||port<1||port>65535||!Number.isInteger(statusStart)||statusStart<1||statusStart+count-1>65535)throw Error('Fleet ports must be integers in 1–65535');
  if(port>=statusStart&&port<statusStart+count)throw Error('Orchestrator port overlaps worker status ports');
  return {count,port,statusStart,url:`http://127.0.0.1:${port}`};
}
export function validateCredentials(value) {
  const keys=['WERK_ADMIN_TOKEN','WERK_ENROLLMENT_TOKEN'];
  if(!value||typeof value!=='object'||keys.some(k=>typeof value[k]!=='string'||!/^[a-f0-9]{64}$/.test(value[k]))||value[keys[0]]===value[keys[1]])throw Error('Invalid fleet credentials; restore .state/fleet/credentials.json from backup');
  return Object.fromEntries(keys.map(k=>[k,value[k]]));
}
export async function assertFreePort(port) {
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>server.close(resolve));});
}
export async function main(args=process.argv.slice(2),env=process.env) {
  const {count,port,statusStart,url}=fleetOptions(args,env);
  const state=join(root,'.state/fleet'),lock=join(state,'fleet.lock');
  await mkdir(state,{recursive:true,mode:0o700});
  try { await writeFile(lock,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}),{flag:'wx',mode:0o600}); }
  catch(e) {if(e.code==='EEXIST')throw Error('Fleet lock exists. Stop the running fleet first; after a crash verify all old processes are gone before removing .state/fleet/fleet.lock.');throw e;}
  const children=[];let stopping=false,forceTimer;
  const stop=()=>{
    if(stopping)return;stopping=true;
    // Keep the server available while workers flush snapshots and relinquish leases.
    for(const p of children.slice(1))if(p.exitCode===null)p.kill('SIGTERM');
    void Promise.all(completions.slice(1)).then(()=>{if(children[0]?.exitCode===null)children[0].kill('SIGTERM');});
    forceTimer=setTimeout(()=>{for(const p of children)if(p.exitCode===null)p.kill('SIGKILL');},15000);forceTimer.unref();
  };
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const completions=[];
  function spawnCli(path,args,extraEnv){
    const p=spawn(process.execPath,[join(root,path),...args],{cwd:root,stdio:'inherit',detached:process.platform!=='win32',windowsHide:true,env:childEnvironment(env,extraEnv)});children.push(p);
    completions.push(new Promise(resolve=>{p.once('error',e=>{console.error(e.message);process.exitCode=1;stop();resolve();});p.once('exit',(code,signal)=>{if(!stopping){console.error(`Fleet process exited unexpectedly (${code??signal}). Stopping fleet.`);process.exitCode=1;stop();}resolve();});}));return p;
  }
  try {
    await Promise.all([access(join(root,'src/orchestrator/dist/orchestrator/cli.js')),access(join(root,'src/worker/dist/worker/cli.js'))]).catch(()=>{throw Error('Build outputs missing. Run npm run build first.');});
    for(const p of [port,...Array.from({length:count},(_,i)=>statusStart+i)])await assertFreePort(p).catch(()=>{throw Error(`Port ${p} is unavailable; change WERK_DEV_PORT or WERK_STATUS_BASE.`);});
    let credentials;
    try{credentials=validateCredentials(JSON.parse(await readFile(join(state,'credentials.json'),'utf8')));}
    catch(e){if(e.code!=='ENOENT')throw e;credentials={WERK_ADMIN_TOKEN:randomBytes(32).toString('hex'),WERK_ENROLLMENT_TOKEN:randomBytes(32).toString('hex')};await writeFile(join(state,'credentials.json'),JSON.stringify(credentials,null,2)+'\n',{mode:0o600,flag:'wx'});}
    const cliEnv={...credentials,WERK_URL:url};
    await writeFile(join(state,'env.sh'),Object.entries(cliEnv).map(([k,v])=>`export ${k}='${v}'`).join('\n')+'\n',{mode:0o600});
    await writeFile(join(state,'env.ps1'),Object.entries(cliEnv).map(([k,v])=>`$env:${k} = '${v}'`).join('\n')+'\n',{mode:0o600});
    const server=spawnCli('src/orchestrator/dist/orchestrator/cli.js',['serve','--host','127.0.0.1','--port',String(port),'--db',join(state,'factory.sqlite')],cliEnv);
    let ready=false;
    for(let n=0;n<50&&!stopping;n++){try{const r=await fetch(url+'/v1/tasks',{headers:{Authorization:'Bearer '+credentials.WERK_ADMIN_TOKEN},signal:AbortSignal.timeout(500)});if(r.ok&&server.exitCode===null){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
    if(!ready||stopping)throw Error('Orchestrator did not start; check logs and port availability');
    for(let n=1;n<=count&&!stopping;n++)spawnCli('src/worker/dist/worker/cli.js',['run','--url',url,'--state-dir',join(state,'worker-'+n),'--status-port',String(statusStart+n-1)],{WERK_ENROLLMENT_TOKEN:credentials.WERK_ENROLLMENT_TOKEN});
    console.error(`Intake: ${url}/\nWorker status: ports ${statusStart}–${statusStart+count-1}\nCredentials: .state/fleet/credentials.json (local only)\nBash: source .state/fleet/env.sh\nPowerShell: . ./.state/fleet/env.ps1\nCtrl+C stops all processes.`);
    await Promise.all(completions);
  } finally {
    stop();await Promise.all(completions);clearTimeout(forceTimer);
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    await unlink(lock);
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
