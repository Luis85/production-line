import { testErrorCode } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CodexAdapter, codexConfiguration } from '../../src/worker/dist/worker/infrastructure/codex-adapter.js';
import { RepositoryDiscovery } from '../../src/worker/dist/worker/infrastructure/repository-discovery.js';
import { RepositoryManager } from '../../src/worker/dist/worker/infrastructure/repositories.js';
import { configuration } from '../../src/worker/dist/worker/config.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { executeAttempt } from '../../src/worker/dist/worker/application/execute-attempt.js';
import { Store } from '../../src/orchestrator/dist/orchestrator/persistence/store.js';
import { validateSnapshot } from '../../src/worker/dist/shared/snapshots.js';
import { taskInput } from '../../src/worker/dist/shared/validation.js';
import { WorkerConsumption } from '../../src/worker/dist/worker/application/consumption.js';
import { WorkerConsumptionJournal } from '../../src/worker/dist/worker/infrastructure/journal/consumption.js';
const linux = { skip: process.platform !== 'linux' };
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, program = "require('node:fs').appendFileSync('README.md','Human review is required.\\n');") {
  const directory = await mkdtemp(join(tmpdir(), 'werk-live-')), repository=join(directory,'repository'), stateDir=join(directory,'state'), executable=join(directory,'provider');
  await mkdir(repository); await writeFile(join(repository,'README.md'),'# Fixture\n');
  const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:repository,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init');git('add','README.md');git('-c','user.name=Werk Test','-c','user.email=werk@example.invalid','commit','-m','fixture');
  await writeFile(executable,`#!${process.execPath}\n${program}\n`); await chmod(executable,0o700);
  const config={executable,repository,allowedPaths:['README.md']};
  const store=new Store(':memory:',60000);
  /** @type {import('../../src/shared/contracts.js').Profile} */
  const profile={id:'live',provider:'codex',mode:'cli',maxParallel:1};
  const registration=store.register('demo',[profile],{maxParallel:1,maxAttempts:1,order:'priority',configHash:'fixture'}),worker=store.worker(registration.token);
  const created=store.submit({project:'demo',title:'Improve README',criteria:['Human review required'],provider:'codex',executionMode:'cli'},'task');
  const task=store.claim(worker,'claim'),journal=new SnapshotJournal(stateDir,'fixture','prompt'); await journal.init();
  t.after(async()=>{journal.close();store.close();await rm(directory,{recursive:true,force:true});});
  const client={async heartbeat(t){return store.heartbeat(worker,t.id,t.lease,t.attempt);},async publishSnapshot(s){store.snapshot(worker,s);},async complete(t){store.finish(worker,t.id,t.lease,t.attempt);},async abandon(t){store.abandon(worker,t.id,t.lease,t.attempt);}};
  const state={lastContact:null,heartbeatErrors:0,lastError:null,lastSnapshot:null,completedSimulations:0,completedReviews:0};
  const adapter=new CodexAdapter(config,stateDir,'Implement the assigned task only.');
  const dependencies={client,journal,adapter,identity:{id:worker.id,project:'demo'},profiles:[profile],state,async saveState(){},timeoutMs:5000};
  return {directory,repository,stateDir,executable,config,store,worker,profile,created,task,journal,state,adapter,dependencies};
}
test('live execution opt-in is validated and cannot silently change simulated tasks',linux,async()=>{
  assert.throws(()=>taskInput({project:'demo',title:'Task',criteria:['Done'],executionMode:'cli'}),/provider codex/);
  for(const path of ['../secret','.env','folder/.env','credentials.json','private.key','/absolute','a\\b'])assert.throws(()=>codexConfiguration({executable:'/bin/codex',repository:'/repo',allowedPaths:[path]}));
  const config={schemaVersion:1,execution:{mode:'cli',codex:{executable:'/bin/codex',repository:'/repo',allowedPaths:['README.md']}}};
  const effective=await configuration({},config);assert.equal(effective.profiles[0].mode,'cli');assert.equal(effective.policy.maxAttempts,1);
  await assert.rejects(configuration({}, {...config,scheduler:{maxParallel:2}}),/one profile/);
  await assert.rejects(configuration({}, {...config,profiles:[{id:'wrong',provider:'claude',mode:'cli'}]}),/[Pp]rofiles/);
});
test('scheduler fences execution mode and project; live work never consumes mock tasks',linux,async t=>{
  const f=await fixture(t);const mock=f.store.submit({project:'demo',title:'Mock',criteria:['Done'],provider:'codex'},'mock');
  const other=f.store.submit({project:'other',title:'Other',criteria:['Done'],provider:'codex',executionMode:'cli'},'other');
  f.store.abandon(f.worker,f.task.id,f.task.lease,f.task.attempt);
  assert.equal(f.store.claim(f.worker,'again'),null);assert.equal(f.store.get(mock.id).status,'queued');assert.equal(f.store.get(other.id).status,'queued');
});
test('live process produces durable review evidence without modifying source or claiming verified tests',linux,async t=>{
  const f=await fixture(t);await executeAttempt(f.task,new AbortController().signal,f.dependencies);
  const after=await f.journal.read(f.task.lease,'after'),patch=await readFile(join(f.stateDir,after.review.artifactPath),'utf8');
  assert.equal(f.store.get(f.task.id).status,'review');assert.equal(after.mode,'cli');assert.equal(after.execution.outcome,'change-set');assert.equal(after.quality.tests,'not_run');assert.equal(after.usage.source,'unavailable_provider');
  assert.equal(hash(patch),after.review.patchSha256);assert.match(patch,/Human review is required/);assert.equal(await readFile(join(f.repository,'README.md'),'utf8'),'# Fixture\n');assert.equal(f.state.completedSimulations,0);assert.equal(f.state.completedReviews,1);
  assert.equal(f.store.snapshots({project:'demo'}).length,2);assert.deepEqual(await readdir(join(f.stateDir,'workspaces')),[f.task.lease]);
  const retained=JSON.parse(await readFile(join(f.stateDir,'workspaces',f.task.lease,'worktree.json'),'utf8'));
  assert.ok(retained.workspace.startsWith(f.repository+'/'));
  assert.match(await readFile(join(retained.workspace,'README.md'),'utf8'),/Human review is required/);
  assert.match(await readFile(join(retained.workspace,'.git'),'utf8'),/^gitdir: /);
  const worktrees=execFileSync('git',['worktree','list','--porcelain'],{cwd:f.repository,encoding:'utf8'});
  assert.ok(worktrees.includes('worktree '+retained.workspace));
  assert.deepEqual(await readdir(join(f.stateDir,'git-metadata')),[]);
  await assert.rejects(f.adapter.run(f.task,new AbortController().signal),/already exists; recovery must not rerun/);
  assert.throws(()=>validateSnapshot({...after,mode:'mock'}));
  await writeFile(join(f.stateDir,after.review.artifactPath),'tampered');await assert.rejects(f.adapter.verifyReview(f.task,after.review),/missing or changed/);
});
test('live provider fails closed on outside-allowlist edits and redacts process diagnostics',linux,async t=>{
  const f=await fixture(t,"require('node:fs').writeFileSync('outside.txt','unauthorized');process.stderr.write('secret-test-credential');");
  await executeAttempt(f.task,new AbortController().signal,f.dependencies);
  const after=await f.journal.read(f.task.lease,'after');assert.equal(after.execution.outcome,'failed');assert.equal(f.store.get(f.task.id).status,'blocked');assert.match(after.execution.error,/outside the operator allowlist/);assert.ok(!JSON.stringify(after).includes('secret-test-credential'));
});
test('nonzero provider status cannot finish a task despite writing an allowed patch',linux,async t=>{
  const f=await fixture(t,"require('node:fs').appendFileSync('README.md','change');process.stderr.write('secret-test-credential');process.exit(7);");
  await executeAttempt(f.task,new AbortController().signal,f.dependencies);const after=await f.journal.read(f.task.lease,'after');assert.equal(after.execution.outcome,'failed');assert.equal(f.store.get(f.task.id).status,'blocked');assert.ok(!JSON.stringify(after).includes('secret-test-credential'));assert.equal(after.review,undefined);
});
test('timeout terminates a live process and records failed evidence instead of review',linux,async t=>{
  const f=await fixture(t,"setInterval(()=>{},1000);");f.dependencies.timeoutMs=300;const started=Date.now();await executeAttempt(f.task,new AbortController().signal,f.dependencies);
  assert.ok(Date.now()-started<5000);const after=await f.journal.read(f.task.lease,'after');assert.equal(after.execution.outcome,'failed');assert.match(after.execution.error,/timed out/);assert.equal(f.store.get(f.task.id).status,'blocked');
});
test('provider process receives no Werk credentials and only fixed sandbox arguments',linux,async t=>{
  const previous=process.env.WERK_ADMIN_TOKEN;process.env.WERK_ADMIN_TOKEN='private-test-token';t.after(()=>{if(previous===undefined)delete process.env.WERK_ADMIN_TOKEN;else process.env.WERK_ADMIN_TOKEN=previous;});
  const f=await fixture(t,"const assert=require('node:assert/strict');assert.equal(process.env.WERK_ADMIN_TOKEN,undefined);assert.ok(process.argv.includes('workspace-write'));assert.ok(process.argv.includes('approval_policy=\"never\"'));assert.ok(!process.argv.includes('--dangerously-bypass-approvals-and-sandbox'));require('node:fs').appendFileSync('README.md','Safe environment.');");
  await executeAttempt(f.task,new AbortController().signal,f.dependencies);assert.equal(f.store.get(f.task.id).status,'review');
});


