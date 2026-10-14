import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
const exec = promisify(execFile), source = resolve(process.env.WERK_PROJECT_WORKER_APP ?? 'bin/apps/worker');
const project = process.env.WERK_PROJECT_WORKER_PROJECT ? resolve(process.env.WERK_PROJECT_WORKER_PROJECT) : await mkdtemp(join(tmpdir(), 'werk-native-project-'));
await mkdir(project, { recursive: true });
const entry = join(project, 'bin/apps/worker/cli.mjs');
async function command(path, ...args) { const out = await exec(process.execPath, [path, ...args], { cwd: project, timeout: 45000, maxBuffer: 1048576 }); return JSON.parse(out.stdout); }
const cli = (...args) => command(entry, ...args);
let started = false;
try {
  const setup = await command(join(source, 'cli.mjs'), 'init', '--features-dir', 'requests/features');
  assert.equal(setup.featuresDirectory, join(project, 'requests/features'));
  await assert.rejects(readFile(join(project, 'package.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(project, '.git/config')), { code: 'ENOENT' });
  const fixture = join(project, 'provider-fixture');
  await writeFile(fixture, `#!${process.execPath}\nif(process.argv.includes('login')){console.log('Logged in using fixture');process.exit(0)}let text='';for await(const p of process.stdin)text+=p;const reply=text.includes('Implement the requested changes')?JSON.stringify({summary:'Fixture review',files:[{path:'approved.txt',content:'changed\\n'}]}):'Packaged feature protocol fixture completed.';console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:reply}}));\n`, { mode: 0o700 });
  await writeFile(join(project, 'provider.json'), JSON.stringify({ provider: { id: 'codex-cli', executable: fixture } }), { mode: 0o600 });
  const schema = await cli('schema');
  const hasRunEvidence = !!schema.commands['run analyze'];
  if (process.env.WERK_EXPECT_RUN_EVIDENCE === '1') assert.ok(hasRunEvidence, 'The candidate must expose durable run evidence commands.');
  await cli('start', '--port', '0'); started = true;
  await cli('settings', 'set', '--file', 'provider.json');
  const checked = await cli('provider', 'check', '--id', 'codex-cli');
  assert.equal(checked.authentication, 'authenticated');
  await cli('queue', 'pause');
  await writeFile(join(project, 'draft.md'), '---\nschemaVersion: 1\ntitle: Packaged request\nstatus: draft\n---\nDescribe the next step.\n');
  const created = await cli('feature', 'create', '--name', 'example.md', '--markdown', 'draft.md');
  assert.equal(created.record, null);
  assert.match(created.markdown, /status: draft/);
  await cli('feature', 'validate', '--name', 'example.md');
  const current = await cli('feature', 'get', '--name', 'example.md');
  await cli('feature', 'submit', '--name', 'example.md', '--if-match', current.revision);
  const queued = await cli('feature', 'get', '--name', 'example.md');
  assert.match(queued.markdown, /status: ready/);
  await cli('queue', 'resume');
  const completed = await cli('feature', 'wait', '--name', 'example.md', '--timeout-ms', '30000');
  assert.equal(completed.record.status, 'completed');
  assert.match(completed.execution.text, /protocol fixture completed/);
  const result = await cli('feature', 'result', '--name', 'example.md');
  assert.match(await readFile(join(setup.featuresDirectory, completed.record.result), 'utf8'), /protocol fixture completed/);
  await writeFile(join(project, 'approved.txt'), 'original\n');
  await writeFile(join(project, 'patch-draft.md'), '---\nschemaVersion: 1\ntitle: Packaged patch\nstatus: draft\nmode: patch\npaths: [approved.txt]\n---\nChange the approved file.\n');
  const patchDraft = await cli('feature', 'create', '--name', 'patch.md', '--markdown', 'patch-draft.md');
  await cli('feature', 'submit', '--name', 'patch.md', '--if-match', patchDraft.revision);
  const patch = await cli('feature', 'wait', '--name', 'patch.md', '--timeout-ms', '30000');
  assert.equal(patch.record.status, 'review');
  assert.match(await readFile(join(setup.featuresDirectory, patch.record.patch), 'utf8'), /\+changed/);
  assert.equal(await readFile(join(project, 'approved.txt'), 'utf8'), 'original\n');
  let retainedRuns;
  if (hasRunEvidence) {
    retainedRuns = await cli('run', 'list');
    assert.equal(retainedRuns.total, 2);
    assert.deepEqual(retainedRuns.rows.map(run => run.kind).sort(), ['chat', 'local']);
    assert.deepEqual(retainedRuns.rows.map(run => run.outcome).sort(), ['completed', 'review']);
    for (const run of retainedRuns.rows) {
      assert.equal(run.before.state, 'running'); assert.equal(run.after.state, run.outcome);
      assert.equal(run.before.resources.scope, 'worker_process');
      assert.equal(run.after.resources.scope, 'worker_process');
      assert.equal(run.usage.inputTokens, null); assert.equal(run.usage.providerReportedCostUsd, null);
    }
    const analysis = await cli('run', 'analyze');
    assert.equal(analysis.total, 2); assert.equal(analysis.completedPairs, 2);
    assert.equal(analysis.consumption.inputTokens, null);
    assert.equal(analysis.consumption.providerReportedCostUsd, null);
  }
  await cli('stop'); started = false;
  assert.doesNotMatch(await readFile(join(project, '.werk/worker/portable.log'), 'utf8'), /database is not open|database.*closed|state_write_error/i);
  await cli('start', '--port', '0'); started = true;
  const restored = await cli('feature', 'get', '--name', 'example.md');
  assert.equal(restored.record.taskId, completed.record.taskId);
  assert.equal((await cli('feature', 'list')).records.length, 2);
  if (hasRunEvidence) assert.deepEqual((await cli('run', 'list')).rows, retainedRuns.rows);
  console.log(JSON.stringify({ ok: true, journey: 'packaged-native-project-worker', source, installedWithoutNpm: true, projectGitRequired: false, configurableFolder: true, providerProtocolFixture: true, resultExported: !!result, patchRequiresReview: true, restartPreserved: true, durableRunEvidence: hasRunEvidence, liveProvider: false }));
} finally { if(started) await cli('stop').catch(()=>{}); if(process.env.WERK_PROJECT_WORKER_KEEP !== '1') await rm(project,{recursive:true,force:true}); }
