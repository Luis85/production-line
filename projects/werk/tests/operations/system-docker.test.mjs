import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { composeSystem, systemProject } from '../../scripts/docker/system-compose.mjs';
import { validateDefinition } from '../../scripts/system/definition.mjs';
import { loadSystem, factoryCredentials } from '../../scripts/system/state.mjs';
const exec = promisify(execFile), helper = resolve('scripts/docker/system.mjs');
const definition = () => validateDefinition({ schemaVersion:1,id:'docker-test',environment:'docker',factory:{id:'root',name:'Factory',port:32300,subFactories:[{id:'child',name:'Child',parentId:'root'}]},productionLines:[
  {id:'alpha',name:'Alpha',project:'alpha',factoryId:'child',orchestrator:{port:32301},workers:{count:2,statusPort:32401}},
  {id:'beta',name:'Beta',project:'beta',orchestrator:{port:32302},workers:{count:1,statusPort:32403}}
] });
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'werk-system-docker-')), state=join(root,'state with spaces'), file=join(root,'definition.yaml');
  await mkdir(state,{mode:0o700}); await writeFile(file,JSON.stringify(definition())); t.after(()=>rm(root,{recursive:true,force:true}));
  const run=(command,...args)=>exec(process.execPath,[helper,command,'--file',file,...args],{env:{...process.env,WERK_CONTAINER_STATE_DIR:state}});
  return {root,state,file,run,setup:()=>run('setup','--host-state',state)};
}
test('Docker system plan is pure and setup preserves private credentials across retries',async t=>{
  const f=await fixture(t); const plan=JSON.parse((await f.run('plan')).stdout); assert.equal(plan.totals.workers,3); assert.equal(plan.totals.factories,2);
  await assert.rejects(readFile(join(f.state,'system.json')),e=>e.code==='ENOENT');
  const first=await f.setup(), credentials=await readFile(join(f.state,'lines/alpha/credentials.json'),'utf8'); const second=await f.setup();
  assert.equal(await readFile(join(f.state,'lines/alpha/credentials.json'),'utf8'),credentials); if (process.platform !== 'win32') assert.equal((await stat(join(f.state,'system.json'))).mode&0o777,0o600);
  const loaded=await loadSystem(join(f.state,'factory-input')); const keys=await factoryCredentials(join(f.state,'factory-input'),loaded).catch(()=>null);
  // Factory credentials remain in its separate writable mount, not the input view.
  assert.equal(keys,null); assert.equal(loaded.id,definition().id);
  const compose=await readFile(join(f.state,'docker-compose.json'),'utf8');
  for(const token of Object.values(JSON.parse(credentials))) assert.ok(!(first.stdout+second.stdout+compose).includes(token));
  assert.equal(JSON.parse(compose).services['line-1-worker-2'].volumes[0].source,join(f.state,'lines/alpha/workers/worker-2'));
});
test('Docker system generation keeps worker boundaries, loopback ports and installation identity',()=>{
  const value=definition(), compose=composeSystem(value,{hostState:'/private/$state',image:'werk:test',uid:'123',gid:'456'});
  assert.equal(Object.keys(compose.services).length,6);
  assert.deepEqual(compose.services.factory.volumes.map(v=>v.source),[join('/private/$$state','factory-input'),join('/private/$$state','factory')]);
  for(const service of Object.values(compose.services)) { assert.equal(service.user,'123:456'); assert.ok(service.ports.every(port=>port.startsWith('127.0.0.1:'))); }
  const worker=compose.services['line-1-worker-1']; assert.equal(worker.volumes.length,1); assert.ok(worker.volumes[0].source.endsWith(join('workers','worker-1'))); assert.equal(worker.read_only,true);
  assert.notEqual(systemProject(value,'/one'),systemProject(value,'/two'));
  const named=composeSystem(value,{hostState:'C:\\Werk',image:'werk:test',volume:'owned-state'});
  assert.equal(named.services.factory.volumes[0].volume.subpath,'factory-input'); assert.equal(named.services['line-1-worker-1'].volumes[0].volume.subpath,'lines/alpha/workers/worker-1');
});
test('Docker system refuses environment and definition drift before rotating state',async t=>{
  const f=await fixture(t); await writeFile(f.file,JSON.stringify({...definition(),environment:'native'}));
  await assert.rejects(f.setup(),e=>/requires environment docker/.test(e.stderr)); await assert.rejects(readFile(join(f.state,'system.json')),e=>e.code==='ENOENT');
  await writeFile(f.file,JSON.stringify(definition())); await f.setup(); const credentials=await readFile(join(f.state,'factory/credentials.json'),'utf8');
  const changed=definition(); changed.productionLines[0].workers.count=1; await writeFile(f.file,JSON.stringify(changed));
  await assert.rejects(f.setup(),e=>/differs/.test(e.stderr)); await assert.rejects(f.run('verify'),e=>/differs/.test(e.stderr));
  assert.equal(await readFile(join(f.state,'factory/credentials.json'),'utf8'),credentials);
});
test('Docker system metadata refuses symlink replacement and enrollment drift',async t=>{
  const f=await fixture(t); await f.setup(); const outside=join(f.root,'outside'); await writeFile(outside,'untouched'); await rm(join(f.state,'docker-compose.json')); await symlink(outside,join(f.state,'docker-compose.json'));
  await assert.rejects(f.setup(),e=>/regular file/.test(e.stderr)); assert.equal(await readFile(outside,'utf8'),'untouched');
  const enrollment=join(f.state,'lines/alpha/workers/worker-1/enrollment.json'); await writeFile(enrollment,JSON.stringify({bad:true}),{mode:0o600});
  await assert.rejects(f.setup(),e=>/differs/.test(e.stderr));
});

