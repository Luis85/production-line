import { cleanup } from './fixture-cleanup.mjs';
import { WorkerRequestJournal } from '../../src/worker/dist/worker/infrastructure/journal/requests.js';
import { outputFacts } from '../../src/worker/dist/worker/application/local-task-preparation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './request-gate-fixtures.mjs';
import { runDeliverySteps, DeliverySuspended } from '../../src/worker/dist/worker/application/delivery-task-steps.js';
import { defaultGatePolicy, gateDigest } from '../../src/worker/dist/worker/application/request-gates.js';
import { developmentCheckFingerprint } from '../../src/worker/dist/worker/application/development.js';
import { buildDeliveryReview, deliveryCheckDefinitionDigest } from '../../src/worker/dist/worker/application/delivery-review.js';
import { modelCapabilities, prepareModelRequest, ProviderModelError } from '../../src/worker/dist/worker/application/model-contract.js';
import { parseDeliveryAssessment } from '../../src/worker/dist/worker/application/delivery-provider-contracts.js';
/** @typedef {import('../../src/worker/application/delivery-execution-policy.js').DeliveryExecutionProfile} Profile */
/** @typedef {import('../../src/worker/application/model-contract.js').StructuredModel} Model */
/** @typedef {import('../../src/worker/application/model-contract.js').ModelRequest} Dispatch */
/** @param {import('node:test').TestContext} t @param {{primary?:'claude-cli'|'codex-cli'|'cursor-cli',fallback?:boolean,review?:boolean,primaryError?:import('../../src/worker/application/model-result.js').ModelErrorCode,blockOnce?:boolean,failCheckOnce?:boolean,question?:boolean,reviewQuestion?:boolean,reviewUnavailable?:boolean,targetBillingChanged?:boolean}} options */
async function setup(t, options = {}) {
  const initial = await fixture(t); let journal = initial.journal;
  /** @type {Profile[]} */
  const profiles = [
    { id: 'primary', provider: options.primary ?? 'claude-cli', model: '', effort: 'default', authenticationMode: 'cli-account', boundary: options.primary === 'cursor-cli' ? 'provider_native' : 'worker_grants' },
    { id: 'alternate', provider: 'codex-cli', model: '', effort: 'default', authenticationMode: 'cli-account', boundary: 'worker_grants' },
    { id: 'reviewer', provider: 'anthropic-api', model: 'review-model', effort: 'default', authenticationMode: 'api-key', boundary: 'worker_grants' },
  ];
  const selection = profile => ({ provider: profile.provider, model: profile.model, effort: profile.effort, authenticationMode: profile.authenticationMode });
  const policy = { profiles, defaultProfile: 'primary', allowedOverrides: [], ...(options.review ? { reviewProfile: 'reviewer' } : {}), fallbackProfiles: options.fallback ? ['alternate'] : [], fallbackOn: options.fallback ? ['quota_exhausted'] : [], maxHandoffs: options.fallback ? 1 : 0 };
  const execution = { policy, resolution: { profile: profiles[0], source: 'default' }, selection: selection(profiles[0]), profileSnapshots: profiles.map(profile => ({ profileId: profile.id, selection: selection(profile) })) };
  const gate = defaultGatePolicy(); gate.reviewer.enabled = false; gate.rework.maxAttempts = 1;
  const check = { id: 'unit', name: 'Unit checks', executable: 'fixture', args: [] };
  /** @type {import('../../src/worker/application/development.js').DevelopmentScope} */
  const scope = { schemaVersion: 1, mode: 'worktree', baseCommit: 'a'.repeat(40), approvedPaths: ['source.txt'], checks: [{ ...check, fingerprint: developmentCheckFingerprint(check) }] };
  const configuration = { id: profiles[0].provider, model: '', instruction: '', effort: /** @type {const} */ ('default'), authenticationMode: /** @type {const} */ ('cli-account') };
  const request = journal.ensure({ owner: { sessionId: 'session', rootTurnId: 'root', taskId: 'task' }, provider: configuration, policy: gate, input: { kind: 'patch', title: 'Deliver source', message: 'Implement the source change', criteria: ['The changed source implements the requested behavior.'], files: [{ path: 'source.txt', bytes: 7 }], context: { implementation: scope, deliveryExecution: execution } } });
  journal.evaluate(request.id, 'ready'); journal.bindTurn(request.id, 'turn'); journal.prepareExecution(request.id, 'turn', 'invocation'); journal.startExecution(request.id, 'turn', 'invocation');
  const task = /** @type {import('../../src/worker/application/local-task-contracts.js').LocalTask} */ (/** @type {unknown} */ ({ id: 'task', sessionId: 'session', requestId: request.id, runId: 'invocation', currentTurnId: 'turn', title: 'Deliver source', instruction: 'Implement source', provider: profiles[0].provider, model: '', repository: '/fixture', implementation: scope, baseCommit: scope.baseCommit }));
  let content = 'before', count = 0, reviews = 0, calls = 0, checkCalls = 0;
  /** @type {import('../../src/worker/application/development.js').DevelopmentEvidence} */
  let evidence = { schemaVersion: 1, candidateDigest: null, changedPaths: [], checks: [], updatedAt: new Date().toISOString() };
  /** @type {{provider:string,dispatch:Dispatch}[]} */ const invocations = [];
  /** @type {{id:string,outcome:string}[]} */ const metrics = [];
  const capture = () => ({ digest: gateDigest(content), patch: content === 'before' ? '' : 'diff --git a/source.txt b/source.txt\n-before\n+' + content, changedPaths: content === 'before' ? [] : ['source.txt'] });
  /** @type {import('../../src/worker/application/development.js').DevelopmentRuntime} */
  const development = { async capture() { return capture(); }, evidence() { return structuredClone(evidence); }, async apply() { throw Error('Fixture only'); }, async check() { checkCalls++; const failed = options.failCheckOnce && checkCalls === 1; const receipt = { presetId: check.id, presetFingerprint: scope.checks[0].fingerprint, candidateDigest: capture().digest, status: failed ? /** @type {const} */ ('failed') : /** @type {const} */ ('passed'), exitCode: failed ? 1 : 0, stdout: '', stderr: '', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }; evidence = { schemaVersion: 1, candidateDigest: capture().digest, changedPaths: capture().changedPaths, checks: [receipt], updatedAt: receipt.finishedAt }; return receipt; } };
  /** @type {Map<string,import('../../src/worker/application/delivery-review-contracts.js').DeliveryCandidate>} */ const candidates = new Map();
  /** @type {import('../../src/worker/application/provider-contract.js').ModelFactory} */
  const factory = (connection, modelScope) => {
    const review = !modelScope;
    if (review && options.reviewUnavailable) return undefined;
    /** @type {Model} */
    const model = { configuration: { id: connection.id, model: connection.model, instruction: '', effort: connection.effort, authenticationMode: connection.authenticationMode }, capabilities: { ...modelCapabilities, tools: connection.id === 'cursor-cli' ? 'provider_native' : review ? 'none' : 'granted' },
      ...(!review ? { sessionBinding: { schemaVersion: /** @type {const} */ (1), logicalSessionId: modelScope.sessionId, featureRequestKey: 'fr-' + 'f'.repeat(64), providerId: connection.id, generation: 1 }, toolManifest: { revision: 1, tools: [{ name: 'werk_candidate_apply', description: 'Fixture candidate', inputSchema: { type: 'object' } }] } } : {}),
      async reply() { throw Error('Structured call required'); }, async execute(dispatch) {
        invocations.push({ provider: connection.id, dispatch });
        if (review) { reviews++; if (options.reviewQuestion) return { type: 'needs_input', request: { schemaVersion: 1, kind: 'question', message: 'Does the edge case require legacy compatibility?' } }; return { type: 'completed', text: JSON.stringify({ summary: 'Candidate reviewed', findings: options.blockOnce && reviews === 1 ? [{ id: 'missing-case', severity: 'blocking', message: 'Cover the missing accepted edge case.' }] : [] }) }; }
        calls++; if (options.question) return { type: 'needs_input', request: { schemaVersion: 1, kind: 'question', message: 'Which exact output is required?' } }; content = calls > 1 ? 'repaired' : 'after';
        if (connection.id === profiles[0].provider && options.primaryError) throw new ProviderModelError(options.primaryError);
        return { type: 'completed', text: connection.id + ' implementation' };
      } };
    return model;
  };
  const connection = id => { const profile = profiles.find(item => item.provider === id); return { id, executable: '', model: profile.model, effort: profile.effort, authenticationMode: options.targetBillingChanged && id === 'codex-cli' ? 'api-key' : profile.authenticationMode, apiKey: '' }; };
  const model = factory(connection(profiles[0].provider), { sessionId: 'session' });
  const dispatch = prepareModelRequest(model, [{ id: 'source', at: new Date().toISOString(), state: 'complete', role: 'user', text: 'Implement the accepted request.' }], 'patch');
  const host = /** @type {Parameters<typeof runDeliverySteps>[0]} */ (/** @type {unknown} */ ({
    model: factory, settings: { provider: connection }, sessions: { get requests() { return journal; }, runs: { async begin() { return { id: 'extra-' + ++count }; }, async start() {}, observeUsage() {}, async finish(id, outcome) { metrics.push({ id, outcome }); } }, interactions: { observeUsage() {}, observeToolBudget() {} } },
    delivery: () => ({ async checkpoint(input) { let candidate = candidates.get(input.candidate.digest); if (!candidate) { candidate = { requestId: request.id, inputRevision: request.inputRevision, inputHash: request.inputHash, runId: journal.get(request.id).delivery.id, baseline: scope.baseCommit, branch: 'werk/candidate', candidateCommit: input.candidate.digest.slice(0, 40), tree: 'd'.repeat(40), candidateDigest: input.candidate.digest, patchDigest: gateDigest(input.candidate.patch), policyDigest: request.policyDigest, checkDefinitionDigest: deliveryCheckDefinitionDigest(scope), createdAt: new Date().toISOString() }; candidates.set(input.candidate.digest, candidate); } return structuredClone(candidate); }, async package(input) { return buildDeliveryReview(input); } }),
    async change(action) { await action([task]); }, async writePatch() {}, validatedPatch() { throw Error('Captured candidate required'); }, evidencePersistenceError: false,
  }));
  return { task, get journal() { return journal; }, invocations, metrics, request: () => journal.get(request.id), execute: () => runDeliverySteps(host, task, model, dispatch, development, new AbortController().signal),
    record: delivered => journal.recordResult(request.id, 'turn', 'invocation', delivered.result, outputFacts(delivered.valid, task, journal.get(request.id))),
    async restart() { journal.close(); journal = new WorkerRequestJournal(initial.directory); await journal.init(); cleanup(t, () => journal.close()); },
  };
}
test('a separate frozen reviewer gates packaging and blocking findings feed the bounded repair loop', async t => {
  const f = await setup(t, { review: true, blockOnce: true }); assert.ok((await f.execute()).valid);
  assert.deepEqual(f.invocations.map(item => item.provider), ['claude-cli', 'anthropic-api', 'claude-cli', 'anthropic-api']);
  const run = f.request().delivery; assert.equal(run.assessments.length, 2); assert.equal(run.assessments[0].passed, false); assert.equal(run.assessments[1].passed, true); assert.equal(run.repairAttempts, 1);
  for (const call of f.invocations.filter(item => item.provider === 'anthropic-api')) { assert.equal(call.dispatch.operation, 'chat'); assert.equal(call.dispatch.policy.tools, 'none'); assert.equal(call.dispatch.toolManifest, undefined); }
  assert.match(f.invocations[2].dispatch.renderedPrompt, /missing accepted edge case/);
  await f.execute(); assert.equal(f.invocations.length, 4, 'Durable results do not redispatch.');
});
test('authorized quota fallback retains the candidate and uses a fresh session without changing primary billing', async t => {
  const f = await setup(t, { fallback: true, primaryError: 'quota' }); assert.ok((await f.execute()).valid);
  assert.deepEqual(f.invocations.map(item => item.provider), ['claude-cli', 'codex-cli']);
  const run = f.request().delivery, handoff = run.handoffs[0]; assert.equal(handoff.reason, 'quota_exhausted'); assert.equal(handoff.freshSession, true); assert.ok(handoff.checkpointCommit);
  assert.notEqual(f.invocations[0].dispatch.session.logicalSessionId, f.invocations[1].dispatch.session.logicalSessionId);
  assert.equal(f.invocations[1].dispatch.session.logicalSessionId, handoff.logicalSessionId); assert.equal(f.request().provider.id, 'claude-cli'); assert.equal(f.task.provider, 'claude-cli');
  assert.deepEqual(f.metrics.map(item => item.outcome), ['failed', 'completed']); assert.equal(run.repairAttempts, 0);
});
test('auth, approval, protocol and unknown cessation never authorize fallback spending', async t => {
  /** @type {import('../../src/worker/application/model-result.js').ModelErrorCode[]} */ const codes = ['authentication', 'approval_required', 'protocol', 'process_stop_unconfirmed', 'outcome_unknown', 'cancelled'];
  for (const code of codes) { const f = await setup(t, { fallback: true, primaryError: code }); await assert.rejects(f.execute()); assert.equal(f.invocations.length, 1); assert.equal(f.request().delivery.handoffs, undefined); }
});
test('review protocol rejects malformed, duplicate or falsely typed findings', () => {
  for (const value of ['not JSON', '{"summary":"ok","findings":[{"id":"x","severity":"pass","message":"ok"}]}', JSON.stringify({ summary: 'ok', findings: [{ id: 'x', severity: 'warning', message: 'one' }, { id: 'x', severity: 'warning', message: 'two' }] })]) assert.throws(() => parseDeliveryAssessment(value));
});

