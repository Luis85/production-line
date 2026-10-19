import { resultWith } from './contract-fixtures.mjs';
import { testErrorCode, testErrorMessage } from '../helpers/typed-boundaries.mjs';
import { cleanup } from './fixture-cleanup.mjs';
import { workerStatus } from '../helpers/worker-status.mjs';
import { WorkerDefinitions, previewDefinition } from './application-fixtures.mjs';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const future = 'version: "17"\nagents:\n  root:\n    model: openai/gpt-test\n    instruction: Review the request.\n';
const compatible = future.replace('"17"', '"16"');
const versionItem = 'document.version "17" (supported: 0–16)';
async function directory(t, prefix = 'werk-definition-compatibility-') { const path = await realpath(await mkdtemp(join(tmpdir(), prefix))); cleanup(t, () => rm(path, { recursive: true, force: true })); return path; }
/** @param {unknown} error @param {RegExp[]} patterns */
const rejectedWith = (error, ...patterns) => testErrorCode(error) === 'invalid_input' && patterns.every(pattern => pattern.test(testErrorMessage(error)));
const remedies = [/definition update/, /useInstructionsOnly: true/];

test('an unsupported version names the value and supported range; selection names items and both remedies', async t => {
  const preview = previewDefinition(future);
  assert.deepEqual(preview.agents[0].unsupported, [versionItem]);
  const definitions = WorkerDefinitions(await directory(t)); await definitions.init();
  const { definitions: [definition] } = resultWith(await definitions.action({ action: 'import', name: 'Future reviewer', ref: 'future-reviewer', yaml: future }), 'definitions');
  assert.throws(() => definitions.select({ definitionRef: 'future-reviewer' }), error => rejectedWith(error, /document\.version "17" \(supported: 0–16\)/, /root/, /definition update --ref future-reviewer/, /useInstructionsOnly: true/));
  assert.equal(definitions.select({ definitionId: definition.id, useInstructionsOnly: true })?.adapted, true);
});

test('preview, import and update return warnings naming each agent that needs adaptation', async t => {
  const definitions = WorkerDefinitions(await directory(t)); await definitions.init();
  const expected = /^Agent root requires adaptation: document\.version "17" \(supported: 0–16\)\./;
  const preview = await definitions.action({ action: 'preview', yaml: future });
  assert.equal(preview.warnings?.length, 1); assert.match(preview.warnings[0], expected);
  assert.equal((await definitions.action({ action: 'preview', yaml: compatible })).warnings, undefined);
  const imported = await definitions.action({ action: 'import', name: 'Reviewer', ref: 'project-reviewer', yaml: future });
  assert.match(imported.warnings?.[0] ?? '', expected);
  const { definitions: [saved] } = resultWith(imported, 'definitions');
  const dryRun = await definitions.action({ action: 'update', ref: 'project-reviewer', yaml: future.replace('Review', 'Inspect'), dryRun: true });
  assert.match(dryRun.warnings?.[0] ?? '', expected);
  const updated = await definitions.action({ action: 'update', ref: 'project-reviewer', yaml: future.replace('Review', 'Inspect'), revision: saved.revision });
  assert.match(updated.warnings?.[0] ?? '', expected);
  const { definitions: [current] } = resultWith(updated, 'definitions');
  assert.equal((await definitions.action({ action: 'update', ref: 'project-reviewer', yaml: compatible, revision: current.revision })).warnings, undefined);
});

test('import sets a reference in the same operation and refuses one another definition holds', async t => {
  const definitions = WorkerDefinitions(await directory(t)); await definitions.init();
  const { definitions: [first] } = resultWith(await definitions.action({ action: 'import', name: 'First', ref: 'project-reviewer', yaml: compatible }), 'definitions');
  assert.equal(first.ref, 'project-reviewer');
  await assert.rejects(definitions.action({ action: 'import', name: 'Second', ref: 'project-reviewer', yaml: compatible }), error => testErrorCode(error) === 'conflict' && /already selects First\. Import without a reference, then move it with definition ref\./.test(testErrorMessage(error)));
  assert.equal(definitions.view().definitions.length, 1);
});

async function folderWorkspace(t) {
  const project = await directory(t, 'werk-definition-intake-'), state = join(project, '.state'), features = join(project, 'features');
  await mkdir(state);
  const journal = new SnapshotJournal(state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
  const workspace = new WorkerWorkspace({ stateDir: state, projectDir: project, features: { directory: features, provider: 'openai-api', pollMs: 1000 }, pollMs: 1000, timeoutMs: 60000 }, journal, workerStatus);
  await workspace.init();
  cleanup(t, async () => { await workspace.close(); await journal.close(); });
  await workspace.updateSettings({ provider: { id: 'openai-api', apiKey: 'fixture-no-model-call', model: 'fixture-model' }, board: { paused: true } });
  await workspace.definitions.action({ action: 'import', name: 'Future reviewer', ref: 'future-reviewer', yaml: future });
  const request = (status, extra) => `---\nschemaVersion: 1\ntitle: Review the feature\nstatus: ${status}\nmode: chat\n${extra}---\n# Goal\n\nReview the feature.\n`;
  return { workspace, request, put: (name, text) => writeFile(join(features, name), text) };
}

test('feature validate reports adaptation and unknown references before submission', async t => {
  const { workspace, request, put } = await folderWorkspace(t);
  await put('adapt.md', request('draft', 'definitionRef: future-reviewer\n'));
  await assert.rejects(workspace.featureCommand({ action: 'validate', name: 'adapt.md' }), error => rejectedWith(error, /document\.version "17"/, ...remedies));
  await put('adapted.md', request('draft', 'definitionRef: future-reviewer\nuseInstructionsOnly: true\n'));
  assert.equal((await workspace.featureCommand({ action: 'validate', name: 'adapted.md' })).valid, true);
  await put('unknown.md', request('draft', 'definitionRef: missing-reviewer\n'));
  await assert.rejects(workspace.featureCommand({ action: 'validate', name: 'unknown.md' }), error => rejectedWith(error, /missing-reviewer/, /definition import --ref missing-reviewer/));
  await put('unknown-id.md', request('draft', 'definitionId: missing-id\n'));
  await assert.rejects(workspace.featureCommand({ action: 'validate', name: 'unknown-id.md' }), error => rejectedWith(error, /id missing-id/, /definition list/));
});

test('local folder intake reports an adaptation-requiring request as an intake error instead of waiting', async t => {
  const { workspace, request, put } = await folderWorkspace(t);
  const features = /** @type {NonNullable<typeof workspace.features>} */ (workspace.features);
  await put('adapt.md', request('ready', 'definitionRef: future-reviewer\n'));
  await put('unknown.md', request('ready', 'definitionRef: missing-reviewer\n'));
  await features.tick(true); await features.tick(true);
  const view = features.view();
  assert.deepEqual(view.records, [], 'no request is reserved or left waiting');
  const errors = Object.fromEntries(view.errors.map(error => [error.file, error.message]));
  assert.match(errors['adapt.md'] ?? '', /document\.version "17" \(supported: 0–16\)/);
  for (const remedy of remedies) assert.match(errors['adapt.md'] ?? '', remedy);
  assert.match(errors['unknown.md'] ?? '', /missing-reviewer/);
  await put('adapt.md', request('ready', 'definitionRef: future-reviewer\nuseInstructionsOnly: true\n'));
  await features.tick(true); await features.tick(true);
  assert.deepEqual(features.view().records.map(record => record.name), ['adapt.md'], 'the acknowledged request is admitted');
});
