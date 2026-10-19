import test from 'node:test';
import { parseTrackedFeature } from './feature-fixtures.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { modelSelection } from '../../src/worker/dist/worker/application/model-selection.js';
import { FeatureRequests } from '../../src/worker/dist/worker/application/feature-requests.js';
import { MarkdownFeatureFolder } from '../../src/worker/dist/worker/infrastructure/features/folder.js';
import { parseFeature, featureInput, featureRequestContext } from '../../src/worker/dist/worker/infrastructure/features/document.js';
import { initializeFeatureAuthoring } from '../../src/worker/dist/worker/infrastructure/feature-authoring.js';
import { runFeatureAuthoring } from '../../src/worker/dist/worker/authoring/cli.js';
import { loadFeatureWorkflowSnapshot } from '../../src/worker/dist/worker/infrastructure/features/workflow.js';
import { featureAuthoringDocuments } from '../../src/worker/dist/worker/infrastructure/features/authoring-document.js';

const markdown = (extra = '') => '---\nschemaVersion: 1\ntitle: Explain export\nstatus: ready\n' + extra + '---\n# Goal\nExplain export behavior.\n';
async function directory(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk-feature-selection-')));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('Markdown selection fields are typed request intent and never promoted into author metadata', () => {
  const parsed = parseFeature(markdown('provider: openai-api\nmodel: gpt-test\neffort: high\ncomponent: exports\n'));
  const input = featureInput(parsed, 'claude-cli');
  assert.equal(input.provider, 'openai-api'); assert.equal(input.model, 'gpt-test'); assert.equal(input.effort, 'high');
  assert.deepEqual(featureRequestContext(parsed.data, input).metadata, { component: 'exports' });
  assert.equal(featureInput(parseFeature(markdown()), 'claude-cli').provider, 'claude-cli');
  assert.equal(featureInput(parseFeature(markdown('effort: none\n')), 'codex-cli').effort, 'none', 'offline omitted provider defers capability validation to acceptance');
  assert.throws(() => featureInput(parseFeature(markdown('provider: cursor-cli\neffort: high\n')), 'codex-cli'), /supported effort/);
  assert.throws(() => featureInput(parseFeature(markdown('model: "--force"\n')), 'codex-cli'), /Model/);
});

test('offline and web drafts preserve explicit model effort and reject unsupported combinations before writing', async t => {
  const root = await directory(t); await initializeFeatureAuthoring(root, { script: '// Fixture authoring kit\n' });
  const created = await runFeatureAuthoring(['create', '--name', 'selected.md', '--title', 'Export orders', '--provider', 'openai-api', '--model', 'gpt-test', '--effort', 'high'], root);
  assert.ok('path' in created);
  const raw = await readFile(join(root, created.path), 'utf8'), parsed = parseFeature(raw);
  assert.equal(parsed.data.provider, 'openai-api'); assert.equal(parsed.data.model, 'gpt-test'); assert.equal(parsed.data.effort, 'high');
  const prior = await readdir(join(root, 'features'));
  await assert.rejects(runFeatureAuthoring(['create', '--name', 'bad.md', '--title', 'Invalid effort', '--provider', 'cursor-cli', '--effort', 'high'], root), /supported effort/);
  assert.deepEqual(await readdir(join(root, 'features')), prior);
  const snapshot = await loadFeatureWorkflowSnapshot({ commit: 'a'.repeat(40), readBlob: async (_commit, path) => readFile(join(root, path), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; }) });
  const seeded = featureAuthoringDocuments.prepare(snapshot, 'fr-seeded', { title: 'Export orders', message: 'Add CSV export.', provider: 'claude-cli', model: 'claude-test', effort: 'max' });
  assert.equal(parseFeature(seeded).data.effort, 'max'); assert.equal(parseFeature(seeded).data.model, 'claude-test');
  assert.throws(() => featureAuthoringDocuments.prepare(snapshot, 'fr-bad', { title: 'Bad', message: '', provider: 'cursor-cli', effort: 'high' }), /supported effort/);
});

test('folder intake freezes defaults before submission and restart while later requests use new defaults', async t => {
  const project = await directory(t), state = join(project, 'state'), features = join(project, 'features'); await mkdir(state);
  /** @type {import('../../src/worker/application/provider-contract.ts').ProviderConnection} */
  let current = { id: 'codex-cli', model: 'initial-model', effort: 'medium', executable: '', apiKey: '' };
  /** @type {import('../../src/worker/application/feature-requests.ts').FeatureRecord[]} */
  const submitted = [];
  const accepted = new Set(); let selectionCalls = 0;
  /** @type {import('../../src/worker/application/feature-requests.ts').FeatureQueuePort} */
  const queue = {
    selection(input) { selectionCalls++; return modelSelection({ ...current, id: /** @type {import('../../src/worker/application/provider-contract.ts').ProviderId} */ (input.provider) }, input); },
    async submit(record) { submitted.push(structuredClone(record)); accepted.add(record.taskId); },
    inspect(record) { return accepted.has(record.taskId) ? { status: 'queued' } : undefined; },
  };
  const open = async () => { const folder = new MarkdownFeatureFolder(features, state, () => current.id, project); const service = new FeatureRequests(folder, queue, 0); await service.init(); return service; };
  let service = await open();
  const scan = async () => { await service.tick(true); await service.tick(true); };
  try {
    await writeFile(join(features, 'first.md'), markdown()); await scan();
    assert.deepEqual(submitted[0].selection, { provider: 'codex-cli', model: 'initial-model', effort: 'medium' });
    current = { ...current, id: 'claude-cli', model: 'next-model', effort: 'high' };
    await scan(); await service.close(); service = await open(); await scan();
    assert.equal(selectionCalls, 1); assert.equal(submitted.length, 1);
    assert.equal(parseTrackedFeature(await readFile(join(features, 'first.md'), 'utf8')).data.werk?.inputChanged, undefined);
    await writeFile(join(features, 'second.md'), markdown()); await scan();
    assert.deepEqual(submitted[1].selection, { provider: 'claude-cli', model: 'next-model', effort: 'high' });
    assert.equal(submitted[0].input?.provider, 'codex-cli');
    const retained = JSON.parse(await readFile(join(state, 'feature-index.json'), 'utf8'));
    assert.equal(retained.records[0].selection.model, 'initial-model');
    for (const selection of [null, { provider: 'openai-api', model: 'initial-model', effort: 'medium' }]) {
      const corrupted = structuredClone(retained); corrupted.records[0].selection = selection;
      await writeFile(join(state, 'feature-index.json'), JSON.stringify(corrupted));
      await assert.rejects(new MarkdownFeatureFolder(features, state, () => current.id, project).load());
    }
    await writeFile(join(state, 'feature-index.json'), JSON.stringify(retained));
  } finally { await service.close(); }
});
