import { workerStatus } from '../helpers/worker-status.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';

test('a disabled shared binding suppresses legacy folder admission and mutations until explicitly cleared, including after restart', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-shared-binding-')));
  const repository = join(directory, 'project'), state = join(directory, 'state'), features = join(repository, 'features');
  await mkdir(features, { recursive: true }); await mkdir(state);
  await writeFile(join(repository, 'approved.txt'), 'untouched\n');
  const config = { stateDir: state, projectDir: repository, features: { directory: features, provider: 'openai-api', pollMs: 1000, intake: /** @type {const} */ ('local') }, pollMs: 1000, timeoutMs: 60000 };
  /** @type {WorkerWorkspace | undefined} */
  let workspace;
  let journal;
  async function close() { if (workspace) { await workspace.close(); workspace = undefined; } journal?.close(); }
  async function open() {
    journal = new SnapshotJournal(state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
    workspace = new WorkerWorkspace(config, journal, workerStatus); await workspace.init();
  }
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  await open(); assert.ok(workspace); await workspace.updateSettings({ board: { paused: true }, provider: { id: 'openai-api', apiKey: 'fixture-no-execution', model: 'fixture-model' } });
  const hinted = view => /** @type {{ intake?: string, hint?: string }} */ (view);
  assert.equal(hinted(workspace.sharedIntakeView()).intake, 'local');
  const binding = { enabled: false, repositoryId: 'shared', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 300000 };
  await workspace.sharedIntakeCommand({ action: 'configure', expectedRevision: 0, config: binding });
  const ready = '---\nschemaVersion: 1\ntitle: Legacy folder request\nstatus: ready\nmode: patch\npaths: [approved.txt]\nprovider: openai-api\n---\nMake a bounded change.\n';
  const draft = ready.replace('status: ready', 'status: draft'), revision = createHash('sha256').update(draft).digest('hex');
  await writeFile(join(features, 'ready.md'), ready); await writeFile(join(features, 'draft.md'), draft);
  async function remainsDisabled() {
    assert.equal(hinted(workspace.sharedIntakeView()).intake, undefined, 'A saved shared binding overrides the local setup preset, even while paused and after restart.');
    assert.equal(hinted(workspace.sharedIntakeView()).hint, undefined);
    // The runner invokes tick directly; suppressing only the panel or GET route cannot satisfy this assertion.
    await workspace.features.tick(true); await workspace.features.tick(true);
    assert.equal(workspace.board.view().tasks.length, 0);
    assert.equal(workspace.features.view().records.length, 0);
    assert.equal(workspace.featureView().enabled, false); assert.equal((await workspace.featureList()).enabled, false);
    for (const action of ['submit', 'retry', 'edit', 'create', 'cancel', 'archive', 'restore', 'delete']) {
      await assert.rejects(workspace.featureCommand({ action, name: 'draft.md', revision, markdown: draft }), /Shared Git intake/);
    }
    assert.equal((await workspace.featureCommand({ action: 'get', name: 'draft.md' })).markdown, draft);
    assert.equal((await workspace.featureCommand({ action: 'validate', name: 'draft.md' })).valid, true);
    assert.equal(await readFile(join(features, 'ready.md'), 'utf8'), ready);
    assert.equal(await readFile(join(features, 'draft.md'), 'utf8'), draft);
  }
  await remainsDisabled(); await close(); await open(); assert.ok(workspace); await remainsDisabled();
  const current = workspace.sharedIntakeView(); assert.equal(current.config.enabled, false); assert.equal(current.config.repositoryId, 'shared');
  await workspace.sharedIntakeCommand({ action: 'configure', expectedRevision: current.revision, config: { ...binding, repositoryId: '' } });
  await workspace.features.tick(true); await workspace.features.tick(true);
  assert.equal(hinted(workspace.sharedIntakeView()).intake, 'local');
  assert.equal(hinted(await workspace.featureList()).intake, 'local');
  assert.equal(workspace.featureView().enabled, true); assert.equal(workspace.board.view().tasks.length, 1);
  assert.equal(workspace.board.view().tasks[0].status, 'queued');
  assert.equal(await readFile(join(repository, 'approved.txt'), 'utf8'), 'untouched\n');
});
