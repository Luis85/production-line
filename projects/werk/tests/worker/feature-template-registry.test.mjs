import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { runFeatureAuthoring } from '../../src/worker/dist/worker/authoring/cli.js';
import { defaultFeatureWorkflow, defaultFeatureCheck, featureWorkflowSources, validateFeatureWorkflow } from '../../src/worker/dist/worker/application/feature-workflow.js';
import { gateDigest } from '../../src/worker/dist/worker/application/request-gates.js';
import { SharedFeatureAuthoring } from '../../src/worker/dist/worker/application/feature-authoring.js';
import { featureAuthoringDocuments } from '../../src/worker/dist/worker/infrastructure/features/authoring-document.js';
import { loadFeatureWorkflowSnapshot, assertFeatureWorkflowDefinitionPrompts, validateFeatureWorkflowApprovedPaths } from '../../src/worker/dist/worker/infrastructure/features/workflow.js';
import { validateFeatureReviewEligibility } from '../../src/worker/dist/worker/infrastructure/features/review-eligibility.js';

const template = id => `---
schemaVersion: 1
templateId: ${id}
title: Describe the feature
status: draft
mode: patch
paths: []
---
# Goal
Describe the requested outcome.
## Context
Preserve current behavior outside the approved changes.
## Acceptance criteria
- [ ] Implement the approved outcome.
## Verification plan
Run the project checks and inspect the result.
`;
async function fixture(registry = true) {
  const configuration = { ...defaultFeatureWorkflow(), ...(registry ? { templates: [{ id: 'frontend-v1', label: 'Frontend feature', path: 'features/_templates/frontend.md' }] } : {}) };
  const files = new Map(Object.entries({
    '.werk/feature-workflow.json': JSON.stringify(configuration), [configuration.template]: template('default-v1'),
    'features/_templates/frontend.md': template('frontend-v1').replace('mode: patch', 'mode: patch\ncomponent: ""') + '\n## Accessibility\nDescribe focus behavior.\n',
    [configuration.readyCheck]: JSON.stringify(defaultFeatureCheck('ready')), [configuration.doneCheck]: JSON.stringify(defaultFeatureCheck('done')), [configuration.base]: 'views: []\n',
  }));
  const load = () => loadFeatureWorkflowSnapshot({ commit: 'a'.repeat(40), readBlob: async (_commit, path) => files.get(path) ?? null });
  const snapshot = await load();
  /** @type {import('../../src/worker/application/feature-authoring-contracts.ts').FeatureRequestPublication[]} */ const published = [];
  const repository = { async head() { return 'a'.repeat(40); }, async readBlob(_commit, path) { return files.get(path) ?? null; }, async listRequests() { return []; },
    async publishRequest(input) {
      assert.equal(input.workflowDigest, gateDigest(featureWorkflowSources(await load())));
      published.push(input); return { commit: 'b'.repeat(40), head: 'b'.repeat(40) };
    } };
  const binding = { repositoryId: 'project', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json' };
  const authoring = new SharedFeatureAuthoring({ binding: () => binding, repository: () => repository, loadWorkflow: load, documents: featureAuthoringDocuments, async sync() {} });
  return { configuration, files, snapshot, load, authoring, published };
}
const seed = { title: 'Accessible feature', message: 'Allow keyboard users to open the requested result.', paths: ['src/view.ts'], provider: 'claude-cli', templateId: 'frontend-v1' };

test('selected committed template supplies its custom fields, headings and canonical identity', async () => {
  const f = await fixture();
  const draft = await f.authoring.command({ action: 'prepare', operationId: 'frontend-draft', seed });
  assert.equal(draft.templateId, 'frontend-v1'); assert.equal(draft.templates.length, 2);
  assert.match(draft.markdown, /component: ""/); assert.match(draft.markdown, /## Accessibility/);
  assert.equal(draft.readiness.valid, false); assert.match(draft.readiness.errors[0].message, /component/);
  const complete = draft.markdown.replace('component: ""', 'component: results-list');
  const ready = featureAuthoringDocuments.ready(complete, f.snapshot, 'claude-cli');
  assert.equal(ready.valid, true, JSON.stringify(ready.errors));
  const eligible = validateFeatureReviewEligibility(complete, f.snapshot, 'claude-cli');
  assert.equal(eligible.valid, true); assert.equal(eligible.input.templateId, 'frontend-v1');
  const saved = await f.authoring.command({ action: 'publish', operationId: 'frontend-publish', name: draft.name, markdown: complete,
    expectedRevision: null, expectedWorkflowDigest: draft.workflowDigest, expectedBinding: draft.binding, status: 'ready' });
  assert.equal(saved.templateId, 'frontend-v1'); assert.equal(saved.readiness.valid, true);
  assert.ok(f.published[0].workflowFiles.some(file => file.path === 'features/_templates/frontend.md'));
});

test('default selection remains compatible and unknown IDs cannot fall back to another template', async () => {
  const f = await fixture();
  const defaultDraft = await f.authoring.command({ action: 'prepare', operationId: 'default-draft', seed: { ...seed, templateId: 'default-v1' } });
  assert.equal(defaultDraft.templateId, 'default-v1'); assert.doesNotMatch(defaultDraft.markdown, /component:/);
  await assert.rejects(f.authoring.command({ action: 'prepare', operationId: 'unknown-draft', seed: { ...seed, templateId: 'unregistered' } }), /configured project template/);
  assert.equal(featureAuthoringDocuments.ready(defaultDraft.markdown.replace('templateId: default-v1', 'templateId: unregistered'), f.snapshot).valid, false);
});

test('every registry template is protected from code scope and contributes to workflow drift checks', async () => {
  const f = await fixture(), draft = await f.authoring.command({ action: 'prepare', operationId: 'stale-template', seed });
  assert.throws(() => validateFeatureWorkflowApprovedPaths(['features/_templates/frontend.md'], f.configuration), /Approved paths/);
  assert.throws(() => validateFeatureWorkflowApprovedPaths(['features/_templates/'], f.configuration), /Approved paths/);
  f.files.set('features/_templates/frontend.md', f.files.get('features/_templates/frontend.md') + '\nExtra required project guidance.\n');
  assert.notEqual(gateDigest(featureWorkflowSources(await f.load())), draft.workflowDigest);
  await assert.rejects(f.authoring.command({ action: 'prepare', operationId: 'stale-prepare', seed, expectedWorkflowDigest: draft.workflowDigest }), /template or checks changed/);
});

test('frozen template registry recovery validates content hashes, identities and source paths', async () => {
  const f = await fixture(); assertFeatureWorkflowDefinitionPrompts(f.snapshot);
  for (const mutate of [
    snapshot => { snapshot.templates[1].content += '\nTampered\n'; },
    snapshot => { snapshot.templates[1].path = 'src/untrusted.md'; },
    snapshot => { snapshot.templates[1].id = 'another'; },
    snapshot => { snapshot.templates.pop(); },
  ]) {
    const changed = structuredClone(f.snapshot); mutate(changed);
    assert.throws(() => assertFeatureWorkflowDefinitionPrompts(changed), /Frozen/);
  }
});

test('template registry validates distinct paths, IDs, defaults and complete committed files', async () => {
  const f = await fixture();
  for (const templates of [[{ id: 'frontend-v1', label: 'Private', path: '.werk/worker/private.md' }],
    [{ id: 'a', label: 'A', path: f.configuration.template }], [{ id: 'a', label: '', path: 'templates/a.md' }],
    [{ id: 'a', label: 'A', path: 'templates/a.md' }, { id: 'a', label: 'B', path: 'templates/b.md' }]])
    assert.throws(() => validateFeatureWorkflow({ ...f.configuration, templates }));
  f.files.delete('features/_templates/frontend.md'); await assert.rejects(f.load(), /missing/);
  const legacy = await fixture(false);
  assert.equal(legacy.snapshot.templates, undefined);
  assert.deepEqual(featureWorkflowSources(legacy.snapshot), Object.values(legacy.snapshot.files).map(file => ({ ...file })).sort((a, b) => a.path.localeCompare(b.path)));
});

test('offline authoring copies the selected project template and applies its readiness contract', async t => {
  const f = await fixture(), directory = await mkdtemp(join(tmpdir(), 'werk-template-authoring-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [path, content] of f.files) {
    await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), content);
  }
  await mkdir(join(directory, '.werk', 'authoring'));
  const created = await runFeatureAuthoring(['create', '--name', 'frontend.md', '--title', 'Frontend change', '--template-id', 'frontend-v1'], directory);
  assert.ok('templateId' in created); assert.equal(created.templateId, 'frontend-v1');
  const markdown = await readFile(join(directory, 'features', 'frontend.md'), 'utf8');
  assert.match(markdown, /templateId: frontend-v1/); assert.match(markdown, /component: ""/);
  const invalid = await runFeatureAuthoring(['validate', '--file', 'features/frontend.md'], directory);
  assert.equal('valid' in invalid && invalid.valid, false);
  await assert.rejects(runFeatureAuthoring(['create', '--name', 'unknown.md', '--title', 'Unknown template', '--template-id', 'unregistered'], directory), /configured project template/);
});
