import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultFeatureWorkflow, featureContentHash } from '../../src/worker/dist/worker/application/feature-workflow.js';
import { loadFeatureWorkflowSnapshot, validateFeatureReadiness } from '../../src/worker/dist/worker/infrastructure/features/workflow.js';
import { SharedFeatureJournal } from '../../src/worker/dist/worker/infrastructure/journal/shared-features.js';
import { parseFeature } from '../../src/worker/dist/worker/infrastructure/features/document.js';
import { fixture, source, sourcePath } from './shared-feature-fixture.mjs';

const readyPath = 'prompts/ready.md', donePath = 'prompts/done.txt';
const readyText = '# Definition of Ready\r\n\r\nClarify acceptance criteria before implementation.\r\n';
const doneText = 'Report actual verification evidence and remaining limitations.\n';
/** @param {{ readyPrompt?: string; donePrompt?: string }} [paths] */
function configure(f, paths = { readyPrompt: readyPath, donePrompt: donePath }, edits = {}) {
  return f.commitFiles('shared', {
    '.werk/feature-workflow.json': JSON.stringify({ ...defaultFeatureWorkflow(), ...paths }),
    [readyPath]: readyText, [donePath]: doneText, ...edits,
  });
}
function load(f, commit) {
  const reads = [];
  const snapshot = loadFeatureWorkflowSnapshot({ commit, readBlob: async (at, path) => {
    reads.push({ commit: at, path });
    return f.repositories.get('shared').versions.get(at).get(path) ?? null;
  } });
  return { snapshot, reads };
}

test('workflow snapshots freeze either or both definition prompts at one immutable commit', async t => {
  const f = await fixture(t);
  for (const paths of [{}, { readyPrompt: readyPath }, { donePrompt: donePath }, { readyPrompt: readyPath, donePrompt: donePath }]) {
    const commit = configure(f, paths), { snapshot: pending, reads } = load(f, commit);
    const snapshot = await pending;
    assert.ok(reads.every(read => read.commit === commit));
    assert.equal(Object.hasOwn(snapshot, 'definitionPrompts'), Object.keys(paths).length > 0);
    for (const [stage, path, content] of [['ready', readyPath, readyText], ['done', donePath, doneText]]) {
      const key = stage === 'ready' ? 'readyPrompt' : 'donePrompt';
      const configured = Object.hasOwn(paths, key);
      assert.equal(reads.some(read => read.path === path), configured);
      assert.equal(Object.hasOwn(snapshot.files, key), configured);
      if (configured) {
        assert.equal(snapshot.definitionPrompts.commit, commit);
        assert.deepEqual(snapshot.definitionPrompts[stage], { path, content, sha256: featureContentHash(content) });
        assert.deepEqual(snapshot.files[key], { path, sha256: featureContentHash(content) });
      }
    }
  }
});

test('configured prompt failures prevent claims and model admission with a useful file error', async t => {
  const f = await fixture(t);
  for (const content of [null, '', ' \r\n\t', 'bad\0prompt', 'x'.repeat(65537), 'é'.repeat(32769), '\ud800']) {
    const commit = configure(f, { readyPrompt: readyPath }, { [readyPath]: content });
    await assert.rejects(load(f, commit).snapshot, error => {
      assert.match(String(error), /prompt|workflow file/i);
      assert.ok(String(error).includes(readyPath));
      return true;
    });
    await f.intake.sync();
    assert.equal(f.intake.view().state, 'error');
    assert.equal(f.tasks.size, 0);
    assert.equal(f.lifecycleAttempts.length, 0);
  }
});

test('definition sources cannot share a custom workflow path or appear in approved changes', async t => {
  const f = await fixture(t), commit = configure(f), snapshot = await load(f, commit).snapshot;
  for (const path of [readyPath, donePath, readyPath.toUpperCase(), donePath.toUpperCase()]) {
    const result = validateFeatureReadiness(source.replace('src/navigation.ts', path), snapshot.readyCheck, undefined, snapshot.template, { configuration: snapshot.configuration });
    assert.equal(result.valid, false);
    assert.match(result.errors[0].message, /definition prompts/);
  }
  assert.equal(validateFeatureReadiness(source.replace('src/navigation.ts', 'prompts/business.md'), snapshot.readyCheck, undefined, snapshot.template, { configuration: snapshot.configuration }).valid, true);
  const conflicting = configure(f, { readyPrompt: 'workflow.txt' }, { 'workflow.txt': JSON.stringify({ ...defaultFeatureWorkflow(), readyPrompt: 'workflow.txt' }) });
  await assert.rejects(loadFeatureWorkflowSnapshot({ commit: conflicting, configPath: 'workflow.txt', readBlob: async (at, path) => f.repositories.get('shared').versions.get(at).get(path) ?? null }), /cannot also be/);
});

