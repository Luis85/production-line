import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createArchives } from '../../scripts/release/archives.mjs';
import { setup } from '../../scripts/runtime/config.mjs';
import { latest, newer, digest } from '../../scripts/runtime/update/remote.mjs';
import { storeFor, selection, save, activeRoot, lock } from '../../scripts/runtime/update/store.mjs';
import { apply, check, recover } from '../../scripts/runtime/update/manager.mjs';
import { runNative, invocationFor } from '../../scripts/runtime/update/launcher.mjs';
import { main, parse } from '../../scripts/runtime/update/cli.mjs';

async function port() {
  const server = createServer(); await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const value = server.address().port; await new Promise(ok => server.close(ok)); return value;
}
async function fixture(t, { version = '0.2.0', stateFormat = 1, preflightFails = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'werk update test '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = join(directory, 'base release'), stateDir = join(directory, 'private state');
  await mkdir(base);
  const put = async (root, path, content) => { await mkdir(dirname(join(root,path)), { recursive: true }); await writeFile(join(root,path), content); };
  const script = value => `export async function main(args, {stdout=console.log}={}) { ${preflightFails && value === version ? "if(args[0]==='doctor') return 1;" : ''} stdout(JSON.stringify({ok:true,version:${JSON.stringify(value)},args})); return 0; }`;
  await put(base, 'scripts/runtime/cli.mjs', script('0.1.0'));
  await put(base, 'release-manifest.json', JSON.stringify({schemaVersion:1,name:'werk',version:'0.1.0',updateProtocol:1,stateFormat:1}));
  let first = await port(), second = await port(); while (second === first) second = await port();
  await setup({stateDir, project:'update-test', port:first, workerPort:second});
  await writeFile(join(stateDir,'history.txt'), 'tasks and worker evidence', {mode:0o600});
  const payload = [
    {path:'werk.mjs',content:Buffer.from('// fixture\n'),mode:0o755},
    {path:'scripts/runtime/cli.mjs',content:Buffer.from(script(version)),mode:0o644},
    {path:'scripts/release/verify.mjs',content:await readFile(new URL('../../scripts/release/verify.mjs',import.meta.url)),mode:0o644},
  ];
  const manifest={schemaVersion:1,name:'werk',version,updateProtocol:1,stateFormat,files:payload.map(x=>({path:x.path,bytes:x.content.length,sha256:digest(x.content)}))};
  payload.push({path:'release-manifest.json',content:Buffer.from(JSON.stringify(manifest)),mode:0o644});
  const {tarGzip}=await createArchives(payload.map(x=>({...x,path:`werk-${version}/${x.path}`})));
  const sums=`${digest(tarGzip)}  werk-${version}.tar.gz\n${'a'.repeat(64)}  werk-${version}.zip\n${'b'.repeat(64)}  install.mjs\n`;
  const urls=[];
  const fetcher=async url=>{ urls.push(url); if(url.endsWith('/releases/latest/download/SHA256SUMS'))return new Response(sums); assert.equal(url,`https://github.com/Luis85/production-line/releases/download/v${version}/werk-${version}.tar.gz`);return new Response(tarGzip); };
  const store=storeFor(base,stateDir), invocation={kind:'line'};
  return {directory,base,stateDir,store,invocation,fetcher,urls,sums,tarGzip};
}

test('stable release discovery pins version and rejects malformed, duplicate, mixed and prerelease metadata', async t=>{
  const f=await fixture(t);
  assert.equal((await latest({fetcher:f.fetcher})).version,'0.2.0');
  assert.equal(newer('0.10.0','0.9.0'),true);
  for(const [a,b] of [['0.2.0','0.2.0'],['0.1.9','0.2.0'],['1.9.0','2.0.0']]) assert.equal(newer(a,b),false);
  for(const value of ['0.2.0-rc.1','01.2.0','../escape']) assert.throws(()=>newer(value,'0.1.0'));
  for(const bad of [f.sums+f.sums, f.sums.replace('werk-0.2.0.zip','werk-0.3.0.zip'), f.sums.replaceAll('0.2.0','0.2.0-rc.1'),'x'.repeat(16385)]) await assert.rejects(latest({fetcher:async()=>new Response(bad)}));
  await assert.rejects(latest({fetcher:async()=>new Response('',{status:429})}),/429/);
});

test('verified update preserves live state bytes, takes a verified backup, selects a separate release and is idempotent',async t=>{
  const f=await fixture(t), original=await readFile(join(f.stateDir,'credentials.json'));
  assert.equal((await check(f.store,{fetcher:f.fetcher})).available,true);
  const result=await apply(f.store,f.invocation,{fetcher:f.fetcher});
  assert.equal(result.updated,true);assert.equal(result.version,'0.2.0');
  assert.deepEqual(await readFile(join(f.stateDir,'credentials.json')),original);
  assert.deepEqual(await readFile(join(result.backup,'state/credentials.json')),original);
  assert.equal(await readFile(join(f.stateDir,'history.txt'),'utf8'),'tasks and worker evidence');
  assert.equal(await activeRoot(f.store),join(f.store.releases,'werk-0.2.0'));
  assert.equal((await apply(f.store,f.invocation,{fetcher:f.fetcher})).updated,false);
  assert.equal(f.urls.filter(x=>x.endsWith('.tar.gz')).length,1);
  assert.equal((await readdir(f.store.backups)).length,1);
});

test('checksum mismatch, incompatible state format and failed candidate preflight never activate a release',async t=>{
  for(const options of [{},{stateFormat:2},{preflightFails:true}]) {
    const f=await fixture(t,options);
    const fetcher=Object.keys(options).length ? f.fetcher : async url=>url.endsWith('SHA256SUMS')?new Response(f.sums):new Response('corrupt');
    await assert.rejects(apply(f.store,f.invocation,{fetcher}));
    assert.equal((await selection(f.store)).active,null);
    assert.equal(await readFile(join(f.stateDir,'history.txt'),'utf8'),'tasks and worker evidence');
  }
});

test('recovery restores previous snapshot separately and disables updates on the matching previous release',async t=>{
  const f=await fixture(t);await apply(f.store,f.invocation,{fetcher:f.fetcher});
  await writeFile(join(f.stateDir,'history.txt'),'new tasks after upgrade');
  const destination=join(f.directory,'restored state');
  const result=await recover(f.store,destination);
  assert.equal(result.version,'0.1.0');assert.equal(result.releaseRoot,await realpath(f.base));
  assert.equal(await readFile(join(destination,'history.txt'),'utf8'),'tasks and worker evidence');
  assert.equal(await readFile(join(f.stateDir,'history.txt'),'utf8'),'new tasks after upgrade');
  assert.equal((await selection(storeFor(f.base,destination))).automatic,false);
  await assert.rejects(recover(f.store,destination),/already exists/);
});

test('automatic startup applies once and routes subsequent status to the selected release with stable state paths',async t=>{
  const f=await fixture(t), output=[], stderr=[];
  assert.equal(await runNative(f.base,['start','--state-dir',f.stateDir,'--json'],{fetcher:f.fetcher,stdout:x=>output.push(JSON.parse(x)),stderr:x=>stderr.push(x)}),0);
  assert.equal(output.at(-1).version,'0.2.0');assert.ok(output.some(x=>x.event==='updated'));
  assert.deepEqual(output.at(-1).args.slice(-2),['--state-dir',f.stateDir]);
  const count=f.urls.length;
  assert.equal(await runNative(f.base,['status','--state-dir',f.stateDir,'--json'],{fetcher:f.fetcher,stdout:x=>output.push(JSON.parse(x))}),0);
  assert.equal(output.at(-1).version,'0.2.0');assert.equal(f.urls.length,count);assert.deepEqual(stderr,[]);
});

test('offline startup uses installed runtime, explicit skip never fetches, and disabling persists',async t=>{
  const f=await fixture(t), output=[];
  const offline=async()=>{throw Error('offline');};
  assert.equal(await runNative(f.base,['start','--state-dir',f.stateDir,'--json'],{fetcher:offline,stdout:x=>output.push(JSON.parse(x))}),0);
  assert.equal(output.at(-1).version,'0.1.0');assert.ok(output.some(x=>x.event==='update_skipped'));
  const forbidden=async()=>assert.fail('network must not be used');
  assert.equal(await runNative(f.base,['start','--state-dir',f.stateDir,'--no-update'],{fetcher:forbidden,stdout(){}}),0);
  assert.equal(await main(['disable','--line','--state-dir',f.stateDir],{baseRoot:f.base,stdout(){}}),0);
  assert.equal((await selection(f.store)).automatic,false);
  assert.equal(await runNative(f.base,['start','--state-dir',f.stateDir],{fetcher:forbidden,stdout(){}}),0);
});

test('concurrent mutation lock blocks startup and changes while allowing status; corrupt selected files fail closed',async t=>{
  const f=await fixture(t), unlock=await lock(f.store,'test'), output=[];
  try {
    assert.equal(await main(['apply','--line','--state-dir',f.stateDir,'--json'],{baseRoot:f.base,stdout:x=>output.push(x),fetcher:f.fetcher}),1);
    assert.equal(await runNative(f.base,['start','--state-dir',f.stateDir],{stdout(){},stderr(){}}),1);
    assert.equal(await main(['status','--line','--state-dir',f.stateDir],{baseRoot:f.base,stdout(){}}),0);
  } finally {await unlock();}
  await apply(f.store,f.invocation,{fetcher:f.fetcher});
  await writeFile(join(await activeRoot(f.store),'werk.mjs'),'tampered');
  assert.equal(await runNative(f.base,['start','--state-dir',f.stateDir],{stdout(){},stderr(){},fetcher:async()=>assert.fail('must verify first')}),1);
});

test('update arguments reject invalid scope, repeated flags and unsafe rollback destinations',()=>{
  for(const args of [['apply','--line','--file','x'],['apply','--json','--json'],['rollback'],['check','--unknown']])assert.throws(()=>parse(args));
  assert.equal(parse(['check','--line']).options.line,true);
});

test('externally managed deployments bypass update storage and network and refuse manual activation',async t=>{
  const f=await fixture(t), environment={WERK_UPDATES:'external'};
  assert.equal(await runNative(f.base,['start','--state-dir',f.stateDir],{environment,fetcher:async()=>assert.fail('must not fetch'),stdout(){}}),0);
  await assert.rejects(readFile(f.store.path),{code:'ENOENT'});
  assert.equal(await main(['apply','--line','--state-dir',f.stateDir],{baseRoot:f.base,environment,stdout(){},stderr(){}}),1);
});


test('explicitly installed prereleases remain runnable without switching onto the stable update channel',async t=>{
  const f=await fixture(t), path=join(f.base,'release-manifest.json');
  const metadata=JSON.parse(await readFile(path,'utf8'));metadata.version='0.1.0-rc.1';await writeFile(path,JSON.stringify(metadata));
  const output=[];
  assert.equal(await runNative(f.base,['start','--state-dir',f.stateDir,'--json'],{fetcher:f.fetcher,stdout:x=>output.push(JSON.parse(x))}),0);
  assert.ok(output.some(x=>x.event==='update_skipped'));
  assert.equal((await selection(f.store)).active,null);
});


test('update selection survives canonical and aliased installation paths used by macOS launchers', {skip:process.platform==='win32'}, async t=>{
  const f=await fixture(t), alias=join(f.directory,'base alias');
  await symlink(f.base,alias,'dir');
  const aliased=storeFor(alias,f.stateDir);
  await apply(aliased,f.invocation,{fetcher:f.fetcher});
  assert.equal((await selection(f.store)).active,'0.2.0');
  const output=[];
  assert.equal(await runNative(f.base,['stop','--state-dir',f.stateDir,'--json'],{stdout:x=>output.push(JSON.parse(x))}),0);
  assert.equal(output.at(-1).version,'0.2.0');
});