for (const primary of /** @type {const} */ (['claude-cli', 'codex-cli', 'cursor-cli'])) test(`${primary} common delivery contract retains review, repair, checks and replay safety (fixture provider)`, async t => {
  const f = await setup(t, { primary, review: true, blockOnce: true }); assert.ok((await f.execute()).valid);
  const run = f.request().delivery; assert.equal(run.status, 'completed'); assert.equal(run.repairAttempts, 1); assert.equal(run.assessments.at(-1).passed, true); assert.ok(run.review.candidate.candidateCommit);
  assert.equal(f.invocations[0].dispatch.provider.id, primary); assert.equal(f.invocations[0].dispatch.policy.tools, primary === 'cursor-cli' ? 'provider_native' : 'granted');
  assert.equal(run.review.candidate.requestId, f.request().id); assert.equal(run.review.candidate.inputHash, f.request().inputHash);
  assert.equal(run.review.checks[0].status, 'passed'); assert.equal(run.review.checks[0].candidateDigest, run.review.candidate.candidateDigest);
  assert.ok(run.review.checks[0].evidenceRef); assert.equal(run.review.results.find(item => item.criterionId.startsWith('human:')).status, 'pending_human'); assert.equal(run.review.publication, 'local_only');
  await f.execute(); assert.equal(f.invocations.length, 4); assert.equal(f.request().attestation, null);
});