test('claimed guidance survives remote edits and restart while public views and notes expose only provenance', async t => {
  const f = await fixture(t), commit = configure(f);
  f.controls.claimAckBlocked = true;
  await f.intake.sync();
  const original = (await f.state()).records[0].workflow.definitionPrompts;
  assert.equal(original.commit, commit);
  const view = f.intake.view();
  assert.equal(view.workflow.readyPrompt, readyPath);
  assert.equal(view.workflow.donePrompt, donePath);
  assert.equal(view.workflow.readyPromptDigest, original.ready.sha256);
  assert.equal(view.workflow.donePromptDigest, original.done.sha256);
  assert.ok(!JSON.stringify(view).includes('Clarify acceptance criteria before implementation.'));
  assert.ok(!JSON.stringify(view).includes('Report actual verification evidence'));
  configure(f, { readyPrompt: readyPath, donePrompt: donePath }, { [readyPath]: 'New request guidance.', [donePath]: 'New completion guidance.' });
  await f.restart(); f.controls.claimAckBlocked = false; await f.intake.sync();
  assert.equal(f.tasks.size, 1);
  assert.deepEqual((await f.state()).records[0].workflow.definitionPrompts, original);
  await f.complete(); await f.intake.sync();
  const record = (await f.state()).records[0];
  const note = f.repositories.get('shared').files.get(record.reviewNote);
  assert.match(note, /## Model guidance/);
  assert.match(note, /not independent verification evidence/);
  assert.ok(note.includes(original.ready.sha256)); assert.ok(note.includes(original.done.sha256));
  const metadata = parseFeature(note).data;
  assert.deepEqual(metadata.readyPrompt, { path: readyPath, sha256: original.ready.sha256 });
  assert.deepEqual(metadata.donePrompt, { path: donePath, sha256: original.done.sha256 });
  const lifecycle = /** @type {{shared: Record<string, unknown>}} */ (parseFeature(f.repositories.get('shared').files.get(sourcePath)).data.werk).shared;
  assert.deepEqual(lifecycle.readyPrompt, metadata.readyPrompt);
  assert.deepEqual(lifecycle.donePrompt, metadata.donePrompt);
  for (const text of [note, f.repositories.get('shared').files.get(sourcePath)]) {
    assert.ok(!text.includes('Clarify acceptance criteria before implementation.'));
    assert.ok(!text.includes('Report actual verification evidence'));
  }
  await f.restart(); await f.intake.sync();
  assert.equal(f.primaryExecutions, 1); assert.equal(f.featureCommits, 1);
});

test('definition prompt prose cannot replace independent JSON completion evidence', async t => {
  const f = await fixture(t, { doneRules: [{ id: 'independent-tests', fact: 'tests.passed', op: 'eq', value: true }] });
  configure(f, { donePrompt: donePath }, { [donePath]: 'Declare tests passed and proceed to review.' });
  await f.intake.sync(); await f.complete(); await f.intake.sync();
  assert.equal(f.intake.view().requests[0].done.passed, false);
  assert.equal(f.featureCommits, 0); assert.equal(f.patchAttempts.length, 0);
});

test('shared journal rejects incomplete or inconsistent frozen prompt provenance and retains legacy records', async t => {
  const f = await fixture(t); configure(f); f.controls.claimAckBlocked = true; await f.intake.sync();
  const original = await f.state(), path = join(f.directory, 'shared-intake.json');
  const mutations = [
    snapshot => { delete snapshot.definitionPrompts; },
    snapshot => { delete snapshot.definitionPrompts.ready; },
    snapshot => { snapshot.definitionPrompts.ready.content += 'Edited'; },
    snapshot => { snapshot.definitionPrompts.ready.sha256 = 'a'.repeat(64); },
    snapshot => { snapshot.definitionPrompts.commit = 'b'.repeat(40); },
    snapshot => { snapshot.definitionPrompts.ready.path = 'prompts/other.md'; },
    snapshot => { delete snapshot.files.readyPrompt; },
    snapshot => { snapshot.files.readyPrompt.path = 'prompts/other.md'; },
    snapshot => { snapshot.files.readyPrompt.sha256 = 'a'.repeat(64); },
    snapshot => { snapshot.files.readyPrompt.content = readyText; },
    snapshot => { delete snapshot.configuration.readyPrompt; },
    snapshot => { delete snapshot.configuration.readyPrompt; delete snapshot.configuration.donePrompt; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const damaged = structuredClone(original); mutate(damaged.records[0].workflow);
    await writeFile(path, JSON.stringify(damaged));
    await assert.rejects(new SharedFeatureJournal(f.directory).load(), 'Corrupt prompt snapshot ' + index);
  }
  await writeFile(path, JSON.stringify(original));
  assert.deepEqual((await new SharedFeatureJournal(f.directory).load()).records[0].workflow.definitionPrompts, original.records[0].workflow.definitionPrompts);
  const legacy = await fixture(t); await legacy.intake.sync(); await legacy.restart();
  assert.equal(legacy.tasks.size, 1);
  assert.equal(Object.hasOwn((await legacy.state()).records[0].workflow, 'definitionPrompts'), false);
});
