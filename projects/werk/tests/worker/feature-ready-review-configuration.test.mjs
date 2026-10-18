import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultFeatureWorkflow, defaultFeatureCheck, validateFeatureWorkflow, validateFeatureReadyReview, featureContentHash } from '../../src/worker/dist/worker/application/feature-workflow.js';
import { authoringTemplateFor, authoringBase } from '../../src/worker/dist/worker/infrastructure/feature-authoring-assets.js';
import { loadFeatureWorkflowSnapshot, assertFeatureWorkflowDefinitionPrompts } from '../../src/worker/dist/worker/infrastructure/features/workflow.js';

const commit = 'a'.repeat(40), reviewPath = 'team/ready-check.md', reviewText = 'Find unresolved requirements and ask focused questions.\n';
function fixture(paths = {}) {
  const configuration = { ...defaultFeatureWorkflow(), ...paths };
  const files = new Map(Object.entries({ '.werk/feature-workflow.json': JSON.stringify(configuration),
    [configuration.readyCheck]: JSON.stringify(defaultFeatureCheck('ready')), [configuration.doneCheck]: JSON.stringify(defaultFeatureCheck('done')),
    [configuration.template]: authoringTemplateFor(), [configuration.base]: authoringBase(configuration),
    [reviewPath]: reviewText, 'team/ready.md': 'Apply the Definition of Ready.\n', 'team/done.txt': 'Apply the Definition of Done.\n' }));
  const reads = [];
  return { configuration, files, reads, load: () => loadFeatureWorkflowSnapshot({ commit, readBlob: async (revision, path) => { reads.push({ revision, path }); return files.get(path) ?? null; } }) };
}
const review = (overrides = {}) => ({ schemaVersion: 1, commit, prompt: { path: reviewPath, content: reviewText, sha256: featureContentHash(reviewText) }, ...overrides });

test('Ready Check is default-off and its configured path remains distinct from implementation definitions', () => {
  assert.equal(Object.hasOwn(defaultFeatureWorkflow(), 'readyReviewPrompt'), false);
  const config = { ...defaultFeatureWorkflow(), readyReviewPrompt: reviewPath, readyPrompt: 'team/ready.md', donePrompt: 'team/done.txt' };
  assert.deepEqual(validateFeatureWorkflow(config), config);
  for (const path of ['', null, '../review.md', '/review.md', 'review.json', 'features/review.md', '.werk/worker/review.md', 'feature-reviews/review.md', config.template, config.readyPrompt, config.donePrompt.toUpperCase()]) {
    assert.throws(() => validateFeatureWorkflow({ ...config, readyReviewPrompt: path }));
  }
});

test('Ready Check validates its exact immutable prompt without reusing implementation guidance', () => {
  const input = review(), accepted = validateFeatureReadyReview(input);
  assert.deepEqual(accepted, input); input.prompt.content = 'Changed'; assert.equal(accepted.prompt.content, reviewText);
  for (const value of [null, {}, review({ schemaVersion: 2 }), review({ commit: 'main' }), review({ extra: true }), review({ prompt: { ...review().prompt, extra: true } }), review({ prompt: { ...review().prompt, content: 'Changed' } }), review({ prompt: { ...review().prompt, path: '../review.md' } }), review({ prompt: { ...review().prompt, content: '\ud800' } })]) {
    assert.throws(() => validateFeatureReadyReview(value));
  }
});

test('workflow loading reads reviewer bytes only when enabled and freezes one commit with all eight sources', async () => {
  const legacy = fixture(), legacySnapshot = await legacy.load();
  assert.equal(Object.hasOwn(legacySnapshot, 'readyReview'), false); assert.equal(Object.hasOwn(legacySnapshot.files, 'readyReviewPrompt'), false);
  assert.equal(legacy.reads.some(read => read.path === reviewPath), false);
  assert.doesNotThrow(() => assertFeatureWorkflowDefinitionPrompts(legacySnapshot));
  const f = fixture({ readyReviewPrompt: reviewPath, readyPrompt: 'team/ready.md', donePrompt: 'team/done.txt' }), snapshot = await f.load();
  assert.deepEqual(snapshot.readyReview, review());
  assert.deepEqual(snapshot.files.readyReviewPrompt, { path: reviewPath, sha256: featureContentHash(reviewText) });
  assert.equal(Object.values(snapshot.files).length, 8); assert.ok(f.reads.every(read => read.revision === commit));
  assert.equal(snapshot.definitionPrompts.ready.path, 'team/ready.md'); assert.equal(snapshot.definitionPrompts.done.path, 'team/done.txt');
  assert.doesNotThrow(() => assertFeatureWorkflowDefinitionPrompts(snapshot));
  f.files.set(reviewPath, 'Later review policy.'); assert.equal(snapshot.readyReview.prompt.content, reviewText);
  const reviewOnly = await fixture({ readyReviewPrompt: reviewPath }).load();
  assert.equal(Object.hasOwn(reviewOnly, 'definitionPrompts'), false, 'Reviewer instructions are not implementation context');
});

test('missing, malformed or oversized configured Ready Check prompts fail closed with their source path', async () => {
  for (const content of [null, '', ' \r\n', 'bad\0prompt', '\ud800', 'é'.repeat(32769)]) {
    const f = fixture({ readyReviewPrompt: reviewPath });
    if (content === null) f.files.delete(reviewPath); else f.files.set(reviewPath, content);
    await assert.rejects(f.load(), error => { assert.ok(String(error).includes(reviewPath)); return true; });
  }
});

test('frozen Ready Check restores only with matching configuration, source descriptor, content and commit', async () => {
  const original = await fixture({ readyReviewPrompt: reviewPath }).load();
  for (const mutate of [
    snapshot => { delete snapshot.readyReview; }, snapshot => { delete snapshot.configuration.readyReviewPrompt; },
    snapshot => { snapshot.readyReview.commit = 'b'.repeat(40); }, snapshot => { snapshot.readyReview.prompt.content += 'Changed'; },
    snapshot => { snapshot.readyReview.prompt.path = 'team/other.md'; }, snapshot => { delete snapshot.files.readyReviewPrompt; },
    snapshot => { snapshot.files.readyReviewPrompt.sha256 = 'b'.repeat(64); }, snapshot => { snapshot.files.readyReviewPrompt.content = reviewText; },
  ]) {
    const snapshot = structuredClone(original); mutate(snapshot);
    assert.throws(() => assertFeatureWorkflowDefinitionPrompts(snapshot));
  }
});
