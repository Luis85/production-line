import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultFeatureWorkflow } from '../../src/worker/dist/worker/application/feature-workflow.js';
import { initializeFeatureAuthoring, planFeatureAuthoring } from '../../src/worker/dist/worker/infrastructure/feature-authoring.js';
import { runFeatureAuthoring } from '../../src/worker/dist/worker/authoring/cli.js';

const script = '// Managed authoring test fixture\n';
async function fixture(t, prompts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'werk-definition-authoring-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.werk'));
  const config = { ...defaultFeatureWorkflow(), ...prompts };
  await writeFile(join(root, '.werk/feature-workflow.json'), JSON.stringify(config));
  return { root, config, setup: () => initializeFeatureAuthoring(root, { script }), command: args => runFeatureAuthoring(args, root) };
}
const request = `---
schemaVersion: 1
id: fr-orders
status: draft
templateId: feature-request-v1
title: Export orders
mode: patch
provider: codex-cli
paths:
  - src/orders.ts
---
# Goal
Allow the team to export orders as CSV.
## Context
Preserve existing order retrieval behavior.
## Acceptance criteria
- Exported orders include the existing visible fields.
## Verification plan
Run the order export tests and check a generated CSV file.
`;

test('setup leaves definitions disabled unless the team explicitly configures a path', async t => {
  const f = await fixture(t), result = await f.setup();
  assert.equal(result.workflow.readyPrompt, undefined);
  assert.equal(result.workflow.donePrompt, undefined);
  assert.ok(result.files.every(file => !/prompt|definition/i.test(file.path)));
  assert.deepEqual(JSON.parse(await readFile(join(f.root, '.werk/feature-workflow.json'), 'utf8')), f.config);
});

test('setup previews configured prompt files and preserves edited team definitions on repetition', async t => {
  const f = await fixture(t, { readyPrompt: 'team/ready.md', donePrompt: 'team/done.txt' });
  const plan = await planFeatureAuthoring(f.root, { script });
  assert.ok(plan.files.some(file => file.path === f.config.readyPrompt && file.status === 'missing'));
  assert.deepEqual(await readdir(f.root), ['.werk'], 'planning does not write prompt folders or the authoring kit');
  await f.setup();
  assert.match(await readFile(join(f.root, f.config.readyPrompt), 'utf8'), /# Definition of Ready/);
  assert.match(await readFile(join(f.root, f.config.donePrompt), 'utf8'), /# Definition of Done/);
  const customized = 'Require an accessibility verification plan before implementation.\n';
  await writeFile(join(f.root, f.config.readyPrompt), customized);
  await f.setup();
  assert.equal(await readFile(join(f.root, f.config.readyPrompt), 'utf8'), customized);
  const skill = await readFile(join(f.root, '.agents/skills/create-feature-request/SKILL.md'), 'utf8');
  assert.match(skill, /readyPrompt and donePrompt/);
  assert.match(skill, /supplements the deterministic JSON checks/);
});

test('an invalid existing configured prompt prevents setup before any kit files are written', async t => {
  const f = await fixture(t, { readyPrompt: 'ready.md' });
  await writeFile(join(f.root, f.config.readyPrompt), ' \n');
  await assert.rejects(f.setup(), /nonempty UTF-8 text/);
  assert.deepEqual((await readdir(f.root)).sort(), ['.werk', 'ready.md']);
  assert.deepEqual(await readdir(join(f.root, '.werk')), ['feature-workflow.json']);
});

test('offline validation includes both prompt files in workflow revisions and blocks missing or invalid definitions', async t => {
  const f = await fixture(t, { readyPrompt: 'ready.md', donePrompt: 'done.txt' });
  await f.setup();
  await writeFile(join(f.root, 'features/orders.md'), request);
  const before = await f.command(['validate', '--file', 'features/orders.md']);
  assert.ok('valid' in before && 'workflowRevision' in before && 'revision' in before);
  assert.equal(before.valid, true);
  await writeFile(join(f.root, f.config.readyPrompt), 'Confirm an explicit rollback plan.\n');
  const changedReady = await f.command(['validate', '--file', 'features/orders.md']);
  assert.ok('workflowRevision' in changedReady);
  assert.notEqual(changedReady.workflowRevision, before.workflowRevision);
  await writeFile(join(f.root, f.config.donePrompt), 'Report rollback verification evidence.\n');
  const changedDone = await f.command(['validate', '--file', 'features/orders.md']);
  assert.ok('workflowRevision' in changedDone && 'revision' in changedDone);
  assert.notEqual(changedDone.workflowRevision, changedReady.workflowRevision);
  assert.equal(changedDone.revision, before.revision, 'definition changes do not rewrite the team request');
  await writeFile(join(f.root, f.config.donePrompt), ' \n');
  await assert.rejects(f.command(['ready', '--file', 'features/orders.md', '--if-match', before.revision]), /nonempty UTF-8 text/);
  assert.equal(await readFile(join(f.root, 'features/orders.md'), 'utf8'), request);
  await rm(join(f.root, f.config.donePrompt));
  await assert.rejects(f.command(['validate', '--file', 'features/orders.md']), /Configured definition prompt is missing: done.txt/);
  await assert.rejects(f.command(['create', '--name', 'another.md', '--title', 'Another request']), /Configured definition prompt is missing/);
  assert.deepEqual((await readdir(join(f.root, 'features'))).sort(), ['_templates', 'orders.md']);
});


test('offline authoring queues incomplete requests for an opted-in Ready Check and snapshots its file revision', async t => {
  const f = await fixture(t, { readyReviewPrompt: 'team/ready-check.md' });
  await f.setup();
  assert.match(await readFile(join(f.root, 'team/ready-check.md'), 'utf8'), /# Feature Request Ready Check/);
  const created = await f.command(['create', '--name', 'clarify.md', '--title', 'Clarify export behavior']);
  assert.ok('path' in created);
  const before = await f.command(['validate', '--file', created.path]);
  assert.ok('valid' in before && 'revision' in before && 'workflowRevision' in before); assert.equal(before.valid, true);
  await writeFile(join(f.root, 'team/ready-check.md'), 'Ask about unverified product decisions.\n');
  const after = await f.command(['validate', '--file', created.path]); assert.ok('workflowRevision' in after);
  assert.notEqual(after.workflowRevision, before.workflowRevision);
  const queued = await f.command(['ready', '--file', created.path, '--if-match', before.revision]);
  assert.ok('status' in queued); assert.equal(queued.status, 'ready');
  await f.setup(); assert.equal(await readFile(join(f.root, 'team/ready-check.md'), 'utf8'), 'Ask about unverified product decisions.\n');
  await rm(join(f.root, 'team/ready-check.md'));
  await assert.rejects(f.command(['validate', '--file', created.path]), /Configured definition prompt is missing: team\/ready-check.md/);
  const legacy = await fixture(t); await legacy.setup();
  await legacy.command(['create', '--name', 'clarify.md', '--title', 'Clarify export behavior']);
  const blocked = await legacy.command(['validate', '--file', 'features/clarify.md']);
  assert.ok('valid' in blocked); assert.equal(blocked.valid, false, 'Omitted Ready Check preserves strict offline readiness');
});
