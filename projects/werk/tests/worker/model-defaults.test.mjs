import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { providerIds } from '../../src/worker/dist/worker/application/provider-contract.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-model-defaults-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = new WorkerSettings(directory); await settings.init();
  return { directory, settings, file: join(directory, 'workspace-settings.json') };
}

test('legacy settings gain Cursor and seed feature provider only once without replacing saved defaults', async t => {
  const f = await fixture(t), previous = JSON.parse(await readFile(f.file, 'utf8'));
  previous.providers = previous.providers.filter(item => item.id !== 'cursor-cli'); delete previous.defaultProvider;
  previous.providers.find(item => item.id === 'openai-api').model = 'saved-model';
  await writeFile(f.file, JSON.stringify(previous));
  const upgraded = new WorkerSettings(f.directory, '', '', '', undefined, 'anthropic-api'); await upgraded.init();
  assert.equal(upgraded.value.defaultProvider, 'anthropic-api');
  assert.deepEqual(upgraded.value.providers.map(item => item.id).sort(), [...providerIds].sort());
  assert.equal(upgraded.provider('openai-api').model, 'saved-model');
  await upgraded.update({ defaultProvider: 'claude-cli', expectedDefaultProvider: 'anthropic-api', provider: { id: 'claude-cli', model: 'chosen-model', effort: 'high' } });
  const reopened = new WorkerSettings(f.directory, '', '', '', undefined, 'codex-cli'); await reopened.init();
  assert.equal(reopened.publicView().defaultProvider, 'claude-cli');
  assert.equal(reopened.provider('claude-cli').effort, 'high');
  assert.equal(reopened.provider('claude-cli').model, 'chosen-model');
});

test('default updates reject stale clients and unsupported selections atomically while preserving private credentials', async t => {
  const { settings, file } = await fixture(t);
  await settings.update({ provider: { id: 'openai-api', apiKey: 'private-test-key', model: 'configured-model', effort: 'high' } });
  await settings.update({ defaultProvider: 'openai-api', expectedDefaultProvider: 'codex-cli' });
  const previous = await readFile(file, 'utf8');
  for (const patch of [
    { defaultProvider: 'claude-cli', expectedDefaultProvider: 'codex-cli' },
    { defaultProvider: 'unknown' }, { defaultProvider: null },
    { provider: { id: 'cursor-cli', effort: 'high' } },
    { provider: { id: 'claude-cli', effort: 'none' } },
    { provider: { id: 'openai-api', model: 'bad\nname' } },
  ]) { await assert.rejects(settings.update(patch)); assert.equal(await readFile(file, 'utf8'), previous); }
  const view = settings.publicView(); assert.equal(view.defaultProvider, 'openai-api');
  assert.equal(view.providers.find(item => item.id === 'openai-api')?.effort, 'high');
  assert.equal(JSON.stringify(view).includes('private-test-key'), false);
  assert.equal(settings.provider('openai-api').apiKey, 'private-test-key');
});
