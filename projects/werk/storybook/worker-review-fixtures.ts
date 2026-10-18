import { state } from '../src/worker/webview/store';
import type { WorkerRequest, GateEvaluation } from '../src/worker/application/request-gates';
import type { SharedFeatureView } from '../src/worker/application/shared-intake-contract';
import type { FeatureRequestReference } from '../src/worker/application/feature-request-reference';
import { installDevelopmentFixture } from './worker-development-fixtures';
import { fixtureTime } from './worker-fixtures';
export type ReviewFixture = 'verified' | 'failed' | 'stale' | 'publishing' | 'published' | 'question' | 'interrupted' | 'missing';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
/** Fictional receipts for the real review UI. No model, command, Git write or runtime save occurs. */
export function installReviewFixture(variant: ReviewFixture = 'verified') {
  const base = installDevelopmentFixture(variant === 'failed' || variant === 'stale' ? variant : 'passed');
  const task = base.task;
  task.patch += 'diff --git a/test/requests.test.ts b/test/requests.test.ts\n--- a/test/requests.test.ts\n+++ b/test/requests.test.ts\n@@ -1 +1,2 @@\n test("orders requests", verifyOldestFirst);\n+test("preserves equal dates", verifyStableOrder);\n';
  const session = state.sessions!.records.find(item => item.id === task.sessionId)!;
  session.selection = { provider: 'codex-cli', model: 'gpt-fixture', effort: 'high' };
  const feature: FeatureRequestReference = { key: 'example-request-ordering', id: 'FR-42', source: variant === 'publishing' || variant === 'published' ? 'shared_git' : 'interaction', scope: 'storybook', sourcePath: 'features/FR-42-request-ordering.md', repositoryId: 'web' };
  const request: WorkerRequest = {
    schemaVersion: 1, id: 'review-ordering', owner: { sessionId: session.id, taskId: task.id, rootTurnId: 'turn-file', featureId: feature.key },
    revision: 3, inputRevision: 1, input: { kind: 'patch', title: task.title, message: task.instruction, criteria: ['Oldest requests appear first.', 'Requests with equal dates retain their input order.', 'Acceptance tests and project types pass.'], files: task.files.map(file => ({ path: file.path, bytes: file.content.length })) },
    inputHash: 'example-input', policyDigest: 'example-policy', provider: { id: 'codex-cli', model: 'gpt-fixture', instruction: 'Work within the accepted feature scope.' }, phase: 'review', assignee: 'operator', createdAt: fixtureTime, updatedAt: fixtureTime, reworkCount: 0,
    policy: { schemaVersion: 1, id: 'review-policy', version: 1, ready: { chat: [], patch: [{ id: 'instructions', fact: 'input.messageLength', op: 'gte', value: 10 }] }, done: { chat: [], patch: [{ id: 'verified', fact: 'output.verificationPassed', op: 'eq', value: true }, { id: 'acceptance', fact: 'operator.accepted', op: 'eq', value: true }] }, reviewer: { enabled: false, provider: 'codex-cli', maxAttempts: 1 }, rework: { maxAttempts: 3 } },
    evaluations: [], findings: [], candidates: [], reviews: [], attestation: null,
    execution: { turnId: 'turn-file', runId: 'run-file', inputRevision: 1, status: 'completed', outcome: 'completed', result: { type: 'completed', text: '**Stable ordering implemented.** Requests are sorted by creation time. Equal dates preserve their original order.\n\nThe retained patch and check receipts below are illustrative examples.' }, outputDigest: 'example-output', facts: { 'output.verificationPassed': true, 'output.nonEmpty': true } },
  };
  const evaluation = (stage: 'ready' | 'done'): GateEvaluation => ({ id: 'example-' + stage, stage, inputRevision: 1, inputHash: request.inputHash, policyDigest: request.policyDigest, outputDigest: stage === 'done' ? 'example-output' : null, at: fixtureTime, passed: stage === 'ready', facts: {}, rules: stage === 'ready' ? [{ ruleId: 'instructions', fact: 'input.messageLength', expected: 10, observed: task.instruction.length, result: 'pass' }] : [{ ruleId: 'verified', fact: 'output.verificationPassed', expected: true, observed: true, result: 'pass' }, { ruleId: 'acceptance', fact: 'operator.accepted', expected: true, observed: false, result: 'fail' }] });
  request.evaluations = [evaluation('ready'), evaluation('done')];
  request.findings = [{ id: 'acceptance-needed', kind: 'gap', message: 'Human acceptance has not been recorded.', blocking: true, source: 'deterministic', evaluationId: 'example-done', ruleId: 'acceptance', status: 'open' }];
  if (variant === 'failed' || variant === 'stale') {
    request.phase = 'needs_rework';
    Object.assign(request.evaluations[1]!.rules[0]!, { observed: variant === 'failed' ? false : null, result: variant === 'failed' ? 'fail' : 'unknown' });
  }
  const interaction = clone(session.interaction);
  if (variant === 'question' || variant === 'interrupted') {
    interaction.phase = variant === 'question' ? 'waiting_input' : 'interrupted';
    if (interaction.latestTurn) interaction.latestTurn.status = interaction.phase;
    interaction.pending = variant === 'question' ? { id: 'timezone-question', kind: 'question', message: 'Which timezone should determine the request date?', reason: 'The team needs to choose a timezone before date ordering can be finalized.', choices: [{ id: 'utc', label: 'UTC for everyone' }], createdAt: fixtureTime, turnId: 'turn-file' } : null;
    request.phase = interaction.phase;
    request.execution = { ...request.execution!, status: variant === 'question' ? 'completed' : 'interrupted', result: null, outputDigest: null };
  }
  Object.assign(task, { requestId: request.id, feature, interaction });
  Object.assign(session, { taskId: session.id, feature, interaction, requestId: request.id, requestRevision: request.revision, requestPhase: request.phase, status: interaction.phase });
  state.sessions!.selected = 'completed';
  const chat = clone(state.chat!);
  let unavailable = false;
  const mutations: Array<Record<string, unknown>> = [];
  const shared: SharedFeatureView = { feature, id: feature.id, name: feature.sourcePath!, title: task.title, status: variant === 'publishing' ? 'publishing' : 'ready_for_review', owner: 'example-worker', isLocal: true, sourceCommit: '1'.repeat(40), updatedAt: fixtureTime, ready: { passed: true, issues: [] }, done: { passed: true, issues: [] }, featureBranch: 'werk/FR-42-request-ordering', reviewNote: 'reviews/FR-42-review.md', publication: variant === 'publishing' ? 'pending' : 'synced', error: null, taskId: task.id };
  function accept(note: string) {
    request.revision++; request.phase = 'done';
    request.attestation = { actor: 'operator', inputHash: request.inputHash, outputDigest: 'example-output', note, at: fixtureTime };
    request.evaluations[1]!.passed = true;
    request.evaluations[1]!.rules.forEach(rule => { rule.result = 'pass'; rule.observed = true; });
    request.findings.forEach(finding => { finding.status = 'resolved'; });
    session.requestRevision = request.revision; session.requestPhase = request.phase;
  }
  if (variant === 'publishing' || variant === 'published') accept('Reviewed the accepted scope and required check receipts. Ready for team code review.');
  const fetchFixture: typeof fetch = async (input, init = {}) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (path === '/api/tasks' && body.action === 'get') return unavailable || variant === 'missing' ? Response.json({ error: 'This feature request is no longer available on this worker.' }, { status: 404 }) : Response.json({ session, chat });
    if (path === '/api/taskboard/detail') return Response.json(task);
    if (path === '/api/shared-intake') return Response.json({ requests: [shared] });
    if (path === '/api/requests') {
      if (body.action === 'list') return Response.json({ schemaVersion: 1, rows: [{ ...request, title: request.input.title, kind: request.input.kind }], total: 1, nextOffset: null });
      if (body.action === 'get') return Response.json(request);
      mutations.push(clone(body));
      if (body.action === 'attest' && body.expectedRevision === request.revision && body.inputHash === request.inputHash && body.outputDigest === request.execution?.outputDigest && variant === 'verified') { accept(body.note); return Response.json({ request, duplicate: false }); }
      return Response.json({ error: 'This illustrative story only accepts the matching acceptance command.' }, { status: 409 });
    }
    if (path === '/api/sessions') {
      if (init.method === 'POST') { mutations.push(clone(body)); return Response.json({ error: 'Review must not select a conversation.' }, { status: 409 }); }
      return Response.json(state.sessions);
    }
    if (path === '/api/chat/session') return Response.json({ sessions: state.sessions, chat: state.chat });
    if (path === '/api/feature-tracking') return Response.json({ ...session.featureRequest, markdown: '# FR-42 · Stable request ordering\n\nIllustrative execution progress for the accepted feature request.\n\n## Status\n\nHuman code review and merge remain with the team.' });
    return base.fetchFixture(input, init);
  };
  (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = fetchFixture;
  return { request, task, session, mutations, quietRefresh() { state.refreshRevision++; }, changeOwnership() { Object.assign(task, { feature: { ...feature, key: 'other-feature' } }); state.refreshRevision++; }, failNextRead() { unavailable = true; state.refreshRevision++; } };
}
