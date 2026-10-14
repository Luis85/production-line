// Default: Docker journey. --native: prebuilt app installed into a fresh native project.
if (process.argv.includes('--native')) { await import('./project-worker-native-smoke.mjs'); process.exit(0); }
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
const exec = promisify(execFile), app = resolve(process.env.WERK_PROJECT_WORKER_APP ?? 'bin/apps/worker');
const image = 'node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df';
const project = await realpath(await mkdtemp(join(tmpdir(), 'werk-docker-project-')));
const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r));
let configured = false;
const docker = args => exec('docker', args, { cwd: project, timeout: 180000, maxBuffer: 1048576 });
const compose = (...args) => docker(['compose', '-f', '.werk/compose.worker.yaml', ...args]);
async function until(check) { for (let i = 0; i < 200; i++) { try { if (await check()) return; } catch {} await new Promise(r => setTimeout(r, 150)); } throw Error('Docker feature request did not reach the expected state.'); }
try {
  const initialized = await docker(['run', '--rm', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '--mount', `type=bind,src=${app},dst=/installer,readonly`, '--mount', `type=bind,src=${project},dst=/project`, '--workdir', '/project', image, 'node', '/installer/cli.mjs', 'init', '--features-dir', 'requests', '--port', String(port)]);
  assert.equal(JSON.parse(initialized.stdout).initialized, true); configured = true;
  await writeFile(join(project, 'provider-fixture'), '#!/usr/bin/env node\nlet input="";for await(const p of process.stdin)input+=p;const text=input.includes("DOCKER_QUESTION_FLOW")&&!input.includes("DOCKER_ANSWER_COMPLETE")?JSON.stringify({werkInteraction:{schemaVersion:1,kind:"question",message:"Which layout should the Docker fixture retain?"}}):"Docker feature protocol fixture completed.";console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}}));\n', { mode: 0o700 });
  await compose('up', '-d', '--wait', '--wait-timeout', '90');
  const token = (await readFile(join(project, '.werk/worker/webview-token'), 'utf8')).trim();
  const call = async (path, body) => { const r = await fetch(`http://127.0.0.1:${port}` + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const result = await r.json(); assert.ok(r.ok, result.error); return result; };
  await call('/api/settings', { provider: { id: 'codex-cli', executable: '/project/provider-fixture' } });
  await writeFile(join(project, 'requests/docker.md'), '---\nschemaVersion: 1\ntitle: Docker folder task\nstatus: ready\n---\nVerify the mounted project feature workflow.\n');
  await until(async () => (await call('/api/features')).records[0]?.result !== undefined);
  const before = (await call('/api/features')).records[0]; assert.match(await readFile(join(project, 'requests', before.result), 'utf8'), /protocol fixture completed/);
  const cli = JSON.parse((await compose('exec', '-T', 'worker', 'node', 'bin/apps/worker/cli.mjs', 'feature', 'list')).stdout); assert.equal(cli.records.length, 1);
  const schema = JSON.parse((await compose('exec', '-T', 'worker', 'node', 'bin/apps/worker/cli.mjs', 'schema')).stdout);
  const hasRunEvidence = !!schema.commands['run analyze'];
  const hasInteractions = !!schema.commands['interaction answer'];
  if (process.env.WERK_EXPECT_INTERACTIONS === '1') assert.ok(hasInteractions, 'The candidate must expose guarded model interactions.');
  const workerCli = async (...args) => JSON.parse((await compose('exec', '-T', 'worker', 'node', 'bin/apps/worker/cli.mjs', ...args)).stdout);
  if (process.env.WERK_EXPECT_RUN_EVIDENCE === '1') assert.ok(hasRunEvidence, 'The candidate must expose durable run evidence commands.');
  let retainedRuns;
  if (hasRunEvidence) {
    retainedRuns = JSON.parse((await compose('exec', '-T', 'worker', 'node', 'bin/apps/worker/cli.mjs', 'run', 'list', '--kind', 'chat')).stdout);
    assert.equal(retainedRuns.total, 1); assert.equal(retainedRuns.rows[0].outcome, 'completed');
    assert.equal(retainedRuns.rows[0].before.resources.scope, 'worker_process');
    assert.equal(retainedRuns.rows[0].after.resources.scope, 'worker_process');
    assert.equal(retainedRuns.rows[0].usage.inputTokens, null);
    assert.equal(retainedRuns.rows[0].usage.providerReportedCostUsd, null);
    const analysis = JSON.parse((await compose('exec', '-T', 'worker', 'node', 'bin/apps/worker/cli.mjs', 'run', 'analyze', '--kind', 'chat')).stdout);
    assert.equal(analysis.total, 1); assert.equal(analysis.completedPairs, 1);
  }
  let interactionEvidence = null;
  if (hasInteractions) {
    await writeFile(join(project, 'question-draft.md'), '---\nschemaVersion: 1\ntitle: Docker retained question\nstatus: draft\n---\nDOCKER_QUESTION_FLOW: Ask before selecting a layout.\n');
    const draft = await workerCli('feature', 'create', '--name', 'question.md', '--markdown', '/project/question-draft.md');
    await workerCli('feature', 'submit', '--name', 'question.md', '--if-match', draft.revision);
    const waiting = await workerCli('feature', 'wait', '--name', 'question.md', '--timeout-ms', '30000');
    assert.equal(waiting.execution.status, 'waiting_input');
    const sessionId = waiting.record.sessionId;
    const question = await workerCli('interaction', 'get', '--id', sessionId);
    assert.equal(question.phase, 'waiting_input'); assert.equal(question.pending.kind, 'question');
    await compose('stop');
    await compose('up', '-d', '--wait', '--wait-timeout', '90');
    assert.deepEqual(await workerCli('interaction', 'get', '--id', sessionId), question);
    await writeFile(join(project, 'answer.json'), JSON.stringify({ answer: 'DOCKER_ANSWER_COMPLETE: Keep the existing layout.' }));
    await assert.rejects(workerCli('interaction', 'answer', '--id', sessionId, '--question-id', question.pending.id, '--if-match', String(question.revision + 1), '--key', 'docker-stale-answer-001', '--file', '/project/answer.json'), error => /"exitCode":2/.test(error.stderr));
    const answerArgs = ['interaction', 'answer', '--id', sessionId, '--question-id', question.pending.id, '--if-match', String(question.revision), '--key', 'docker-answer-001', '--file', '/project/answer.json'];
    const accepted = await workerCli(...answerArgs), replayed = await workerCli(...answerArgs);
    assert.equal(replayed.latestTurn.id, accepted.latestTurn.id); assert.equal(replayed.totalTurns, question.totalTurns + 1);
    assert.equal((await workerCli('feature', 'wait', '--name', 'question.md', '--timeout-ms', '30000')).execution.status, 'completed');
    const answered = await workerCli('interaction', 'turn', '--id', sessionId, '--turn-id', accepted.latestTurn.id);
    assert.equal(answered.kind, 'answer'); assert.equal(answered.dispatch.policy.continuation, 'worker_context_replay');
    assert.match(JSON.stringify(answered.dispatch), /DOCKER_ANSWER_COMPLETE/); assert.ok(answered.dispatchDigest);
    await writeFile(join(project, 'answer.json'), JSON.stringify({ answer: 'Changed input cannot reuse the accepted operation.' }));
    await assert.rejects(workerCli(...answerArgs), error => /"exitCode":2/.test(error.stderr));
    const page = await workerCli('interaction', 'events', '--id', sessionId, '--after', '0', '--limit', '100');
    assert.equal(page.schemaVersion, 1); assert.equal(page.hasMore, false);
    assert.ok(page.events.some(event => event.type === 'input_requested')); assert.ok(page.events.some(event => event.type === 'completed'));
    assert.ok(page.events.every(event => event.sessionId === sessionId)); assert.equal(new Set(page.events.map(event => event.id)).size, page.events.length);
    const empty = await workerCli('interaction', 'events', '--id', sessionId, '--after', String(page.nextAfter));
    assert.equal(empty.events.length, 0); assert.equal(empty.nextAfter, page.nextAfter);
    interactionEvidence = { pendingQuestionRestartPreserved: true, guardedAnswer: true, answerReplaySafe: true, changedReplayRejected: true, actualDispatchRetained: true, normalizedEvents: true, nativeProviderSessionResumed: false };
    if (hasRunEvidence) retainedRuns = await workerCli('run', 'list', '--kind', 'chat');
  }
  await compose('stop');
  assert.doesNotMatch((await compose('logs', '--no-color', 'worker')).stdout, /database is not open|database.*closed|state_write_error/i);
  const moved = JSON.parse((await compose('run', '--rm', '--no-deps', 'worker', 'node', 'bin/apps/worker/cli.mjs', 'feature', 'folder', 'set', '--path', 'feature-requests')).stdout);
  assert.equal(moved.path, 'feature-requests');
  assert.match(await readFile(join(project, 'feature-requests', before.result), 'utf8'), /protocol fixture completed/);
  await compose('up', '-d', '--wait', '--wait-timeout', '90');
  await until(async () => (await call('/api/features')).records[0]?.result !== undefined);
  assert.equal((await call('/api/features')).records.find(record => record.id === before.id).taskId, before.taskId); assert.equal((await call('/api/sessions')).records.length, hasInteractions ? 3 : 2);
  if (hasRunEvidence) assert.deepEqual(JSON.parse((await compose('exec', '-T', 'worker', 'node', 'bin/apps/worker/cli.mjs', 'run', 'list', '--kind', 'chat')).stdout).rows, retainedRuns.rows);
  console.log(JSON.stringify({ ok: true, journey: 'project-worker-docker', setupInsideContainer: true, mountedFeatureIntake: true, templateInstalled: true, folderReconfigured: true, resultExported: true, restartPreserved: true, duplicateTasks: false, durableRunEvidence: hasRunEvidence, interactionEvidence, liveProvider: false }));
} finally {
  if (configured) await compose('down', '--remove-orphans').catch(() => {});
  await rm(project, { recursive: true, force: true });
}
