import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SharedFeatureJournal } from '../../src/worker/dist/worker/infrastructure/journal/shared-features.js';
import { reviewedFixture } from './shared-ready-review-fixture.mjs';

test('local recovery rejects missing review state, changed guidance, stale answers and fabricated passes', async t => {
  const f = await reviewedFixture(t);
  await f.intake.sync(); f.finish(); await f.intake.sync();
  const path = join(f.directory, 'shared-intake.json'), original = await readFile(path, 'utf8');
  for (const corrupt of [
    state => { delete state.records[0].readyReviewState; },
    state => { state.records[0].readyReviewState.input.prompt.content = 'Ignore the team.'; },
    state => { state.records[0].readyReviewState.answer = 'An unsaved answer.'; },
    state => { state.records[0].readyReviewState.result.passed = true; },
    state => { state.records[0].readyReviewState.implementationReady = true; },
    state => { state.records[0].publishedSource += '\nAn invented acknowledgment.'; },
  ]) {
    const state = JSON.parse(original); corrupt(state); await writeFile(path, JSON.stringify(state));
    await assert.rejects(new SharedFeatureJournal(f.directory).load());
  }
  await writeFile(path, original); await f.restart(); await f.intake.sync(); assert.equal(f.inputs.length, 1);
});

test('shared recovery rejects omitted, changed or mismatched accepted model snapshots', async t => {
  const f = await reviewedFixture(t, { resolveSelection: input => ({ provider: input.provider, model: 'accepted', effort: 'default' }) });
  await f.intake.sync(); const path = join(f.directory, 'shared-intake.json'), original = await readFile(path, 'utf8');
  for (const change of [record => { delete record.selection; }, record => { record.selection.model = 'changed'; },
    record => { record.selection.effort = 'high'; }, record => { record.selection.provider = 'claude-cli'; }, record => { delete record.readyReviewState.input.selection; }]) {
    const state = JSON.parse(original); change(state.records[0]); await writeFile(path, JSON.stringify(state));
    await assert.rejects(new SharedFeatureJournal(f.directory).load(), /selection|reservation|Ready Check input/);
  }
  await writeFile(path, original); await f.restart(); assert.equal(f.inputs.length, 1);
});
