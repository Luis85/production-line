import { testErrorCode } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { configuration } from '../../src/worker/dist/worker/config.js';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { validateRepositoryConfiguration } from '../../src/worker/dist/worker/application/repositories.js';

const item = { id: 'web-app', path: resolve('/projects/web-app') };
test('repository configuration normalizes multiple assignments without changing enrollment identity', async () => {
  const empty = await configuration({});
  assert.deepEqual(empty.repositories, { pollMs: 30000, items: [] });
  const options = { 'project-dir': resolve('/projects') };
  const first = await configuration(options, { repositories: { items: [{ id: 'web', path: 'web' }, { id: 'api', path: '../api', remote: 'upstream', branch: 'release/v2', watch: false }] } });
  assert.deepEqual(first.repositories, { pollMs: 30000, items: [{ id: 'web', path: resolve('/projects/web'), remote: 'origin', watch: true }, { id: 'api', path: resolve('/api'), remote: 'upstream', branch: 'release/v2', watch: false }] });
  const second = await configuration(options, { repositories: { items: [{ id: 'web', path: 'web', watch: false }] } });
  assert.equal(first.policy.configHash, second.policy.configHash);
  assert.equal(empty.policy.configHash, first.policy.configHash);
  // This is the registration policy shape before repository assignments existed.
  const legacy = { schemaVersion: 1, scheduler: { ...empty.policy, configHash: undefined, pollMs: empty.pollMs }, execution: { mode: 'mock', mockMs: empty.mockMs, timeoutMs: empty.timeoutMs }, profiles: empty.profiles, systemPrompt: empty.systemPrompt };
  assert.equal(empty.policy.configHash, createHash('sha256').update(JSON.stringify(legacy)).digest('hex'));
  await assert.rejects(configuration(options, { repositories: { items: [item, { id: 'duplicate', path: 'web-app/../web-app' }] } }), /paths must be unique/);
});

test('repository policy rejects malformed assignments, ambiguous identities and unsafe Git selectors', () => {
  for (const invalid of [null, [], { other: true }, { pollMs: null }, { pollMs: '1000' }, { pollMs: 999 }, { pollMs: 3600001 }, { pollMs: 1000.5 }, { items: null }, { items: {} }, { items: Array.from({ length: 65 }, (_, n) => ({ id: `repo-${n}`, path: resolve(`/repo-${n}`) })) }]) {
    assert.throws(() => validateRepositoryConfiguration(invalid), error => testErrorCode(error) === 'invalid_input', JSON.stringify(invalid));
  }
  for (const replacement of [{ id: 'bad/id' }, { path: 'relative' }, { path: '/a\nb' }, { remote: 'https://example.test/repo.git' }, { remote: '--upload-pack=bad' }, { remote: null }, { branch: '-main' }, { branch: 'heads/../main' }, { branch: 'topic.lock' }, { branch: 'main@{1}' }, { branch: 'two words' }, { watch: 'true' }, { watch: null }, { unsupported: true }]) {
    assert.throws(() => validateRepositoryConfiguration({ items: [{ ...item, ...replacement }] }), error => testErrorCode(error) === 'invalid_input', JSON.stringify(replacement));
  }
  assert.throws(() => validateRepositoryConfiguration({ items: [item, { ...item, path: resolve('/other') }] }), /ids must be unique/);
  assert.throws(() => validateRepositoryConfiguration({ items: [item, { ...item, id: 'other' }] }), /paths must be unique/);
  assert.deepEqual(validateRepositoryConfiguration({ items: [item] }).items[0], { ...item, remote: 'origin', watch: true });
});

test('repository assignments migrate old settings, persist replacements and remain detached from public snapshots', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-repository-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const initial = new WorkerSettings(directory); await initial.init();
  const file = join(directory, 'workspace-settings.json');
  const legacy = JSON.parse(await readFile(file, 'utf8')); delete legacy.repositories;
  await writeFile(file, JSON.stringify(legacy));
  const seed = validateRepositoryConfiguration({ items: [item] });
  const settings = new WorkerSettings(directory, '', '', '', seed); await settings.init();
  assert.deepEqual(settings.publicView().repositories, seed);
  const snapshot = settings.publicView(); snapshot.repositories.items[0].path = '/changed-public-snapshot';
  assert.equal(settings.value.repositories.items[0].path, item.path);
  await settings.update({ repositories: { pollMs: 15000, items: [{ id: 'api', path: resolve('/api'), branch: 'main', watch: false }] } });
  const saved = structuredClone(settings.value.repositories);
  const recovered = new WorkerSettings(directory, '', '', '', seed); await recovered.init();
  assert.deepEqual(recovered.value.repositories, saved);
  await assert.rejects(recovered.update({ repositories: { items: [{ id: 'bad', path: './relative' }] } }), /absolute/);
  await assert.rejects(recovered.update({ repositories: { items: [{ id: 'a', path: resolve('/api') }, { id: 'b', path: resolve('/api') + '/other/..' }] } }), /paths must be unique/);
  await assert.rejects(recovered.update({ repositories: { items: Array.from({ length: 20 }, (_, i) => ({ id: `large-${i}`, path: resolve('/' + 'a'.repeat(3900) + i) })) } }), /64 KiB/);
  assert.deepEqual(recovered.value.repositories, saved);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).repositories, saved);
  await recovered.update({ repositories: { items: [] } });
  assert.deepEqual(recovered.value.repositories, { pollMs: 30000, items: [] });
});

test('an invalid task worktree directory reports its own field while repository paths keep their message', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-worktree-field-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = new WorkerSettings(directory); await settings.init();
  await assert.rejects(settings.update({ repositories: { items: [], worktreeDirectory: 'C:werk-worktrees' } }), { code: 'invalid_input', message: 'Task worktree directory must be absolute on the worker machine.' });
  await assert.rejects(settings.update({ repositories: { items: [{ id: 'bad', path: './relative' }] } }), { code: 'invalid_input', message: 'Repository path must be absolute on the worker machine.' });
  await assert.rejects(settings.update({ repositories: { items: [{ id: 'bad', path: './relative' }], worktreeDirectory: 'C:werk-worktrees' } }), { code: 'invalid_input', message: 'Repository path must be absolute on the worker machine.' });
  assert.equal(settings.value.repositories.worktreeDirectory, undefined);
});
