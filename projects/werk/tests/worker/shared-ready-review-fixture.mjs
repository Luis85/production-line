import assert from 'node:assert/strict';
import { fixture, sourcePath } from './shared-feature-fixture.mjs';
import { readyReviewSessionId, validateReadyReviewInput } from '../../src/worker/dist/worker/application/ready-review-contracts.js';
const readyReviewAnswerStart = '<!-- werk:ready-review:answer -->\n', readyReviewAnswerEnd = '\n<!-- /werk:ready-review:answer -->';

/** @type {import('../../src/worker/application/ready-review-contracts.js').ReadyReviewResult} */
export const questions = { passed: false, summary: 'Clarify the expected keyboard behavior.', findings: [{ kind: 'question', blocking: true, message: 'Should navigation wrap at the final item?' }] };
/** @type {import('../../src/worker/application/ready-review-contracts.js').ReadyReviewResult} */
export const passed = { passed: true, summary: 'The request is actionable.', findings: [] };
export async function reviewedFixture(t, options = {}) {
  /** @type {import('../../src/worker/application/ready-review-contracts.js').ReadyReviewInput[]} */
  const inputs = [];
  /** @type {Map<string, import('../../src/worker/application/ready-review-contracts.js').ReadyReviewExecutionView>} */
  const executions = new Map();
  const controls = { lostScheduleAck: false };
  let f, gates = 0;
  /** @type {import('../../src/worker/application/ready-review-contracts.js').ReadyReviewPort} */
  const port = {
    async schedule(value) {
      const input = validateReadyReviewInput(value);
      const existing = executions.get(input.operationId);
      if (existing) return existing;
      const record = (await f.state()).records[0];
      assert.equal(record.claimed, true);
      assert.equal(record.pending, undefined);
      assert.deepEqual(record.readyReviewState.input, input, 'Immutable reviewer input is durable before admission.');
      assert.equal(f.repositories.get('shared').files.get(record.sourcePath), record.publishedSource, 'The exact acknowledged claim must be present remotely before a paid review.');
      inputs.push(structuredClone(input)); f.events.push('review-start');
      /** @type {import('../../src/worker/application/ready-review-contracts.js').ReadyReviewExecutionView} */
      const execution = { operationId: input.operationId, sessionId: readyReviewSessionId(input), turnId: 'turn-' + input.generation, runId: 'run-' + input.generation, state: 'running' };
      executions.set(input.operationId, execution);
      if (controls.lostScheduleAck) throw Error('Fixture lost review admission acknowledgment');
      return structuredClone(execution);
    },
    inspect(input) { return executions.has(input.operationId) ? structuredClone(executions.get(input.operationId)) : undefined; },
  };
  f = await fixture(t, { ...options, readyReview: port, onReady: () => gates++ });
  return Object.assign(f, { inputs, executions, reviewControls: controls, gateCalls: () => gates,
    finish(result = questions) { Object.assign(executions.get(inputs.at(-1).operationId), { state: 'completed', result: structuredClone(result) }); },
    interrupt() { Object.assign(executions.get(inputs.at(-1).operationId), { state: 'interrupted', error: 'Explicit recovery guidance is required.' }); },
    answer(answer, edit = markdown => markdown) {
      const current = f.repositories.get('shared').files.get(sourcePath);
      const start = current.indexOf(readyReviewAnswerStart) + readyReviewAnswerStart.length, end = current.indexOf(readyReviewAnswerEnd, start);
      assert.ok(start > readyReviewAnswerStart.length && end > start - 1);
      const markdown = edit(current.slice(0, start) + answer + current.slice(end)).replace(/^status: .*$/m, 'status: ready');
      return f.commitFiles('shared', { [sourcePath]: markdown });
    },
  });
}