for (const primary of /** @type {const} */ (['claude-cli', 'codex-cli', 'cursor-cli'])) {
  test(`${primary} common delivery contract observes failed verification and bounded repair (fixture provider)`, async t => { const f = await setup(t, { primary, failCheckOnce: true }); assert.ok((await f.execute()).valid); assert.deepEqual(f.request().delivery.steps.filter(step => step.phase === 'verifying').map(step => step.status), ['failed', 'completed']); assert.equal(f.invocations.length, 2); });
  test(`${primary} common delivery contract waits for input without verification or acceptance (fixture provider)`, async t => { const f = await setup(t, { primary, question: true }); assert.equal((await f.execute()).result.type, 'needs_input'); assert.equal(f.request().delivery.status, 'waiting'); assert.equal(f.request().delivery.review, undefined); assert.equal(f.invocations.length, 1); });
  test(`${primary} common delivery contract retains partial edits after auth, limits or cancellation (fixture provider)`, async t => { for (const primaryError of /** @type {const} */ (['authentication', 'quota', 'cancelled'])) { const f = await setup(t, { primary, primaryError }); await assert.rejects(f.execute(), { code: primaryError }); assert.equal(f.invocations.length, 1); assert.ok(f.request().delivery.checkpoints.at(-1).candidateCommit); assert.equal(f.request().delivery.review, undefined); } });
}