test('model-written Git filters cannot execute during trusted patch post-processing',linux,async t=>{
  const program = "const fs=require('node:fs'),path=require('node:path');fs.appendFileSync('README.md','Reviewed change.');fs.appendFileSync('.git/config','\\n[filter \"evil\"]\\n clean = touch '+path.resolve(process.cwd(),'filter-escaped')+'\\n');";
  const f=await fixture(t,program);
  await writeFile(join(f.repository,'.gitattributes'),'README.md filter=evil\n');
  const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:f.repository,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git('add','.gitattributes');git('-c','user.name=Werk Test','-c','user.email=werk@example.invalid','commit','-m','Filter fixture');
  await executeAttempt(f.task,new AbortController().signal,f.dependencies);
  assert.equal(f.store.get(f.task.id).status,'review');
  const retained=JSON.parse(await readFile(join(f.stateDir,'workspaces',f.task.lease,'worktree.json'),'utf8'));
  await assert.rejects(readFile(join(retained.workspace,'filter-escaped')),error=>testErrorCode(error)==='ENOENT');
  assert.ok(!(await readFile(join(f.repository,'.git','config'),'utf8')).includes('evil'));
});


test('failed native attempts retain worktree changes and cannot replay the provider',linux,async t=>{
  const f=await fixture(t,"require('node:fs').appendFileSync('README.md','Only once.');process.exit(7);");
  await assert.rejects(f.adapter.run(f.task,new AbortController().signal));
  const retained=JSON.parse(await readFile(join(f.stateDir,'workspaces',f.task.lease,'worktree.json'),'utf8'));
  assert.equal(await readFile(join(retained.workspace,'README.md'),'utf8'),'# Fixture\nOnly once.');
  assert.match(await readFile(join(retained.workspace,'.git'),'utf8'),/^gitdir: /);
  await assert.rejects(f.adapter.run(f.task,new AbortController().signal),/already exists; recovery must not rerun/);
  assert.equal(await readFile(join(retained.workspace,'README.md'),'utf8'),'# Fixture\nOnly once.');
  assert.equal(await readFile(join(f.repository,'README.md'),'utf8'),'# Fixture\n');
});

