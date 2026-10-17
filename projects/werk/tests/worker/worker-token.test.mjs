import { testErrorCode, testErrorMessage } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, symlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWebviewToken } from '../../src/worker/dist/worker/infrastructure/webview-token.js';
import { runWorker } from '../../src/worker/dist/worker/runner.js';
import { configuration } from '../../src/worker/dist/worker/config.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-access-token-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'webview-token') };
}

test('omitted local access configuration creates one private token and preserves it across restart', async t => {
  const f = await fixture(t), token = await loadWebviewToken(f.directory);
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(f.path, 'utf8'), token + '\n');
  const before = await stat(f.path);
  if (process.platform !== 'win32') assert.equal(before.mode & 0o777, 0o600);
  assert.equal(await loadWebviewToken(f.directory), token);
  assert.equal(await loadWebviewToken(f.directory, token), token);
  assert.equal((await stat(f.path)).mtimeMs, before.mtimeMs, 'an unchanged token is never rewritten');
});

test('invalid explicit access tokens reject before creating or replacing token state and hide supplied values', async t => {
  const f = await fixture(t), stored = 'a'.repeat(64);
  for (const invalid of ['', 'PRIVATE_INVALID_TOKEN', 'A'.repeat(64), 'a'.repeat(63), stored + '\n', 42]) {
    // @ts-expect-error Deliberately non-string token verifies runtime validation.
    await assert.rejects(loadWebviewToken(f.directory, invalid), error => testErrorCode(error) === 'invalid_input' && !testErrorMessage(error).includes('PRIVATE_INVALID_TOKEN'));
    await assert.rejects(lstat(f.path), { code: 'ENOENT' });
  }
  await writeFile(f.path, stored + '\n');
  await assert.rejects(loadWebviewToken(f.directory, 'PRIVATE_INVALID_TOKEN'), error => testErrorCode(error) === 'invalid_input');
  assert.equal(await readFile(f.path, 'utf8'), stored + '\n');
});

test('explicit rotation preserves token file bounds and regular-file checks', async t => {
  const f = await fixture(t), replacement = 'b'.repeat(64);
  for (const saved of ['invalid stored token', 'a'.repeat(129)]) {
    await writeFile(f.path, saved);
    await assert.rejects(loadWebviewToken(f.directory, replacement), /Invalid worker webview token|exceeds 128 bytes/);
    assert.equal(await readFile(f.path, 'utf8'), saved);
  }
  if (process.platform !== 'win32') {
    await rm(f.path);
    const external = join(f.directory, 'external-token');
    await writeFile(external, 'a'.repeat(64) + '\n');
    await symlink(external, f.path);
    await assert.rejects(loadWebviewToken(f.directory, replacement), /regular file/);
    assert.equal(await readFile(external, 'utf8'), 'a'.repeat(64) + '\n');
  }
});

test('worker startup config rotates private access, invalidates old access, and persists new access when omitted', { timeout: 15000 }, async t => {
  const f = await fixture(t), base = { ...await configuration({}), stateDir: f.directory, enrollmentToken: '', statusHost: '127.0.0.1', statusPort: 0 };
  const original = 'a'.repeat(64), replacement = 'b'.repeat(64);
  for (const [configured, active, rejected] of [[original, original, replacement], [replacement, replacement, original], [undefined, replacement, original]]) {
    const stop = new AbortController();
    await runWorker({ ...base, webviewToken: configured }, stop.signal, { ready: async address => {
      try {
        const endpoint = 'http://127.0.0.1:' + address.port;
        const privateView = await fetch(endpoint + '/api/sessions', { headers: { Authorization: 'Bearer ' + active } });
        assert.equal(privateView.status, 200);
        assert.equal((await fetch(endpoint + '/api/sessions', { headers: { Authorization: 'Bearer ' + rejected } })).status, 401);
        const publicStatus = await (await fetch(endpoint + '/status')).text();
        const environment = await (await fetch(endpoint + '/api/environment', { headers: { Authorization: 'Bearer ' + active } })).text();
        for (const value of [publicStatus, environment]) {
          assert.ok(!value.includes(original) && !value.includes(replacement));
          assert.ok(!value.includes('webviewToken'));
        }
        assert.equal((await readFile(f.path, 'utf8')).trim(), active);
        if (process.platform !== 'win32') assert.equal((await stat(f.path)).mode & 0o777, 0o600);
      } finally { stop.abort(); }
    } });
    await assert.rejects(lstat(join(f.directory, 'worker.lock')), { code: 'ENOENT' });
  }
});
