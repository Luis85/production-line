import { featureGitIo } from './runtime-fixtures.mjs';
import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SharedIntakeRuntime } from '../../src/worker/dist/worker/infrastructure/features/shared-intake-runtime.js';
import { defaultFeatureWorkflow, defaultFeatureCheck, featureContentHash } from '../../src/worker/dist/worker/application/feature-workflow.js';
import { readyReviewSessionId, validateReadyReviewInput } from '../../src/worker/dist/worker/application/ready-review-contracts.js';
import { authoringBase, authoringTemplateFor } from '../../src/worker/dist/worker/infrastructure/feature-authoring-assets.js';
import { parseFeature } from '../../src/worker/dist/worker/infrastructure/features/document.js';

prepareNativeProcessFixture();

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'user.name=Werk Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).trim();
const sourcePath = 'features/export.md', reviewPath = 'prompts/ready-check.md';
const reviewerText = 'Ask which order fields must be exported before implementation.\n';
const readyText = 'Verify scope and acceptance criteria before implementing.\n', doneText = 'Report observed verification evidence.\n';
const question = 'Which order fields must the CSV export include?';
const waitingResult = { passed: false, summary: 'The export fields are not defined.', findings: [{ kind: 'question', message: question, blocking: true }] };
const clearResult = { passed: true, summary: 'The team answered the required product decisions.', findings: [] };
function render(parsed) { return '---\n' + parsed.document.toString({ lineWidth: 0 }) + '---\n' + parsed.body; }
function answer(markdown) {
  const parsed = parseFeature(markdown);
  parsed.document.set('status', 'ready'); parsed.document.set('paths', ['orders.ts']);
  parsed.body = parsed.body
    .replace('<!-- Explain the problem, who experiences it, and the observable outcome. -->', 'Allow the operations team to export orders as CSV.')
    .replace('<!-- Describe constraints, relevant behavior, and what is outside this request. -->', 'Preserve the existing order list and export its visible order ID and total fields.')
    .replace('<!-- Add one or more concrete, verifiable checklist items. -->', '- [ ] Every exported row includes the order ID and total.')
    .replace('<!-- Explain how each outcome will be checked and what evidence reviewers need. -->', 'Run order export tests and inspect the generated CSV field names.');
  const section = /(<!-- werk:ready-review:answer -->\r?\n)[\s\S]*?(\r?\n<!-- \/werk:ready-review:answer -->)/;
  assert.match(parsed.body, section);
  parsed.body = parsed.body.replace(section, '$1Export the existing order ID and total fields.$2');
  return render(parsed);
}
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-rr-git-'))), remote = join(directory, 'remote.git');
  const producer = join(directory, 'producer'), repository = join(directory, 'worker'), stateDirectory = join(directory, 'state');
  await mkdir(stateDirectory, { mode: 0o700 });
  const runtimes = [];
  t.after(async () => { for (const runtime of runtimes) await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  git(directory, 'init', '--bare', '--initial-branch=main', remote); git(directory, 'clone', '--', remote, producer);
  const configuration = { ...defaultFeatureWorkflow(), readyReviewPrompt: reviewPath, readyPrompt: 'prompts/ready.md', donePrompt: 'prompts/done.txt' };
  const template = authoringTemplateFor('openai-api'), source = parseFeature(template);
  source.document.set('id', 'fr-export-orders'); source.document.set('title', 'Export orders'); source.document.set('status', 'ready');
  const initialMarkdown = render(source);
  const files = { '.werk/feature-workflow.json': JSON.stringify(configuration), [configuration.readyCheck]: JSON.stringify(defaultFeatureCheck('ready')), [configuration.doneCheck]: JSON.stringify(defaultFeatureCheck('done')),
    [configuration.template]: template, [configuration.base]: authoringBase(configuration), [reviewPath]: reviewerText, [configuration.readyPrompt]: readyText, [configuration.donePrompt]: doneText, [sourcePath]: initialMarkdown, 'orders.ts': 'export const orders = [];\n' };
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(producer, path)), { recursive: true }); await writeFile(join(producer, path), text); }
  git(producer, 'add', '.'); git(producer, 'commit', '-m', 'Ready request with unanswered product decisions'); git(producer, 'push', 'origin', 'main');
  const originalCommit = git(producer, 'rev-parse', 'HEAD'); git(directory, 'clone', '--', remote, repository);
  /** @type {import('../../src/worker/application/ready-review-contracts.ts').ReadyReviewInput[]} */
  const reviewCalls = [];
  /** @type {Map<string, import('../../src/worker/application/ready-review-contracts.ts').ReadyReviewExecutionView>} */
  const attempts = new Map();
  /** @type {import('../../src/worker/application/shared-feature-state.ts').SharedFeatureRecord[]} */
  const submissions = [];
  /** @type {Map<string, import('../../src/worker/application/shared-feature-state.ts').SharedExecution>} */
  const executions = new Map();
  const remoteSource = () => git(remote, 'show', 'main:' + sourcePath) + '\n';
  /** @type {import('../../src/worker/application/ready-review-contracts.ts').ReadyReviewPort} */
  const readyReview = {
    async schedule(value) {
      const input = validateReadyReviewInput(value), claimed = parseFeature(remoteSource());
      assert.ok(claimed.data.werk, 'The remote claim is published before scheduling the reviewer');
      const saved = await readFile(join(stateDirectory, 'shared-intake.json'), 'utf8');
      assert.ok(saved.includes(input.operationId), 'The review operation is durable before scheduling');
      assert.equal(attempts.has(input.operationId), false, 'Repeated synchronization must inspect the existing reviewer operation');
      reviewCalls.push(structuredClone(input));
      const attempt = { operationId: input.operationId, sessionId: readyReviewSessionId(input), turnId: 'review-turn-' + reviewCalls.length, runId: 'review-run-' + reviewCalls.length };
      attempts.set(input.operationId, { ...attempt, state: 'queued' });
      return attempt;
    },
    inspect(input) { return attempts.get(input.operationId); },
  };
  async function open() {
    const initialized = new SharedIntakeRuntime({ stateDirectory, resolve: () => ({ path: repository }), allowed: async () => {}, readyReview,
      submit: async record => {
        assert.equal(record.ready?.passed, true, 'Definition of Ready passes before implementation admission');
        assert.equal(record.readyReviewState?.status, 'passed', 'The reviewer must clear the current committed answer');
        submissions.push(structuredClone(record));
        executions.set(record.taskId, { status: 'queued', summary: null, patch: null, request: null });
      }, inspect: id => executions.get(id), canAdmit: () => true });
    runtimes.push(initialized); await initialized.intake.init(); return initialized;
  }
  let runtime = await open();
  await runtime.intake.configure({ enabled: true, repositoryId: 'project', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 300000 }, 0);
  return { directory, remote, producer, repository, stateDirectory, configuration, initialMarkdown, originalCommit, reviewCalls, submissions,
    get runtime() { return runtime; }, remoteSource,
    async sync() { await runtime.intake.sync(); },
    async until(predicate) { for (let index = 0; index < 12; index++) { await runtime.intake.sync(); if (predicate()) return; } assert.fail('Shared Ready Check did not reach its expected state: ' + JSON.stringify(runtime.intake.view())); },
    complete(result) { const latest = reviewCalls.at(-1); assert.ok(latest); const current = attempts.get(latest.operationId); assert.ok(current); attempts.set(latest.operationId, { ...current, state: 'completed', result }); },
    async restart() { await runtime.close(); runtime = await open(); },
    async saveProducer(path, content) { await mkdir(dirname(join(producer, path)), { recursive: true }); await writeFile(join(producer, path), content); },
    async state() { return JSON.parse(await readFile(join(stateDirectory, 'shared-intake.json'), 'utf8')); },
  };
}