test('model Git metadata cannot redirect trusted postprocessing into the shared repository',linux,async t=>{
  const f=await fixture(t);
  const originalConfig=await readFile(join(f.repository,'.git','config'),'utf8');
  const originalHead=execFileSync('git',['rev-parse','HEAD'],{cwd:f.repository,encoding:'utf8'});
  const program=`const fs=require('node:fs'),assert=require('node:assert/strict');assert.ok(fs.statSync('.git').isDirectory());assert.ok(!fs.existsSync('.git/commondir'));assert.ok(!fs.existsSync('.git/objects/info/alternates'));fs.rmSync('.git',{recursive:true});fs.symlinkSync(${JSON.stringify(join(f.repository,'.git'))},'.git');fs.appendFileSync('README.md','Safely isolated.');`;
  await writeFile(f.executable,`#!${process.execPath}\n${program}\n`);
  const result=await f.adapter.run(f.task,new AbortController().signal);
  assert.match(await readFile(join(f.stateDir,result.review.artifactPath),'utf8'),/Safely isolated/);
  assert.equal(await readFile(join(f.repository,'.git','config'),'utf8'),originalConfig);
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:f.repository,encoding:'utf8'}),originalHead);
  assert.equal(execFileSync('git',['diff','--cached'],{cwd:f.repository,encoding:'utf8'}),'');
  const retained=JSON.parse(await readFile(join(f.stateDir,'workspaces',f.task.lease,'worktree.json'),'utf8'));
  assert.match(await readFile(join(retained.workspace,'.git'),'utf8'),/^gitdir: /);
});