// Source-contract guard only: Windows PowerShell itself is exercised on a Windows host.
test('Windows launchers refuse missing volumes for preexisting installation pointers',async()=>{
  for(const path of ['werk-docker.ps1','scripts/docker/system.ps1']) {
    const source=await readFile(path,'utf8');
    assert.match(source,/\$pointerExisted=Test-Path -LiteralPath \$pointer/);
    assert.match(source,/if \(\$pointerExisted -or (?:-not \$setup|\$commandName -ne 'setup')\)/);
    assert.ok(source.indexOf("Invoke-Docker @('volume','inspect'") < source.indexOf("Invoke-Docker @('build'"),'ownership validation precedes image build');
    assert.match(source,/existing installation state will not be recreated/);
  }
});

test('Docker start refuses a missing state directory without provisioning or building',async t=>{
  const f=await fixture(t), bin=join(f.root,'bin'), missing=join(f.root,'missing-state'); await mkdir(bin);
  if (process.platform === 'win32') {
    const harness=join(bin,'missing-state.ps1');
    await writeFile(harness,`param([string]$Launcher,[string]$State)
function global:docker {
  if ($args.Count -eq 2 -and $args[0] -eq 'compose' -and $args[1] -eq 'version') { $global:LASTEXITCODE=0; return }
  throw 'UnexpectedDockerMutation'
}
& $Launcher start --state-dir $State --json
exit $LASTEXITCODE
`);
    await assert.rejects(exec('pwsh',['-NoProfile','-NonInteractive','-File',harness,'-Launcher',resolve('scripts/docker/system.ps1'),'-State',missing]),error=>
      error.code===1 && /missing-state/.test(error.stderr) && /does not exist|Cannot find path/.test(error.stderr) && !/UnexpectedDockerMutation/.test(error.stdout+error.stderr));
  } else {
    await writeFile(join(bin,'docker'), '#!/bin/sh\nif [ "$1" = compose ] && [ "$2" = version ]; then exit 0; fi\necho UnexpectedDockerMutation >&2\nexit 99\n',{mode:0o755});
    await assert.rejects(exec('/bin/bash',[resolve('werk-docker.sh'),'system','start','--state-dir',missing,'--json'],{env:{...process.env,PATH:bin+':'+process.env.PATH}}),error=>/System state missing/.test(error.stderr)&&!error.stderr.includes('UnexpectedDockerMutation'));
  }
  await assert.rejects(stat(missing),error=>error.code==='ENOENT');
  assert.match(await readFile('scripts/docker/system.ps1','utf8'),/\$setup=\$action -in @\('setup','up'\)/);
});
