import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { initializeFeatureAuthoring } from '../../src/worker/dist/worker/infrastructure/feature-authoring.js';

async function project(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-authoring-provider-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('authoring setup pins its selected provider only in newly created templates', async t => {
  const directory = await project(t), script = '// fixture authoring script\n';
  const created = await initializeFeatureAuthoring(directory, { script, provider: 'claude-cli', featuresDirectory: 'team/requests' });
  const path = join(directory, created.workflow.template), initial = await readFile(path, 'utf8');
  assert.equal(parse(initial.split('---')[1]).provider, 'claude-cli');
  assert.equal(created.warnings.length, 0);
  const repeated = await initializeFeatureAuthoring(directory, { script, provider: 'codex-cli' });
  assert.equal(await readFile(path, 'utf8'), initial, 'An existing committed template remains team-owned');
  assert.ok(repeated.warnings.some(item => item.code === 'template_provider_mismatch'));
});

test('invalid provider selection fails before installing any authoring files', async t => {
  const directory = await project(t);
  await assert.rejects(initializeFeatureAuthoring(directory, { script: '// fixture\n', provider: 'unknown' }), /supported feature provider/);
  assert.deepEqual(await readdir(directory), []);
});