test('legacy native Codex refuses declined or replaced installation repositories before any worktree or provider invocation',linux,async t=>{
  const f=await fixture(t), marker=join(f.directory,'provider-invoked');
  await writeFile(f.executable,`#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)},'called\\n');require('node:fs').appendFileSync('README.md','Approved repository.');\n`);
  const initial=new RepositoryDiscovery(f.stateDir,f.repository,new AbortController().signal,f.repository);await initial.init([]);await initial.record('declined');
  const discovery=new RepositoryDiscovery(f.stateDir,f.repository,new AbortController().signal,f.repository);await discovery.init([]);
  const adapter=new CodexAdapter(f.config,f.stateDir,'Explicit consent required.',undefined,path=>discovery.assertAllowed(path));
  assert.equal(discovery.legacyAllowed(),false);
  await assert.rejects(adapter.run(f.task,new AbortController().signal),/Approve the detected/);
  await assert.rejects(readFile(marker),error=>testErrorCode(error)==='ENOENT');
  await assert.rejects(readdir(join(f.repository,'.werk/worktrees')),error=>testErrorCode(error)==='ENOENT');
  await assert.rejects(readdir(join(f.stateDir,'workspaces',f.task.lease)),error=>testErrorCode(error)==='ENOENT');
  await discovery.record('accepted');assert.equal(discovery.legacyAllowed(),true);
  await rename(join(f.repository,'.git'),join(f.directory,'previous.git'));
  const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:f.repository,encoding:'utf8',stdio:'pipe'});
  git('init');git('add','README.md');git('-c','user.name=Werk Test','-c','user.email=werk@example.invalid','commit','-m','Replacement repository');
  await assert.rejects(adapter.run(f.task,new AbortController().signal),/Approve the detected/);
  assert.equal(discovery.legacyAllowed(),false);
  await assert.rejects(readFile(marker),error=>testErrorCode(error)==='ENOENT');
  await assert.rejects(readdir(join(f.repository,'.werk/worktrees')),error=>testErrorCode(error)==='ENOENT');
  await discovery.verify(discovery.view().id);await discovery.record('accepted');
  const result=await adapter.run(f.task,new AbortController().signal);
  assert.equal(result.kind,'change-set');assert.equal(await readFile(marker,'utf8'),'called\n');
  assert.equal(await readFile(join(f.repository,'README.md'),'utf8'),'# Fixture\n');
});

