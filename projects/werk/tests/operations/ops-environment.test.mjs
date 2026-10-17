import { testListeningAddress } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { childEnvironment } from '../../scripts/fleet.mjs';
import { factoryFleetOptions } from '../../scripts/factory-fleet.mjs';

test('worker environment excludes inherited Factory and line admin tokens',()=>{
  const inherited={PATH:'/bin',HOME:'/home/operator',WERK_ADMIN_TOKEN:'old-admin',WERK_FACTORY_ADMIN_TOKEN:'portfolio-admin',WERK_LINE_ALPHA_TOKEN:'alpha-admin',WERK_ENROLLMENT_TOKEN:'old-enrollment',WERK_URL:'http://localhost:3000',CLAUDE_CONFIG_DIR:'/profiles/claude'};
  const worker=childEnvironment(inherited,{WERK_ENROLLMENT_TOKEN:'worker-enrollment'});
  assert.equal(worker.WERK_ENROLLMENT_TOKEN,'worker-enrollment');
  assert.equal(worker.WERK_ADMIN_TOKEN,undefined);assert.equal(worker.WERK_FACTORY_ADMIN_TOKEN,undefined);assert.equal(worker.WERK_LINE_ALPHA_TOKEN,undefined);
  assert.equal(worker.PATH,'/bin');assert.equal(worker.CLAUDE_CONFIG_DIR,'/profiles/claude');
  assert.equal(inherited.WERK_ADMIN_TOKEN,'old-admin');
});
test('server environment includes only explicitly supplied Werk credentials',()=>{
  const result=childEnvironment({WERK_LINE_UNRELATED_TOKEN:'unrelated',WERK_ADMIN_TOKEN:'inherited',NODE_ENV:'development'},{WERK_FACTORY_ADMIN_TOKEN:'factory',WERK_LINE_ALPHA_TOKEN:'alpha'});
  assert.deepEqual(result,{NODE_ENV:'development',WERK_FACTORY_ADMIN_TOKEN:'factory',WERK_LINE_ALPHA_TOKEN:'alpha'});
});
test('malformed saved topology fails before service startup',()=>{
  for(const previous of [null,[],1,'text',{unexpected:true}])assert.throws(()=>factoryFleetOptions([],{},previous),/Invalid saved/);
  assert.equal(factoryFleetOptions([],{},{}).workers,1);
});

test('actual fleet worker subprocess receives enrollment without admin credentials', {skip:process.platform==='win32'}, async()=>{
  const {mkdtemp,mkdir,cp,writeFile,readFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {createServer}=await import('node:net');const {spawn}=await import('node:child_process');
  const root=await mkdtemp(join(tmpdir(),'werk-token-scope-'));
  const listeners=[createServer(),createServer()];
  await Promise.all(listeners.map(s=>new Promise(r=>s.listen(0,'127.0.0.1',() => r(undefined)))));
  const [port,status]=listeners.map(s=>testListeningAddress(s).port);await Promise.all(listeners.map(s=>new Promise(r=>s.close(r))));
  let child,exited;
  try{
    await mkdir(join(root,'scripts'));await cp(new URL('../../scripts/fleet.mjs',import.meta.url),join(root,'scripts/fleet.mjs'));
    for(const app of ['orchestrator','worker'])await mkdir(join(root,'src',app,'dist',app),{recursive:true});
    const resultFile=join(root,'observed-keys.json');
    await writeFile(join(root,'src/orchestrator/dist/orchestrator/cli.js'),`const http=require('node:http');const p=Number(process.argv[process.argv.indexOf('--port')+1]);const s=http.createServer((req,res)=>res.end('{}'));s.listen(p,'127.0.0.1');process.once('SIGTERM',()=>s.close());`);
    await writeFile(join(root,'src/worker/dist/worker/cli.js'),`const t=setInterval(()=>{},1000);process.once('SIGTERM',()=>clearInterval(t));require('node:fs').writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(Object.keys(process.env).filter(k=>/^WERK_.*TOKEN$/.test(k))));`);
    child=spawn(process.execPath,[join(root,'scripts/fleet.mjs'),'--workers','1'],{env:{...process.env,WERK_DEV_PORT:String(port),WERK_STATUS_BASE:String(status),WERK_FACTORY_ADMIN_TOKEN:'unrelated-factory-token',WERK_LINE_OTHER_TOKEN:'unrelated-line-token'},stdio:'ignore'});
    exited=new Promise(r=>child.once('exit',code=>r(code)));
    let keys;
    for(let n=0;n<100;n++){try{keys=JSON.parse(await readFile(resultFile,'utf8'));break;}catch{}await new Promise(r=>setTimeout(r,30));}
    assert.deepEqual(keys,['WERK_ENROLLMENT_TOKEN']);child.kill('SIGTERM');assert.equal(await exited,0);
  }finally{if(child?.exitCode===null){child.kill('SIGTERM');await exited;}await rm(root,{recursive:true,force:true});}
});
