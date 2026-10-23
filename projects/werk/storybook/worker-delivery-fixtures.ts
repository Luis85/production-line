import type { DeliveryRun } from '../src/worker/application/delivery-contracts';
import type { DeliveryReviewPackage } from '../src/worker/application/delivery-review-contracts';
import type { RequestEvent } from '../src/worker/application/request-gates';
import { state } from '../src/worker/webview/store';
import { installReviewFixture } from './worker-review-fixtures';
import { fixtureTime } from './worker-fixtures';
export type DeliveryFixture = 'running' | 'paused' | 'unknown' | 'review' | 'lost-ack';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function installDeliveryFixture(variant: DeliveryFixture) {
  const base = installReviewFixture(), request = base.request;
  const originalFetch = (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__;
  const run: DeliveryRun = {
    schemaVersion: 1, id: 'delivery-FR-42', inputRevision: request.inputRevision, inputHash: request.inputHash, policyDigest: request.policyDigest,
    profile: { schemaVersion: 1, id: 'local-feature', version: 1, root: { id: 'root', type: 'action', action: 'implement', reason: 'The accepted plan is ready for implementation.' } },
    profileDigest: 'illustrative-profile-digest', status: variant === 'paused' ? 'paused' : variant === 'unknown' ? 'outcome_unknown' : variant === 'review' ? 'completed' : 'running',
    phase: variant === 'review' ? 'packaging' : 'implementing', control: null, holds: [], repairAttempts: 0, maxRepairAttempts: 2,
    startedAt: '2026-10-15T10:25:00.000Z', finishedAt: variant === 'review' ? fixtureTime : null,
    steps: [
      { id: 'step-plan', phase: 'planning', status: 'completed', turnId: 'turn-plan', invocationRunId: 'invocation-plan', startedAt: '2026-10-15T10:25:00.000Z', finishedAt: '2026-10-15T10:26:00.000Z', detail: 'Inspect request ordering, implement a stable comparison and verify equal-date behavior.', result: { type: 'completed', text: '1. Inspect the current request list.\n2. Preserve equal-date order.\n3. Run required checks before review.' } },
      { id: 'step-implement', phase: 'implementing', status: variant === 'unknown' ? 'outcome_unknown' : variant === 'paused' || variant === 'review' ? 'completed' : 'running', turnId: 'turn-file', invocationRunId: 'run-file', startedAt: '2026-10-15T10:26:00.000Z', finishedAt: variant === 'review' || variant === 'paused' ? fixtureTime : null, detail: variant === 'unknown' ? 'The process result was not confirmed after restart.' : 'Implementing the accepted ordering rules in the owned worktree.' },
    ],
    decision: { profileId: 'local-feature', profileVersion: 1, selectedNode: 'implementation', selectedAction: variant === 'unknown' ? 'reconcile' : variant === 'paused' ? 'wait' : variant === 'review' ? 'review' : 'implement',
      reason: variant === 'paused' ? 'This delivery is paused at a completed step.' : variant === 'unknown' ? 'A previous process may have completed. Reconcile its outcome before another attempt.' : variant === 'review' ? 'Required checks passed. The exact candidate needs human review.' : 'The worker is implementing the accepted request in its worktree.',
      waitingFor: variant === 'paused' ? 'An explicit resume command.' : variant === 'unknown' ? 'A confirmed process outcome.' : variant === 'review' ? 'Human criterion outcomes and a review decision.' : 'The current implementation step to finish.',
      conditions: [{ nodeId: 'ready', condition: 'needs_ready', result: false }, { nodeId: 'implementation', condition: 'needs_implementation', result: true }] },
    allowedControls: variant === 'paused' ? ['resume', 'cancel'] : variant === 'unknown' ? ['confirm_stopped'] : variant === 'review' ? [] : ['pause_after_step', 'interrupt', 'cancel'],
  };
  const review: DeliveryReviewPackage = {
    schemaVersion: 1, candidate: { requestId: request.id, inputRevision: 1, inputHash: request.inputHash, runId: run.id, baseline: 'a'.repeat(40), branch: 'werk/FR-42-request-ordering', candidateCommit: 'b'.repeat(40), tree: 'c'.repeat(40), candidateDigest: 'd'.repeat(64), patchDigest: 'e'.repeat(64), policyDigest: request.policyDigest, checkDefinitionDigest: 'f'.repeat(64), createdAt: fixtureTime },
    criteria: [{ id: 'check:acceptance', description: 'Required request acceptance tests pass.', evaluator: 'check', mandatory: true, checkId: 'acceptance' }, { id: 'human:ordering', description: 'Requests with equal dates preserve their original order in the user interface.', evaluator: 'human', mandatory: true }],
    results: [{ criterionId: 'check:acceptance', status: 'passed', evidenceRefs: ['check:acceptance:example'] }, { criterionId: 'human:ordering', status: 'pending_human', evidenceRefs: [], detail: 'A person must inspect the behavior before accepting this candidate.' }],
    checks: [], markdown: '# FR-42 review\n\nIllustrative local review package. No commands ran in this story.\n\n## Human review\n\nCheck equal-date order before accepting this exact candidate.', publication: 'local_only', reviewNotePath: 'feature-reviews/FR-42-review.md',
  };
  request.delivery = run; request.lifecycle = variant === 'review' ? 'in_review' : 'in_progress';
  request.provider.id = 'claude-cli'; base.session.selection = { provider: 'claude-cli', model: 'claude-example', effort: 'high' };
  if (variant === 'unknown') run.review = { ...review, candidate: { ...review.candidate, runId: 'delivery-earlier' } };
  if (variant === 'review') run.review = review;
  else if (variant === 'unknown') { request.phase = 'interrupted'; request.execution!.status = 'interrupted'; }
  else { request.phase = 'running'; request.execution = { ...request.execution!, status: 'running', result: null, outputDigest: null }; }
  request.input.context = { deliveryPolicy: { schemaVersion: 1, baseline: 'a'.repeat(40), configurationDigest: 'example-configuration', configuration: { version: 1, reviewDirectory: 'feature-reviews' }, profile: { id: 'feature', maxRepairAttempts: 2, verificationInputs: ['tests/', 'package.json'] } } };
  const events: RequestEvent[] = [{ schemaVersion: 1, id: 'event-accepted', sequence: 1, requestId: request.id, revision: 1, type: 'accepted', phase: 'ready', at: '2026-10-15T10:24:00.000Z', inputRevision: 1 }, { schemaVersion: 1, id: 'event-started', sequence: 2, requestId: request.id, revision: 2, type: 'delivery_started', phase: 'running', at: run.startedAt, inputRevision: 1, runId: run.id }];
  const receipts = new Set<string>();
  let lost = variant === 'lost-ack';
  function changed() { request.revision++; base.session.requestRevision = request.revision; base.session.requestPhase = request.phase; state.refreshRevision++; }
  const fetchFixture: typeof fetch = async (input, init = {}) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (path === '/api/requests' && body.action === 'events') return Response.json({ schemaVersion: 1, requestId: request.id, events: events.filter(event => event.sequence > body.after), nextAfter: events.at(-1)!.sequence, hasMore: false });
    if (path === '/api/requests' && ['pause_after_step', 'resume', 'interrupt', 'cancel', 'confirm_stopped', 'attest', 'request_changes'].includes(body.action)) {
      base.mutations.push(clone(body));
      if (receipts.has(body.operationId)) return Response.json({ request, duplicate: true });
      if (body.expectedRevision !== request.revision) return Response.json({ error: 'The request changed. Refresh before taking action.' }, { status: 409 });
      receipts.add(body.operationId);
      if (body.action === 'pause_after_step') { run.status = 'pause_pending'; run.control = { action: 'pause_after_step', operationId: body.operationId, at: fixtureTime }; run.allowedControls = ['interrupt', 'cancel']; }
      if (body.action === 'confirm_stopped') { if (!body.note?.trim()) throw Error('A stopped-process confirmation needs the operator observation.'); run.checkpoints = [{ ...review.candidate, branch: 'werk/checkpoints/FR-42-stopped', candidateCommit: 'c'.repeat(40) }]; run.recoveries = [{ source: 'operator_attestation', operationId: body.operationId, note: body.note, at: fixtureTime, candidateDigest: 'operator-observed-workspace-digest' }]; run.status = 'interrupted'; request.phase = 'interrupted'; request.execution!.status = 'interrupted'; request.execution!.outcome = 'interrupted'; base.task.status = 'interrupted'; base.session.status = 'interrupted'; run.steps[1]!.status = 'interrupted'; run.allowedControls = ['resume', 'cancel']; run.decision.reason = 'The operator confirmed that the previous processes stopped. Work remains interrupted until explicit resume.'; run.decision.waitingFor = 'An explicit resume command.'; }
      if (body.action === 'resume') { run.status = 'queued'; run.allowedControls = ['cancel']; run.decision.reason = 'Resume is recorded. Waiting for the shared execution slot.'; }
      if (body.action === 'interrupt') { run.status = 'interrupting'; run.allowedControls = []; }
      if (body.action === 'cancel') { run.status = 'cancelled'; request.lifecycle = 'cancelled'; request.phase = 'cancelled'; run.allowedControls = ['reopen']; }
      if (body.action === 'request_changes') { run.status = 'waiting'; request.phase = 'needs_rework'; request.lifecycle = 'in_progress'; run.holds = [{ code: 'review_changes', reason: body.note }]; }
      if (body.action === 'attest') {
        if (body.candidateCommit !== review.candidate.candidateCommit || body.humanOutcomes?.length !== 1 || body.humanOutcomes[0].outcome !== 'passed') throw Error('Illustrative acceptance must bind the candidate and explicit human outcome.');
        request.attestation = { actor: 'operator', inputHash: request.inputHash, outputDigest: request.execution!.outputDigest!, note: body.note, at: fixtureTime }; request.phase = 'done'; request.lifecycle = 'done';
        request.evaluations.at(-1)!.passed = true; request.findings = []; run.humanOutcomes = body.humanOutcomes.map((outcome: object) => ({ ...outcome, actor: 'operator', at: fixtureTime })); review.results[1]!.status = 'passed';
      }
      changed(); events.push({ ...events[0]!, id: 'event-' + events.length, sequence: events.length + 1, revision: request.revision, type: body.action, phase: request.phase, at: fixtureTime, runId: run.id });
      if (lost) { lost = false; return Response.json({ error: 'The response was interrupted after the command was saved.' }, { status: 503 }); }
      return Response.json({ request, duplicate: false });
    }
    return originalFetch(input, init);
  };
  (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = fetchFixture;
  return { ...base, run, review, refreshObservation() { run.decision.waitingFor = 'An updated worker observation; your review draft is retained.'; changed(); }, finishStep() { run.status = 'paused'; run.steps[1]!.status = 'completed'; run.steps[1]!.finishedAt = fixtureTime; run.allowedControls = ['resume', 'cancel']; changed(); } };
}