test('native Codex routes one project to assigned repositories and preserves project-id fallback',linux,async t=>{
  const f=await fixture(t), other=join(f.directory,'other');
  execFileSync('git',['clone','--no-hardlinks','--',f.repository,other],{stdio:'pipe'});
  const repositories=new RepositoryManager({pollMs:30000,items:[{id:'demo',path:f.repository,remote:'origin',watch:false},{id:'other',path:other,remote:'origin',watch:false}]});
  const adapter=new CodexAdapter({...f.config,repository:undefined},f.stateDir,'Assigned work only.',repositories);
  await assert.rejects(f.adapter.run({...f.task,repository:'demo',lease:f.task.lease+'-no-assignments'},new AbortController().signal),/not assigned/);
  const emptyAssignments=new CodexAdapter(f.config,f.stateDir,'Assigned work only.',new RepositoryManager({pollMs:30000,items:[]}));
  await assert.rejects(emptyAssignments.run({...f.task,repository:'demo',lease:f.task.lease+'-empty-assignments'},new AbortController().signal),/not assigned/);
  for(const repository of ['demo','other']) {
    const task={...f.task,repository,lease:f.task.lease+'-'+repository};
    await adapter.run(task,new AbortController().signal);
    const retained=JSON.parse(await readFile(join(f.stateDir,'workspaces',task.lease,'worktree.json'),'utf8'));
    assert.equal(retained.repositoryId,repository);
    assert.ok(retained.workspace.startsWith((repository==='demo'?f.repository:other)+'/'));
  }
  await adapter.run({...f.task,lease:f.task.lease+'-project-fallback'},new AbortController().signal);
  const legacyFallback=new CodexAdapter(f.config,f.stateDir,'Assigned work only.',repositories);
  await assert.rejects(legacyFallback.run({...f.task,repository:'unassigned',lease:f.task.lease+'-unknown-repository'},new AbortController().signal),/assigned|Unknown|unknown|configured/);
  await assert.rejects(legacyFallback.run({...f.task,project:'unassigned',lease:f.task.lease+'-unknown'},new AbortController().signal),/assigned|Unknown|unknown|configured/);
  assert.equal(await readFile(join(f.repository,'README.md'),'utf8'),'# Fixture\n');
  assert.equal(await readFile(join(other,'README.md'),'utf8'),'# Fixture\n');
});


test('native Codex imports a pinned remote-only commit while preserving a dirty base checkout',linux,async t=>{
  const f=await fixture(t), upstream=join(f.directory,'upstream');
  const git=(cwd,...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,encoding:'utf8',stdio:'pipe'}).trim();
  git(f.directory,'clone','--no-hardlinks','--',f.repository,upstream);
  await writeFile(join(upstream,'README.md'),'# Remote commit\n');
  git(upstream,'add','README.md');git(upstream,'-c','user.name=Werk Test','-c','user.email=werk@example.invalid','commit','-m','Remote only');
  const remoteCommit=git(upstream,'rev-parse','HEAD'), localCommit=git(f.repository,'rev-parse','HEAD');
  git(f.repository,'remote','add','origin',upstream);
  await writeFile(join(f.repository,'README.md'),'# Operator uncommitted work\n');
  const repositories=new RepositoryManager({pollMs:30000,items:[{id:'demo',path:f.repository,remote:'origin',watch:false}]});
  t.after(()=>repositories.close());
  const adapter=new CodexAdapter({...f.config,repository:undefined},f.stateDir,'Assigned work only.',repositories);
  const result=await adapter.run({...f.task,context:{commit:remoteCommit,sha256:'0'.repeat(64),featureId:'remote-context',path:'context.md'}},new AbortController().signal);
  assert.equal(result.review.baseCommit,remoteCommit);
  assert.equal(repositories.view()[0].state,'dirty');
  assert.equal(git(f.repository,'rev-parse','HEAD'),localCommit);
  assert.equal(await readFile(join(f.repository,'README.md'),'utf8'),'# Operator uncommitted work\n');
  const retained=JSON.parse(await readFile(join(f.stateDir,'workspaces',f.task.lease,'worktree.json'),'utf8'));
  assert.equal(await readFile(join(retained.workspace,'README.md'),'utf8'),'# Remote commit\nHuman review is required.\n');
  const patch=await readFile(join(f.stateDir,result.review.artifactPath),'utf8');
  assert.match(patch,/Remote commit/);assert.match(patch,/Human review is required/);
  assert.ok(!patch.includes('Operator uncommitted work'));
});


