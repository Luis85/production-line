import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { fleetOptions, validateCredentials, assertFreePort, isMainScript } from '../../scripts/fleet.mjs';
const exec=promisify(execFile);

test('entrypoint detection leaves imported modules inert for missing or unrelated entry files', () => {
  assert.equal(isMainScript(new URL('../../scripts/fleet.mjs', import.meta.url), '/nonexistent/werk-entrypoint'), false);
  assert.equal(isMainScript(new URL('../../scripts/fleet.mjs', import.meta.url), new URL(import.meta.url)), false);
});

test('both fleet entrypoints execute through directory aliases while importing them has no lifecycle side effects', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-entry-alias-'));
  try {
    const root = join(directory, 'actual'), alias = join(directory, 'alias');
    await mkdir(join(root, 'scripts'), { recursive: true });
    await symlink(root, alias, 'dir');
    for (const name of ['fleet.mjs', 'factory-fleet.mjs']) await cp(new URL('../../scripts/' + name, import.meta.url), join(root, 'scripts', name));
    for (const name of ['fleet.mjs', 'factory-fleet.mjs']) await assert.rejects(exec(process.execPath, [join(alias, 'scripts', name), '--unknown']), error => error.code === 1 && /Usage: npm run dev:/.test(error.stderr));
    await rm(join(root, '.state'), { recursive: true, force: true });
    const importer = join(root, 'import-only.mjs');
    await writeFile(importer, "await import('./scripts/fleet.mjs'); await import('./scripts/factory-fleet.mjs'); console.log('imported');\n");
    const imported = await exec(process.execPath, [join(alias, 'import-only.mjs')]);
    assert.equal(imported.stdout.trim(), 'imported');
    assert.equal(imported.stderr, '');
    await assert.rejects(access(join(root, '.state')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('fleet rejects overlapping/out-of-range ports and ambiguous arguments',()=>{
  assert.deepEqual(fleetOptions([],{}),{count:3,port:3000,statusStart:4101,url:'http://127.0.0.1:3000'});
  assert.equal(fleetOptions(['--workers','2'],{WERK_DEV_PORT:'5000'}).url,'http://127.0.0.1:5000');
  for(const args of [['--workers'],['--workers','0'],['--workers','51'],['--foo','2'],['--workers','2','--other']])assert.throws(()=>fleetOptions(args,{}));
  for(const env of [{WERK_DEV_PORT:'NaN'},{WERK_STATUS_BASE:'65535'},{WERK_DEV_PORT:'4102'},{WERK_STATUS_BASE:'1.5'}])assert.throws(()=>fleetOptions([],env));
});
test('fleet credential reuse accepts only distinct generated secrets',()=>{
  const secrets={WERK_ADMIN_TOKEN:'a'.repeat(64),WERK_ENROLLMENT_TOKEN:'b'.repeat(64)};
  assert.deepEqual(validateCredentials({...secrets,UNTRUSTED:'ignored'}),secrets);
  assert.throws(()=>validateCredentials({...secrets,WERK_ENROLLMENT_TOKEN:secrets.WERK_ADMIN_TOKEN}));
  assert.throws(()=>validateCredentials({...secrets,WERK_ADMIN_TOKEN:"'$(unsafe)"}));
});
test('fleet port preflight refuses an occupied listener',async()=>{
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {await assert.rejects(assertFreePort(server.address().port));}finally{await new Promise(r=>server.close(r));}
});
test('clean standalone build removes stale output and compiles nested shared modules',async()=>{
  const root=await mkdtemp(join(tmpdir(),'werk-build-'));
  try {
    await mkdir(join(root,'scripts'));await cp(new URL('../../scripts/build.mjs',import.meta.url),join(root,'scripts/build.mjs'));
    await writeFile(join(root,'package.json'),JSON.stringify({version:'0.1.0',engines:{node:'>=24.0.0 <25'}}));
    await mkdir(join(root,'src/worker/dist'),{recursive:true});await mkdir(join(root,'src/shared/nested'),{recursive:true});
    await writeFile(join(root,'src/worker/cli.ts'),'#!/usr/bin/env node\nimport { value } from "../shared/nested/value.js"; console.log(value);\n');
    await writeFile(join(root,'src/shared/nested/value.ts'),'export const value: string = "portable";\n');
    await writeFile(join(root,'src/worker/dist/stale.js'),'old build');
    await cp(new URL('../../src/shared/ui',import.meta.url),join(root,'src/shared/ui'),{recursive:true});
    await cp(new URL('../../src/worker/webview',import.meta.url),join(root,'src/worker/webview'),{recursive:true,filter:path=>!path.includes('.nuxt-ui')});
    await symlink(fileURLToPath(new URL('../../node_modules',import.meta.url)),join(root,'node_modules'),process.platform==='win32'?'junction':'dir');
    await exec(process.execPath,[join(root,'scripts/build.mjs'),'worker','--dist-only']);
    await assert.rejects(access(join(root,'src/worker/dist/stale.js')));
    const target=join(root,'relocated');await cp(join(root,'src/worker/dist'),target,{recursive:true});
    await rm(join(root,'src'),{recursive:true});
    const result=await exec(process.execPath,[join(target,'worker/cli.js')],{cwd:tmpdir()});assert.equal(result.stdout.trim(),'portable');
    const webview=await readFile(join(target,'worker/public/index.html'),'utf8');assert.match(webview,/assets\/.*\.js/);
    const manifest=JSON.parse(await readFile(join(target,'package.json'),'utf8'));assert.equal(manifest.bin['werk-worker'],'worker/cli.js');
  } finally {await rm(root,{recursive:true,force:true});}
});
test('fleet reuses credentials, exports custom URL and drains workers before server', { skip:process.platform==='win32' }, async()=>{
  const root=await mkdtemp(join(tmpdir(),'werk-fleet-'));
  const listeners=[createServer(),createServer()];
  await Promise.all(listeners.map(s=>new Promise(r=>s.listen(0,'127.0.0.1',r))));
  const [port,status]=listeners.map(s=>s.address().port);await Promise.all(listeners.map(s=>new Promise(r=>s.close(r))));
  let child;
  try{
    await mkdir(join(root,'scripts'));await cp(new URL('../../scripts/fleet.mjs',import.meta.url),join(root,'scripts/fleet.mjs'));
    for(const app of ['orchestrator','worker'])await mkdir(join(root,'src',app,'dist',app),{recursive:true});
    const events=join(root,'events.txt');
    const preserved={WERK_ADMIN_TOKEN:'a'.repeat(64),WERK_ENROLLMENT_TOKEN:'b'.repeat(64)};
    await mkdir(join(root,'.state/fleet'),{recursive:true});
    await writeFile(join(root,'.state/fleet/credentials.json'),JSON.stringify(preserved));
    await writeFile(join(root,'src/orchestrator/dist/orchestrator/cli.js'),`const http=require('node:http'),fs=require('node:fs');const p=Number(process.argv[process.argv.indexOf('--port')+1]);const s=http.createServer((req,res)=>res.end('{}'));s.listen(p,'127.0.0.1');process.once('SIGTERM',()=>{fs.appendFileSync(${JSON.stringify(events)},'server\\n');s.close();});`);
    await writeFile(join(root,'src/worker/dist/worker/cli.js'),`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(events)},'started\\n');const timer=setInterval(()=>{},1000);process.once('SIGTERM',()=>{fs.appendFileSync(${JSON.stringify(events)},'worker\\n');clearInterval(timer);});`);
    const {spawn}=await import('node:child_process');
    const alias = join(root, 'project-alias'); await symlink(root, alias, 'dir');
    child=spawn(process.execPath,[join(alias,'scripts/fleet.mjs'),'--workers','1'],{env:{...process.env,WERK_DEV_PORT:String(port),WERK_STATUS_BASE:String(status)},stdio:'pipe'});
    let stderr='';child.stderr.on('data',d=>stderr+=d);
    const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
    let started=false;
    for(let i=0;i<100;i++){try{started=(await readFile(events,'utf8')).includes('started');}catch{}if(started)break;await new Promise(r=>setTimeout(r,30));}
    assert.ok(started,stderr);child.kill('SIGTERM');
    const result=await Promise.race([exited,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('fleet shutdown timeout')),5000);timer.unref();})]);
    assert.equal(result.code,0,stderr);assert.equal(await readFile(events,'utf8'),'started\nworker\nserver\n');
    const state=join(root,'.state/fleet');
    assert.match(await readFile(join(state,'env.sh'),'utf8'),new RegExp(`WERK_URL='http://127.0.0.1:${port}'`));
    assert.match(await readFile(join(state,'env.ps1'),'utf8'),/\$env:WERK_ADMIN_TOKEN/);
    assert.deepEqual(validateCredentials(JSON.parse(await readFile(join(state,'credentials.json'),'utf8'))),preserved);
    await assert.rejects(access(join(state,'fleet.lock')));
  } finally {if(child?.exitCode===null)child.kill('SIGKILL');await rm(root,{recursive:true,force:true});}
});
