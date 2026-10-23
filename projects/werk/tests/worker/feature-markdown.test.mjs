import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeature, featureInput, renderFeature, deliveryFeatureTemplate } from '../../src/worker/dist/worker/infrastructure/features/document.js';
import { markdownCommands, authorBody } from '../../src/worker/dist/worker/infrastructure/features/markdown-contract.js';
import { featureInputHash } from '../../src/worker/dist/worker/application/feature-markdown.js';
const request = (extra = '', body = '## Outcome\n\nExport records.\n\n## Acceptance criteria\n\n- AC-01: Include every filtered record.\n\n## Answers\n') => `---\nschema: worker.request/v1\nid: FR-0042\ntitle: Export records\nintent: submit\npaths: [src/]\n${extra}---\n${body}`;
const input = value => featureInput(parseFeature(value), 'claude-cli');
test('versioned Markdown validates stable identity, explicit intent, profiles, dependencies and priorities', () => {
  assert.equal(parseFeature(deliveryFeatureTemplate).data.intent, 'draft');
  const value = input(request('priority: urgent\nquality_profile: defect\ndepends_on: [FR-0041]\n'));
  assert.equal(value.priority, 3); assert.equal(value.qualityProfile, 'defect'); assert.deepEqual(value.dependsOn, ['FR-0041']);
  assert.deepEqual(value.criteria, ['AC-01: Include every filtered record.']); assert.ok(value.sectionNames.includes('Answers'));
  assert.throws(() => input(request().replace('intent: submit\n', '')), /explicit intent/);
  assert.throws(() => input(request('depends_on: [FR-0042]\n')), /other request IDs/);
  assert.throws(() => input(request('priority: unknown\n')), /priority/);
  assert.throws(() => input(request('', '<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n')), /merge-conflict/);
});
test('semantic revisions exclude status region, priority, command identity and cosmetic blank lines', () => {
  const base = request(), first = input(base);
  const projected = renderFeature(parseFeature(base), 'FR-0042', 'in_progress', { semanticRevision: 1 });
  assert.equal(featureInputHash(first), featureInputHash(input(projected)));
  assert.equal(featureInputHash(first), featureInputHash(input(base.replace('intent: submit', 'intent: submit\npriority: high'))));
  assert.equal(featureInputHash(first), featureInputHash(input(base.replaceAll('\n\n', '\n\n\n').replaceAll('\n', '\r\n'))));
  const command = 'control:\n  command_id: CMD-1\n  action: reopen\n';
  assert.equal(featureInputHash(first), featureInputHash(input(request(command))));
  assert.notEqual(featureInputHash(first), featureInputHash(input(request('', first.message + '\n\n### Q-01\nExclude archived records.'))));
  assert.notEqual(featureInputHash(first), featureInputHash(input(base.replace('every filtered', 'only active'))));
});
test('review feedback changes input while acceptance metadata cannot fabricate worker evidence', () => {
  const commit = 'a'.repeat(40), review = `review:\n  command_id: CMD-review\n  decision: request_changes\n  request_revision: 1\n  candidate_commit: ${commit}\n  feedback: Preserve quoted commas.\n`;
  assert.match(input(request(review)).message, /Preserve quoted commas/);
  const parsed = parseFeature(request(review)); const command = markdownCommands(parsed)[0];
  assert.equal(command.action, 'request_changes'); assert.equal(command.requestRevision, 1);
  const acceptance = review.replace('request_changes', 'accept').replace('  feedback: Preserve quoted commas.\n', '  human_checks: []\n');
  assert.equal(featureInputHash(input(request())), featureInputHash(input(request(acceptance))));
  const output = renderFeature(parseFeature(request('', '## Outcome\n\nAuthor prose.\n\n<!-- worker:begin -->\nStatus: done\n<!-- worker:end -->\n')), 'FR-0042', 'in_review', {});
  assert.match(output, /Status: in_review/); assert.doesNotMatch(output, /Status: done/); assert.match(authorBody(parseFeature(output).body), /Author prose/);
  assert.throws(() => input(request('', '<!-- worker:begin -->\nBroken region')), /complete worker-managed/);
  assert.throws(() => input(request(acceptance.replace('  human_checks: []', '  human_checks: [{criterion_id: AC-01, outcome: pass}]'))), /supporting note/);
});


test('legacy IDs remain lowercase while canonical IDs preserve case without collisions', () => {
  const legacy = '---\nschemaVersion: 1\nid: BAD\ntitle: Legacy request\nstatus: draft\n---\nDescribe the result.\n';
  assert.throws(() => parseFeature(legacy), /Feature id/);
  assert.equal(parseFeature(legacy.replace('id: BAD', 'id: good')).data.id, 'good');
  assert.equal(parseFeature(request()).data.id, 'FR-0042');
});

test('confirm_stopped records an explicit operator statement scoped to the original run and revision', () => {
  const control = 'control:\n  command_id: CMD-stopped\n  action: confirm_stopped\n  run_id: RUN-0042\n  request_revision: 2\n  note: I inspected the prior processes and stopped them.\n';
  const command = markdownCommands(parseFeature(request(control)))[0];
  assert.deepEqual(command, { commandId: 'CMD-stopped', action: 'confirm_stopped', runId: 'RUN-0042', requestRevision: 2, feedback: 'I inspected the prior processes and stopped them.' });
  for (const line of ['  run_id: RUN-0042\n', '  request_revision: 2\n', '  note: I inspected the prior processes and stopped them.\n']) {
    assert.throws(() => input(request(control.replace(line, ''))), /run_id|request_revision|note/);
  }
  assert.throws(() => input(request(control.replace('I inspected the prior processes and stopped them.', '"   "'))), /note/);
});


test('canonical worker projection exposes exact run control targets and labels retained checkpoints honestly', () => {
  const commit = 'c'.repeat(40);
  const rendered = renderFeature(parseFeature(request()), 'FR-0042', 'needs_rework', { result: '_results/FR-0042.md', gates: { phase: 'needs_rework', inputRevision: 2, link: '_gates/FR-0042/request.md', delivery: { runId: 'RUN-0042', status: 'outcome_unknown', phase: 'implementing', reason: 'Inspect the prior processes.', waitingFor: 'Operator confirmation', controls: ['confirm_stopped'], checkpoint: { branch: 'werk/delivery/retained', candidateCommit: commit } } } });
  for (const text of ['Run ID: RUN-0042', 'Accepted request revision: 2', 'Execution: outcome_unknown', 'confirm_stopped', 'Inspectable checkpoint (not a verification pass)', commit, '[Earlier result]']) assert.ok(rendered.includes(text), text);
  assert.doesNotMatch(rendered, /\[Open result\]/);
});
