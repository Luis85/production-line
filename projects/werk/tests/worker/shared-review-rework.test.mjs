import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import { SharedFeatureIntake } from '../../src/worker/dist/worker/application/shared-feature-intake.js';
import { SharedFeatureJournal } from '../../src/worker/dist/worker/infrastructure/journal/shared-features.js';
import { WorkerRequestJournal } from '../../src/worker/dist/worker/infrastructure/journal/requests.js';
import { GitFeatureRepository } from '../../src/worker/dist/worker/infrastructure/features/git-repository.js';
import { defaultFeatureWorkflow, defaultFeatureCheck } from '../../src/worker/dist/worker/application/feature-workflow.js';
import { loadFeatureWorkflowSnapshot, validateFeatureReadiness } from '../../src/worker/dist/worker/infrastructure/features/workflow.js';
import { parseFeature } from '../../src/worker/dist/worker/infrastructure/features/document.js';
import { acceptedSharedBody } from '../../src/worker/dist/worker/infrastructure/features/shared-progress.js';
import { sharedSource, renderSharedSource } from '../../src/worker/dist/worker/infrastructure/features/shared-source.js';
import { reviewReworkInput } from '../../src/worker/dist/worker/application/remote-delivery-rework.js';
import { readyPublication } from './remote-delivery-fixtures.mjs';
import { source, sourcePath } from './shared-feature-fixture.mjs';

prepareNativeProcessFixture();
// Windows real Git process startup and durable restart recovery need a larger outer test budget.
const realGitTestTimeoutMs = process.platform === 'win32' ? 60000 : 20000;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const template = source.replace('status: ready', 'status: draft');

/** Real Git + durable worker/shared journals; provider dispatch is a labelled no-inference fixture.
 * @param {import('node:test').TestContext} t */