test('shared Git Ready Check waits for pushed answers, preserves frozen prompts and admits implementation exactly once', { timeout: 120000 }, async t => {
  const f = await fixture(t), workerHead = git(f.repository, 'rev-parse', 'HEAD'), workerIndex = git(f.repository, 'write-tree');
  await f.until(() => f.reviewCalls.length === 1);
  assert.equal(f.submissions.length, 0); assert.equal(f.reviewCalls[0].source.commit, f.originalCommit);
  assert.equal(f.reviewCalls[0].prompt.content, reviewerText);
  f.complete(waitingResult);
  await f.until(() => f.runtime.intake.view().requests.some(request => request.status === 'waiting_ready_input'));
  const questionNote = f.remoteSource(); assert.match(questionNote, /## Feature Request Ready Check/); assert.ok(questionNote.includes(question));
  assert.equal(f.runtime.intake.view().requests[0].taskNote ?? null, null, 'Reviewer questions remain on the central Feature Request');
  assert.equal(git(f.remote, 'ls-tree', '-r', '--name-only', 'main', '--', f.configuration.tasksDirectory ?? f.configuration.reviewDirectory + '/_tasks'), '');
  await f.sync(); await f.restart(); await f.sync(); assert.equal(f.reviewCalls.length, 1); assert.equal(f.submissions.length, 0);

  git(f.producer, 'pull', '--ff-only', 'origin', 'main');
  await f.saveProducer(reviewPath, 'Later reviewer guidance must not replace accepted guidance.\n');
  await f.saveProducer(f.configuration.readyPrompt, 'Later Definition of Ready.\n');
  await f.saveProducer(f.configuration.donePrompt, 'Later Definition of Done.\n');
  git(f.producer, 'add', 'prompts'); git(f.producer, 'commit', '-m', 'Update workflow prompts for future requests'); git(f.producer, 'push', 'origin', 'main');
  await f.sync(); assert.equal(f.reviewCalls.length, 1);
  git(f.producer, 'pull', '--ff-only', 'origin', 'main');
  const answered = answer(await readFile(join(f.producer, sourcePath), 'utf8')); await f.saveProducer(sourcePath, answered);
  await f.sync(); assert.equal(f.reviewCalls.length, 1); assert.equal(f.submissions.length, 0); assert.equal(f.remoteSource(), questionNote);
  git(f.producer, 'add', sourcePath); git(f.producer, 'commit', '-m', 'Answer the Ready Check and complete the requirements');
  const answerCommit = git(f.producer, 'rev-parse', 'HEAD');
  await f.sync(); assert.equal(f.reviewCalls.length, 1, 'A local commit without push cannot resume shared work');
  git(f.producer, 'push', 'origin', 'main');
  await f.until(() => f.reviewCalls.length === 2);
  assert.equal(f.reviewCalls[1].source.commit, answerCommit); assert.equal(f.reviewCalls[1].prompt.content, reviewerText);
  assert.equal(f.reviewCalls[1].prompt.sha256, featureContentHash(reviewerText));
  assert.deepEqual(f.reviewCalls[1].previousAssessment, waitingResult);
  assert.match(f.reviewCalls[1].source.markdown, /Export the existing order ID and total fields/);
  assert.equal(f.submissions.length, 0);
  f.complete(clearResult); await f.until(() => f.submissions.length === 1);
  const submitted = f.submissions[0];
  assert.equal(submitted.sourceCommit, answerCommit); assert.equal(submitted.workflow.commit, f.originalCommit);
  assert.equal(submitted.workflow.readyReview.prompt.content, reviewerText);
  assert.equal(submitted.workflow.definitionPrompts.commit, f.originalCommit);
  assert.equal(submitted.workflow.definitionPrompts.ready.content, readyText); assert.equal(submitted.workflow.definitionPrompts.done.content, doneText);
  assert.deepEqual(submitted.accepted.paths, ['orders.ts']); assert.match(submitted.accepted.message, /order ID and total/);
  await f.sync(); await f.restart(); await f.sync(); assert.equal(f.reviewCalls.length, 2); assert.equal(f.submissions.length, 1);
  assert.equal(git(f.repository, 'rev-parse', 'HEAD'), workerHead); assert.equal(git(f.repository, 'write-tree'), workerIndex);
  assert.equal(git(f.repository, 'status', '--porcelain=v1'), ''); assert.equal(await readFile(join(f.repository, sourcePath), 'utf8'), f.initialMarkdown);
});

test('changed worker-owned Ready Check output is preserved remotely and cannot trigger a stale review or implementation', { timeout: 120000 }, async t => {
  const f = await fixture(t); await f.until(() => f.reviewCalls.length === 1); f.complete(waitingResult);
  await f.until(() => f.runtime.intake.view().requests.some(request => request.status === 'waiting_ready_input'));
  git(f.producer, 'pull', '--ff-only', 'origin', 'main');
  const answered = answer(await readFile(join(f.producer, sourcePath), 'utf8'));
  const tampered = answered.replace(question, 'A teammate edited the worker-owned question.'); assert.notEqual(tampered, answered);
  await f.saveProducer(sourcePath, tampered); git(f.producer, 'add', sourcePath); git(f.producer, 'commit', '-m', 'Conflicting edit to reviewer output'); git(f.producer, 'push', 'origin', 'main');
  const head = git(f.remote, 'rev-parse', 'main');
  await f.sync(); await f.restart(); await f.sync();
  assert.equal(f.reviewCalls.length, 1); assert.equal(f.submissions.length, 0);
  assert.equal(git(f.remote, 'rev-parse', 'main'), head); assert.equal(f.remoteSource(), tampered.trim() + '\n');
  assert.equal(git(f.repository, 'status', '--porcelain=v1'), '');
});


test('web Ready Check answer commits only canonical Answers with guarded identity and survives restart without duplicate publication', { timeout: 120000 }, async t => {
  const f = await fixture(t), checkoutHead = git(f.repository, 'rev-parse', 'HEAD'), checkoutIndex = git(f.repository, 'write-tree');
  await f.until(() => f.reviewCalls.length === 1); f.complete(waitingResult); await f.until(() => f.runtime.intake.view().requests[0].status === 'waiting_ready_input');
  const record = f.runtime.intake.view().requests[0], subject = record.readyReview.answerSubject; assert.ok(subject);
  const command = { action: /** @type {const} */ ('answer_ready_review'), requestId: record.id, operationId: 'web-export-answer', ...subject, answer: 'Export the order ID and total fields.' };
  const before = git(f.remote, 'rev-list', '--count', 'main'), source = parseFeature(f.remoteSource()), result = await f.runtime.intake.answerReadyReview(command);
  const answered = parseFeature(f.remoteSource()); assert.equal(answered.data.status, 'ready'); assert.deepEqual(answered.data.werk, source.data.werk); assert.match(answered.body, /Export the order ID and total fields/); assert.ok(answered.body.includes(question));
  assert.equal(Number(git(f.remote, 'rev-list', '--count', 'main')), Number(before) + 1); assert.equal(f.reviewCalls.length, 1); assert.equal(f.submissions.length, 0);
  assert.equal(git(f.repository, 'rev-parse', 'HEAD'), checkoutHead); assert.equal(git(f.repository, 'write-tree'), checkoutIndex); assert.equal(git(f.repository, 'status', '--porcelain'), '');
  await f.restart(); assert.deepEqual(await f.runtime.intake.answerReadyReview(command), result); assert.equal(Number(git(f.remote, 'rev-list', '--count', 'main')), Number(before) + 1);
  await f.until(() => f.reviewCalls.length === 2); assert.match(f.reviewCalls[1].source.markdown, /Export the order ID and total fields/); assert.equal(f.submissions.length, 0);
  assert.deepEqual(await f.runtime.intake.answerReadyReview(command), result); assert.equal(f.reviewCalls.length, 2);
});


test('three unrelated remote branch races retain the exact answer outbox and a later retry publishes once', { timeout: 120000 }, async t => {
  const f = await fixture(t); await f.until(() => f.reviewCalls.length === 1); f.complete(waitingResult); await f.until(() => f.runtime.intake.view().requests[0].status === 'waiting_ready_input');
  const record = f.runtime.intake.view().requests[0], subject = record.readyReview.answerSubject; assert.ok(subject);
  const command = { action: /** @type {const} */ ('answer_ready_review'), requestId: record.id, operationId: 'answer-after-contention', ...subject, answer: 'Export order ID and total.' };
  const sourceBefore = f.remoteSource(), sourceCommits = git(f.remote, 'rev-list', '--count', 'main', '--', sourcePath);
  const adapters = Reflect.get(f.runtime, 'adapters'); assert.ok(adapters instanceof Map); const restore = []; let races = 0;
  for (const adapter of adapters.values()) {
    const io = featureGitIo(adapter), push = io.push.bind(io); restore.push(() => { io.push = push; });
    io.push = async (...args) => {
      races++; git(f.producer, 'pull', '--ff-only', 'origin', 'main'); const path = 'teammate-' + races + '.txt'; await f.saveProducer(path, 'Unrelated teammate work ' + races + '\n');
      git(f.producer, 'add', '--', path); git(f.producer, 'commit', '-m', 'Unrelated concurrent branch update'); git(f.producer, 'push', 'origin', 'main');
      return push(...args);
    };
  }
  try { await assert.rejects(f.runtime.intake.answerReadyReview(command), { code: 'unavailable' }); } finally { for (const release of restore) release(); }
  assert.equal(races, 3); const saved = (await f.state()).records[0]; assert.ok(saved.pending); assert.equal(saved.readyReviewAnswers[0].status, 'pending'); assert.equal(f.remoteSource(), sourceBefore); assert.equal(git(f.remote, 'rev-list', '--count', 'main', '--', sourcePath), sourceCommits); assert.equal(f.reviewCalls.length, 1);
  const operationId = saved.pending.operationId, receiptPath = f.configuration.reviewDirectory + '/_operations/' + createHash('sha256').update(operationId).digest('hex') + '.json';
  assert.equal(git(f.remote, 'ls-tree', '--name-only', 'main', '--', receiptPath), '');
  const result = await f.runtime.intake.answerReadyReview(command); assert.equal(result.operationId, command.operationId); assert.match(f.remoteSource(), /Export order ID and total/);
  assert.equal(Number(git(f.remote, 'rev-list', '--count', 'main', '--', sourcePath)), Number(sourceCommits) + 1); assert.equal(JSON.parse(git(f.remote, 'show', 'main:' + receiptPath)).operationId, operationId); assert.equal(git(f.remote, 'rev-list', '--count', 'main', '--', receiptPath), '1');
  const head = git(f.remote, 'rev-parse', 'main'); assert.deepEqual(await f.runtime.intake.answerReadyReview(command), result); assert.equal(git(f.remote, 'rev-parse', 'main'), head); assert.equal(f.reviewCalls.length, 1); assert.equal(f.submissions.length, 0);
});
