import assert from 'node:assert/strict';

/** A manual sync can join a poll that captured Git before the teammate's push.
 * Observe the published generation before asserting admission. At most one old
 * snapshot may be joined: the next awaited call must perform a fresh cycle.
 * @param {() => Promise<import('../../src/worker/application/shared-intake-contract.js').SharedIntakeView>} sync
 * @param {{ id: string, sourceCommit: string, previousCommit: string, signal: AbortSignal, diagnostic: (message: string) => void }} expected
 */
export async function observePublishedFeature(sync, expected) {
  for (let observation = 0; observation < 2; observation++) {
    expected.signal.throwIfAborted();
    const view = await sync(), detail = JSON.stringify(view);
    assert.equal(view.error, null, detail);
    assert.notEqual(view.state, 'error', detail);
    const row = view.requests.find(row => row.id === expected.id);
    if (row) {
      assert.equal(row.sourceCommit, expected.sourceCommit, 'The request must retain its published source commit. ' + detail);
      assert.equal(row.error, null, detail);
      assert.notEqual(row.ready?.passed, false, detail);
      assert.ok(!['invalid', 'needs_rework', 'blocked', 'failed'].includes(row.status), detail);
      assert.ok(row.taskId, 'The published request was observed but was not admitted. ' + detail);
      return view;
    }
    assert.equal(view.sourceCommit, expected.previousCommit, 'The synchronized generation did not expose the published request. ' + detail);
    assert.equal(observation, 0, 'A fresh synchronization retained the pre-push snapshot. ' + detail);
    expected.diagnostic('Joined pre-push intake snapshot ' + view.sourceCommit + '; synchronizing published request ' + expected.id + ' at ' + expected.sourceCommit + '.');
  }
  throw Error('The published feature was not observed.');
}