test('model-written submodule metadata cannot execute during trusted patch post-processing',linux,async t=>{
  const f=await fixture(t), marker=join(f.directory,'submodule-escaped'), hook=join(f.directory,'fsmonitor');
  const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:f.repository,encoding:'utf8',stdio:'pipe'}).trim();
  const commit=git('rev-parse','HEAD');
  git('update-index','--add','--cacheinfo',`160000,${commit},sub`);
  git('-c','user.name=Werk Test','-c','user.email=werk@example.invalid','commit','-m','Track gitlink');
  await writeFile(hook,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'escaped');\n`,{mode:0o700});
  const program=`const fs=require('node:fs');fs.cpSync('.git','sub/.git',{recursive:true});fs.appendFileSync('sub/.git/config',${JSON.stringify('\n[core]\n fsmonitor = '+hook+'\n')});fs.appendFileSync('README.md','Allowed edit.');`;
  await writeFile(f.executable,`#!${process.execPath}\n${program}\n`);
  await assert.rejects(f.adapter.run(f.task,new AbortController().signal),/changes to Git submodules are unsupported/);
  await assert.rejects(readFile(marker),error=>testErrorCode(error)==='ENOENT');
  assert.equal(await readFile(join(f.repository,'README.md'),'utf8'),'# Fixture\n');
});


test('ignored provider files cannot hide outside-allowlist changes in retained worktrees',linux,async t=>{
  const f=await fixture(t,"const fs=require('node:fs');fs.appendFileSync('README.md','Approved edit.');fs.mkdirSync('ignored');fs.writeFileSync('ignored/private.txt','Unapproved artifact.');");
  await writeFile(join(f.repository,'.gitignore'),'ignored/\n');
  const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:f.repository,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git('add','.gitignore');git('-c','user.name=Werk Test','-c','user.email=werk@example.invalid','commit','-m','Ignore generated files');
  await assert.rejects(f.adapter.run(f.task,new AbortController().signal),/outside the operator allowlist/);
  const retained=JSON.parse(await readFile(join(f.stateDir,'workspaces',f.task.lease,'worktree.json'),'utf8'));
  assert.equal(await readFile(join(retained.workspace,'ignored','private.txt'),'utf8'),'Unapproved artifact.');
  await assert.rejects(readFile(join(f.stateDir,'review',f.task.lease,'change.patch')),error=>testErrorCode(error)==='ENOENT');
  assert.equal(await readFile(join(f.repository,'README.md'),'utf8'),'# Fixture\n');
});

for (const failed of [false, true]) test('native Codex consumption accounts for the actual provider invocation ' + (failed ? 'after failure' : 'before patch review'), linux, async t => {
  const program = "const fs=require('node:fs'),assert=require('node:assert/strict');assert.ok(process.argv.includes('--json'));fs.appendFileSync('README.md','Accounted change.');console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:30,cached_input_tokens:20,output_tokens:10}}));" + (failed ? 'process.exitCode=7;' : '');
  const f = await fixture(t, program);
  /** @type {import('../../src/worker/application/consumption.js').ConsumptionPolicy} */
  const policy = { enabled: true, period: 'daily', allowance: 100, workerPercent: 50, perRunReservation: 40 };
  const consumption = new WorkerConsumption(new WorkerConsumptionJournal(f.stateDir), () => policy); await consumption.init(); t.after(() => consumption.close());
  const adapter = new CodexAdapter(f.config, f.stateDir, 'Fixture task.', undefined, undefined, consumption);
  if (failed) await assert.rejects(adapter.run(f.task, AbortSignal.timeout(5000)));
  else assert.equal((await adapter.run(f.task, AbortSignal.timeout(5000))).kind, 'change-set');
  const status = consumption.status(); assert.equal(status.measuredTokens, 40); assert.equal(status.activeInvocations, 0); assert.equal(status.uncertainInvocations, failed ? 1 : 0);
  assert.equal(status.chargedTokens, 40);
});
