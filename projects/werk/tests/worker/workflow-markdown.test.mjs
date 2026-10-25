import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeature, featureInput, featureRequestContext } from '../../src/worker/dist/worker/infrastructure/features/document.js';
import { markdownCommands } from '../../src/worker/dist/worker/infrastructure/features/markdown-contract.js';
import { releaseMarkdown } from '../../src/worker/dist/worker/application/release-markdown.js';
import { workerCommands } from '../../scripts/runtime/portable/worker-commands.mjs';

const note = `---
schema: worker.request/v1
id: request-one
title: Deliver an observable release
intent: submit
mode: patch
paths: [source.txt]
priority: low
---
## Goal
Implement the approved change.
## Acceptance criteria
- Source value is two.
`;
const release = action => `release:
  command_id: release-one
  action: ${action}
  run_id: run-one
  request_revision: 1
  candidate_commit: ${'a'.repeat(40)}
`;
const withRelease = fields => note.replace('priority: low', 'priority: low\n' + fields);
test('canonical Markdown routes exact candidate release decisions without changing semantic request input', () => {
  const source = parseFeature(note), base = featureInput(source, 'claude-cli');
  for (const action of ['merge_candidate', 'build_release', 'publish_release', 'reconcile_release', 'confirm_release_stopped']) {
    const extras = action === 'publish_release' ? '  tag: v1.0.0\n' : action === 'reconcile_release' ? '  operation_id: prior-build\n' : action === 'confirm_release_stopped' ? '  operation_id: prior-build\n  note: I inspected and stopped the process.\n' : '';
    const parsed = parseFeature(withRelease(release(action) + extras)), commands = markdownCommands(parsed), input = featureInput(parsed, 'claude-cli');
    assert.equal(commands.length, 1); assert.equal(commands[0].action, action); assert.equal(commands[0].candidateCommit, 'a'.repeat(40));
    assert.deepEqual(featureRequestContext(parsed.data, input), featureRequestContext(source.data, base));
  }
  assert.throws(() => markdownCommands(parseFeature(withRelease(release('publish_release') + '  tag: ../escape\n'))));
  assert.throws(() => markdownCommands(parseFeature(withRelease(release('confirm_release_stopped') + '  operation_id: prior-build\n'))));
});
test('release Markdown exposes observed receipts while incomplete stages remain unconfirmed', () => {
  const pending = releaseMarkdown({ operations: [{ operationId: 'build-one', action: 'build', status: 'unknown', detail: 'Inspect the process before retry.' }] });
  assert.match(pending, /Merged commit: not confirmed/); assert.match(pending, /Release publication: not confirmed/); assert.match(pending, /unknown/);
  const merged = releaseMarkdown({ operations: [], merge: { pullRequest: 17, headCommit: 'a'.repeat(40), mergeCommit: 'b'.repeat(40), url: 'https://github.com/team/project/pull/17', mergedAt: '2026-10-25T00:00:00Z' } });
  assert.match(merged, new RegExp('Merged commit: ' + 'b'.repeat(40))); assert.match(merged, /Build: not confirmed/);
});
test('portable CLI exposes project and exact candidate release actions through the canonical APIs', () => {
  const catalog = workerCommands({ 'provider check': {}, 'settings set': {}, 'definition preview': {}, 'definition import': {}, 'interaction resume': {} });
  assert.equal(catalog['projects list'].path, '/api/managed-projects');
  assert.equal(catalog['projects register'].body, true);
  assert.equal(catalog['request release'].action, 'release');
  for (const name of ['merge', 'build-release', 'publish-release', 'reconcile-release', 'confirm-release-stopped']) {
    assert.equal(catalog['request ' + name].path, '/api/requests');
    assert.deepEqual(catalog['request ' + name].required, ['id', 'if-match', 'key']);
  }
});