test('candidate-review questions use the same canonical needs_input result and never create a second workflow', async t => { const f = await setup(t, { review: true, reviewQuestion: true }); const result = await f.execute(); assert.equal(result.result.type, 'needs_input'); assert.equal(f.request().delivery.status, 'waiting'); assert.equal(f.request().delivery.review, undefined); assert.equal(f.request().delivery.holds.length, 0); await f.execute(); assert.equal(f.invocations.length, 2); });
test('missing accepted reviewer configuration leaves an explicit retryable failed delivery', async t => { const f = await setup(t, { review: true, reviewUnavailable: true }); await assert.rejects(f.execute(), /not available/); assert.equal(f.request().delivery.status, 'failed'); assert.ok(f.request().delivery.allowedControls.includes('retry')); assert.equal(f.invocations.length, 1); });
test('fallback refuses changed target billing before it can dispatch another provider', async t => { const f = await setup(t, { fallback: true, primaryError: 'quota', targetBillingChanged: true }); await assert.rejects(f.execute(), /authentication and billing changed/); assert.equal(f.invocations.length, 1); assert.equal(f.request().delivery.handoffs, undefined); assert.ok(f.request().delivery.checkpoints.length); });

for (const primary of /** @type {const} */ (['claude-cli', 'codex-cli', 'cursor-cli'])) {
  test(`${primary} common contract holds incomplete readiness before any durable invocation`, async t => {
    const { journal } = await fixture(t), policy = defaultGatePolicy(); policy.reviewer.enabled = false;
    policy.ready.patch.push({ id: 'required-detail', fact: 'input.messageLength', op: 'gte', value: 40 });
    const request = journal.ensure({ owner: { sessionId: 'readiness', rootTurnId: 'root', taskId: 'task' }, provider: { id: primary, model: '', instruction: '', effort: 'default', authenticationMode: 'cli-account' }, policy, input: { kind: 'patch', title: 'Incomplete request', message: 'Needs detail.', files: [{ path: 'source.txt', bytes: 1 }] } });
    const waiting = journal.evaluate(request.id, 'ready'); assert.equal(waiting.passed, false);
    journal.bindTurn(request.id, 'turn'); assert.throws(() => journal.prepareExecution(request.id, 'turn', 'would-spend'), /ready|Readiness/i);
    const events = journal.events(request.id).events; for (let index = 0; index < 5; index++) assert.equal(journal.evaluate(request.id, 'ready').passed, false);
    assert.deepEqual(journal.events(request.id).events, events); assert.equal(journal.get(request.id).execution, null);
  });
  test(`${primary} common contract restores the completed review after a journal restart without model replay`, async t => {
    const f = await setup(t, { primary, review: true }), delivered = await f.execute(); assert.ok(delivered.valid); f.record(delivered);
    const before = f.request(), calls = f.invocations.length; await f.restart();
    assert.equal(f.request().phase, 'review'); assert.deepEqual(f.request().delivery.review, before.delivery.review); assert.equal(f.request().execution.outputDigest, before.execution.outputDigest);
    assert.ok((await f.execute()).valid); assert.equal(f.invocations.length, calls); assert.equal(f.request().attestation, null);
  });
  test(`${primary} common contract reconciles unknown dispatch after restart instead of replaying implementation`, async t => {
    const f = await setup(t, { primary, primaryError: 'outcome_unknown' }); await assert.rejects(f.execute(), { code: 'outcome_unknown' });
    const step = f.request().delivery.steps.at(-1); assert.equal(step.status, 'running'); await f.restart();
    const unknown = f.request().delivery; assert.equal(unknown.status, 'outcome_unknown'); assert.equal(unknown.steps.at(-1).id, step.id); assert.equal(unknown.steps.at(-1).status, 'outcome_unknown'); assert.equal(unknown.decision.selectedAction, 'reconcile');
    for (let index = 0; index < 3; index++) await assert.rejects(f.execute(), DeliverySuspended);
    assert.equal(f.invocations.length, 1); assert.equal(f.request().delivery.review, undefined); assert.equal(f.request().delivery.handoffs, undefined);
  });
}

test('review finding severity must be a string and cannot hide a blocking finding in a coercible value', () => {
  for (const severity of [['blocking'], ['warning'], { value: 'blocking' }, true, null]) assert.throws(() => parseDeliveryAssessment(JSON.stringify({ summary: 'Review', findings: [{ id: 'gap', severity, message: 'Missing accepted behavior.' }] })), /severity/);
});
