import { restorableDeliveryCompletion } from '../../src/worker/dist/worker/application/local-task-completion.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkerSessions, createLocalTaskboard } from '../../src/worker/dist/worker/infrastructure/workspace-services.js';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { prepareRepositoryWorktree } from '../../src/worker/dist/worker/infrastructure/repositories.js';
import { defaultDeliveryProjectPolicy, deliveryPolicySnapshot, deliveryGatePolicy } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';
import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';
const timeout = process.platform === 'win32' ? 180000 : 60000;

test('an exact authorized failed-check decision resumes the same candidate into review without rewriting invocation facts', { timeout }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk-exception-resume-'))), repository = join(root, 'repo'), state = join(root, 'state');
  /** @type {ReturnType<typeof createWorkerSessions>} */ let sessions;
  /** @type {ReturnType<typeof createLocalTaskboard>} */ let board;
  t.after(async () => { try { await board?.close(); await sessions?.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  await mkdir(join(repository, '.werk'), { recursive: true }); await mkdir(join(repository, 'tests')); await mkdir(state);
  const configuration = defaultDeliveryProjectPolicy();
  configuration.profiles[0].maxRepairAttempts = 0;
  configuration.profiles[0].exceptions = { exemptibleCriteria: ['check:unit'], notApplicableCriteria: [] };
  await writeFile(join(repository, '.werk', 'delivery-policy.json'), JSON.stringify(configuration));
  await writeFile(join(repository, 'source.txt'), 'before\n');
  await writeFile(join(repository, 'tests', 'unit.mjs'), "console.error('Known pre-existing integration fixture failure.'); process.exitCode = 1;\n");
  const run = promisify(execFile);
  const git = async (...args) => (await run('git', ['-c', 'core.hooksPath=/dev/null', '-C', repository, ...args], { windowsHide: true })).stdout.trim();
  await git('init', '--initial-branch=main'); await git('config', 'core.autocrlf', 'false'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid'); await git('add', '.'); await git('commit', '-m', 'Known failing baseline');
  const baseline = await git('rev-parse', 'HEAD'), policy = deliveryPolicySnapshot(configuration, baseline);
  const gate = deliveryGatePolicy(defaultGatePolicy(), policy); gate.reviewer.enabled = false; gate.rework.maxAttempts = 0;
  const settings = new WorkerSettings(state); await settings.init();
  await settings.update({ provider: { id: 'openai-api', model: 'fixture', apiKey: 'not-sent' }, board: { paused: false } });
  const tools = settings.toolPolicy();
  await settings.updateToolAccess({ expectedRevision: tools.revision, builtins: { ...tools.builtins, files: true, commands: [{ id: 'unit', name: 'Known failing unit check', executable: process.execPath, args: ['tests/unit.mjs'], enabled: true, verification: true }] }, mcp: [] });
  let calls = 0;
  /** Deterministic model port; Git checkpoints, check subprocesses and journals are real.
   * @type {NonNullable<Parameters<typeof createWorkerSessions>[2]>} */
  const factory = (connection, _directory, _transport, options) => ({
    configuration: { id: connection.id, model: connection.model, instruction: 'Controlled model fixture.' }, capabilities: modelCapabilities,
    get toolManifest() { return options?.tools().manifest; },
    async reply() { throw Error('Structured call required'); },
    async execute(request, signal) {
      calls++; const runtime = options.tools(request.policy);
      try {
        const status = await runtime.call('werk_candidate_status', {}, signal); assert.notEqual(status.isError, true);
        const value = JSON.parse(status.content.map(item => item.text).join('\n'));
        const edited = await runtime.call('werk_candidate_apply', { path: 'source.txt', expectedHash: value.files.find(file => file.path === 'source.txt').hash, content: 'after\n' }, signal); assert.notEqual(edited.isError, true);
        return { type: 'completed', text: 'Implemented the accepted candidate; the retained external check still fails.' };
      } finally { await runtime.close(); }
    },
  });
  const workspaces = { prepareWorktree: (selector, key, signal, commit, inspection) => prepareRepositoryWorktree(selector, key, signal, commit, inspection) };
  async function open() { sessions = createWorkerSessions(state, settings, factory); await sessions.init(); board = createLocalTaskboard(state, settings, sessions, factory, workspaces); await board.init(); }
  await open();
  await board.create({ title: 'Retain a disclosed candidate exception', instruction: 'Change only source.txt to after and preserve the required verification input.', repository, paths: ['source.txt'], provider: 'openai-api' }, { id: 'exception-task', hash: 'a'.repeat(64), baseCommit: baseline, policy: gate, deliveryPolicy: policy, criteria: ['The source says after.'] });
  const taskId = board.view().tasks[0].id;
  async function settle(expected) {
    await board.tick(); const deadline = performance.now() + timeout - 5000;
    while (performance.now() < deadline) {
      const task = board.executionDetail(taskId);
      if (!['running', 'queued'].includes(task.status) && !sessions.executor.busy) { assert.equal(task.status, expected, task.error ?? 'Unexpected status'); return task; }
      await delay(25);
    }
    assert.fail('The composed candidate did not settle: ' + JSON.stringify(board.view()));
  }
  const failed = await settle('needs_rework'), request = sessions.requests.get(failed.requestId), original = structuredClone(request.execution);
  assert.equal(calls, 1); assert.equal(request.delivery.status, 'failed'); assert.equal(original.facts['output.verificationPassed'], false); assert.equal(failed.developmentCompletion.verified, false);
  assert.equal(request.delivery.review, undefined);
  const candidate = request.delivery.checkpoints.at(-1);
  assert.equal(await board.verifyDeliveryCheckpoint(request.id, request.revision), candidate.candidateDigest);
  const decided = sessions.requests.command({ action: 'criterion_decision', requestId: request.id, expectedRevision: request.revision, operationId: 'operator-exception', deliveryRunId: candidate.runId, inputRevision: candidate.inputRevision, candidateCommit: candidate.candidateCommit, candidateDigest: candidate.candidateDigest, criterionDecision: { criterionId: 'check:unit', kind: 'exempted', reason: 'The team accepts this exact known pre-existing check failure for this candidate.' } }).request;
  assert.equal(decided.delivery.status, 'queued');
  await board.executeRequest(request.id);
  const reviewed = await settle('review'), current = sessions.requests.get(request.id);
  assert.equal(calls, 1, 'A criterion decision does not spend another implementation call.');
  assert.equal(board.view().persistenceError, false);
  assert.deepEqual(current.execution, original, 'Known provider result, output digest and failed observation facts stay immutable.');
  assert.equal(current.phase, 'review'); assert.equal(current.attestation, null); assert.equal(reviewed.developmentCompletion.verified, false);
  assert.equal(current.delivery.review.checks[0].status, 'failed');
  const result = current.delivery.review.results.find(item => item.criterionId === 'check:unit'); assert.equal(result.status, 'failed'); assert.equal(result.observedStatus, 'failed'); assert.match(result.decisionRef, /^decision:/); assert.equal(current.delivery.review.criterionDecisions[0].kind, 'exempted');
  assert.match(current.delivery.review.markdown, /exempted|exception/i);
  assert.equal(current.evaluations.at(-1).facts['output.verificationPassed'], false); assert.equal(current.evaluations.at(-1).facts['output.verificationEligible'], true);
  assert.equal(await readFile(join(repository, 'source.txt'), 'utf8'), 'before\n'); assert.equal(await git('rev-parse', 'HEAD'), baseline);
  assert.equal(restorableDeliveryCompletion(reviewed, current), true);
  for (const change of [
    (task, _request) => { task.patch += '\nUnchecked alteration'; },
    (task, _request) => { task.developmentCompletion.evidenceDigest = 'f'.repeat(64); },
    (_task, value) => { value.delivery.review.candidate.inputHash = 'f'.repeat(64); },
    (_task, value) => { value.delivery.criterionDecisions[0].subject.candidateDigest = 'f'.repeat(64); },
    (_task, value) => { value.delivery.holds.push({ code: 'source', reason: 'Source unavailable.', since: new Date().toISOString() }); },
  ]) { const task = structuredClone(reviewed), value = structuredClone(current); change(task, value); assert.equal(restorableDeliveryCompletion(task, value), false); }
  await board.close(); await sessions.close(); await open(); await board.tick();
  assert.equal(board.executionDetail(taskId).status, 'review'); assert.equal(calls, 1); assert.equal(sessions.requests.get(request.id).execution.outputDigest, original.outputDigest);
});