async function setup(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-shared-review-'))), repository = join(directory, 'repo'), remote = join(directory, 'remote.git'), state = join(directory, 'state');
  await mkdir(repository); await mkdir(remote); await mkdir(state);
  git(remote, 'init', '--bare'); git(repository, 'init', '-b', 'main'); git(repository, 'config', 'user.name', 'Fixture'); git(repository, 'config', 'user.email', 'fixture@example.invalid');
  const config = defaultFeatureWorkflow();
  const files = { '.werk/feature-workflow.json': JSON.stringify(config), [config.readyCheck]: JSON.stringify(defaultFeatureCheck('ready')),
    [config.doneCheck]: JSON.stringify(defaultFeatureCheck('done')), [config.template]: template, [config.base]: 'views:\n  - type: table\n    name: Features\n', [sourcePath]: source, 'src/navigation.ts': 'before\n' };
  for (const [path, content] of Object.entries(files)) { const absolute = join(repository, path); await mkdir(join(absolute, '..'), { recursive: true }); await writeFile(absolute, content); }
  git(repository, 'add', '.'); git(repository, 'commit', '-m', 'Shared request fixture'); git(repository, 'remote', 'add', 'origin', remote); git(repository, 'push', '-u', 'origin', 'main');
  await writeFile(join(repository, 'src/navigation.ts'), 'Uncommitted developer work\n');
  const developer = { head: git(repository, 'rev-parse', 'HEAD'), index: git(repository, 'write-tree'), status: git(repository, 'status', '--porcelain=v1') };
  const controls = { loseSourceAck: false, loseDispatchAck: false, failDispatch: false }, tasks = new Map();
  let journal = new SharedFeatureJournal(state), requests = new WorkerRequestJournal(state), workerId = '', submits = 0, dispatches = 0, sourceMutations = 0;
  await requests.init();
  /** @type {GitFeatureRepository} */ let adapter;
  /** @type {SharedFeatureIntake} */ let intake;
  /** @type {import('../../src/worker/application/shared-feature-state.ts').SharedIntakePorts} */
  const ports = {
    async load() { const saved = await journal.load(); workerId = saved.workerId; return saved; }, save: saved => journal.save(saved),
    repository() {
      adapter ??= new GitFeatureRepository({ repository, remote: 'origin', branch: 'main', requestsDirectory: config.requestsDirectory, reviewDirectory: config.reviewDirectory, stateDirectory: join(directory, 'publication'), workerId });
      return { head: signal => adapter.head(signal), readBlob: (commit, path, signal) => adapter.readBlob(commit, path, signal), listRequests: (commit, signal) => adapter.list(commit, config.requestsDirectory, signal),
        async publishLifecycle(write, signal) {
          const result = await adapter.publishLifecycle(write, signal); if (!result.replayed) sourceMutations++;
          if (controls.loseSourceAck && write.request.content.includes('Review feedback')) throw Error('Fixture lost remote source acknowledgement');
          return result;
        }, publishPatch: (write, signal) => adapter.publishPatch(write, signal) };
    },
    loadWorkflow: (repo, commit, configPath, signal) => loadFeatureWorkflowSnapshot({ commit, configPath, readBlob: (sha, path) => repo.readBlob(sha, path, signal) }),
    ready: (markdown, snapshot, provider) => validateFeatureReadiness(markdown, snapshot.readyCheck, provider, snapshot.template), source: sharedSource, renderSource: renderSharedSource,
    async submit(record) {
      if (tasks.has(record.taskId)) return;
      const request = readyPublication(requests, { sessionId: 'local-' + record.taskId, rootTurnId: record.taskId, taskId: record.taskId, featureId: record.id });
      tasks.set(record.taskId, request.id); submits++;
    },
    inspect(taskId) { const requestId = tasks.get(taskId); if (!requestId) return;
      const request = requests.get(requestId); return { status: request.phase, request, currentTurnId: request.execution?.turnId, runId: request.execution?.runId, summary: 'Provider protocol fixture; no inference', patch: null };
    }, canAdmit: () => true,
    async reviewRework(record, command) {
      if (controls.failDispatch) throw Error('Fixture dispatch unavailable');
      let request = requests.get(command.requestId); const input = reviewReworkInput(request, command);
      if (input) request = requests.reviseInput(request.id, input);
      if (request.execution?.inputRevision === request.inputRevision) return;
      assert.equal(requests.evaluate(request.id, 'ready').passed, true);
      const turn = 'review-turn-' + request.inputRevision;
      requests.bindTurn(request.id, turn); requests.prepareExecution(request.id, turn, 'review-run-' + request.inputRevision);
      dispatches++;
      if (controls.loseDispatchAck) throw Error('Fixture lost dispatch acknowledgement');
    },
  };
  async function open() { intake = new SharedFeatureIntake(ports); await intake.init(); }
  await open(); await intake.configure({ enabled: true, repositoryId: 'shared', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 1000 }, 0);
  await intake.sync();
  const row = intake.view().requests.find(item => item.isLocal); assert.ok(row?.taskId);
  t.after(async () => { await intake.close(); requests.close(); await adapter?.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, repository, remote, controls, row, developer,
    get intake() { return intake; }, get requests() { return requests; }, get dispatches() { return dispatches; }, get submits() { return submits; }, get sourceMutations() { return sourceMutations; },
    request() { return requests.get(tasks.get(row.taskId)); },
    async state() { return JSON.parse(await readFile(join(state, 'shared-intake.json'), 'utf8')); },
    source() { return git(remote, 'show', 'main:' + sourcePath) + '\n'; },
    command() { const request = this.request(), candidate = request.delivery.review.candidate;
      const command = { action: /** @type {const} */ ('request_changes'), requestId: request.id, expectedRevision: request.revision, operationId: 'shared-review-one',
        inputRevision: request.inputRevision, candidateCommit: candidate.candidateCommit, candidateDigest: candidate.candidateDigest, note: 'Fix the keyboard behavior within the accepted paths.' };
      requests.command(command); return command;
    },
    async restart() { await intake.close(); requests.close(); journal = new SharedFeatureJournal(state); requests = new WorkerRequestJournal(state); await requests.init(); await open(); },
  };
}

test('shared review feedback confirms the same canonical source before rework and preserves accepted scope and developer work', { timeout: realGitTestTimeoutMs }, async t => {
  const h = await setup(t), command = h.command(), before = h.request();
  await h.intake.reviewFeedback(h.row.taskId, command);
  const remote = h.source(), saved = (await h.state()).records[0], request = h.request();
  assert.match(remote, /Review feedback/); assert.match(remote, /Fix the keyboard behavior/);
  assert.equal(acceptedSharedBody(parseFeature(remote)), parseFeature(source).body);
  assert.equal(saved.reviewReworks[0].status, 'dispatched'); assert.equal(request.inputRevision, before.inputRevision + 1);
  assert.deepEqual(request.input.files, before.input.files); assert.deepEqual(request.input.criteria, before.input.criteria); assert.deepEqual(request.input.context, before.input.context);
  assert.equal(request.attestation, null); assert.equal(request.deliveryHistory.at(-1).review.candidate.candidateCommit, command.candidateCommit);
  assert.equal(h.dispatches, 1); assert.equal(h.submits, 1); assert.equal(h.intake.view().requests.filter(item => item.isLocal).length, 1);
  assert.deepEqual({ head: git(h.repository, 'rev-parse', 'HEAD'), index: git(h.repository, 'write-tree'), status: git(h.repository, 'status', '--porcelain=v1') }, h.developer);
  await h.intake.reviewFeedback(h.row.taskId, command); assert.equal(h.dispatches, 1);
});

test('a lost shared source acknowledgement survives restart and never dispatches before Git confirmation', { timeout: realGitTestTimeoutMs }, async t => {
  const h = await setup(t), command = h.command(); h.controls.loseSourceAck = true;
  await assert.rejects(h.intake.reviewFeedback(h.row.taskId, command), /acknowledgement/);
  assert.equal(h.dispatches, 0); assert.equal(h.request().inputRevision, command.inputRevision);
  const pending = (await h.state()).records[0]; assert.equal(pending.reviewReworks[0].status, 'pending_source'); assert.ok(pending.pending);
  const commits = h.sourceMutations;
  await h.restart(); h.controls.loseSourceAck = false; await h.intake.sync();
  assert.equal(h.dispatches, 1); assert.equal((await h.state()).records[0].reviewReworks[0].status, 'dispatched');
  assert.ok(h.sourceMutations <= commits + 2, 'Recovery observes the old source outbox and publishes only subsequent status projections');
  await h.intake.reviewFeedback(h.row.taskId, command); assert.equal(h.dispatches, 1);
});

test('a lost shared rework dispatch acknowledgement recovers its saved worker generation without invoking again', { timeout: realGitTestTimeoutMs }, async t => {
  const h = await setup(t), command = h.command(); h.controls.loseDispatchAck = true;
  await assert.rejects(h.intake.reviewFeedback(h.row.taskId, command), /dispatch acknowledgement/);
  assert.equal(h.dispatches, 1); assert.equal((await h.state()).records[0].reviewReworks[0].status, 'pending_dispatch');
  await h.restart(); h.controls.loseDispatchAck = false; await h.intake.sync();
  assert.equal(h.dispatches, 1); assert.equal((await h.state()).records[0].reviewReworks[0].status, 'dispatched');
  assert.equal(h.submits, 1);
});

test('concurrent shared author edits are preserved and block review dispatch instead of being overwritten', { timeout: realGitTestTimeoutMs }, async t => {
  const h = await setup(t), command = h.command();
  const author = join(h.directory, 'author'); git(h.directory, 'clone', '-b', 'main', h.remote, author); git(author, 'config', 'user.name', 'Teammate'); git(author, 'config', 'user.email', 'teammate@example.invalid');
  const edited = h.source() + '\nA teammate added context.\n'; await writeFile(join(author, sourcePath), edited); git(author, 'add', '.'); git(author, 'commit', '-m', 'Concurrent author edit'); git(author, 'push', 'origin', 'main');
  await assert.rejects(h.intake.reviewFeedback(h.row.taskId, command));
  assert.equal(h.dispatches, 0); assert.equal(h.request().inputRevision, command.inputRevision); assert.match(h.source(), /A teammate added context/);
  assert.equal((await h.state()).records[0].reviewReworks[0].status, 'pending_source');
});
