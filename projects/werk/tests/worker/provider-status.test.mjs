import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProviderStatusChecks } from '../../src/worker/dist/worker/infrastructure/provider-status.js';
const provider = (id, extra = {}) => ({ id, executable: '', model: '', apiKey: '', ...extra });
async function executable(t, body) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-auth-status-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'provider'); await writeFile(path, '#!/usr/bin/env node\n' + body, { mode: 0o700 }); return path;
}
test('API setup checks distinguish configured credentials from verified provider access without making requests', async () => {
  const checks = new ProviderStatusChecks();
  const empty = await checks.check(provider('openai-api')); assert.equal(empty.configured, false); assert.equal(empty.available, false); assert.equal(empty.authentication, 'not-verified');
  const ready = await checks.check(provider('openai-api', { apiKey: 'secret-not-for-response', model: 'example' }));
  assert.equal(ready.configured, true); assert.equal(ready.available, true); assert.equal(ready.authentication, 'not-verified'); assert.doesNotMatch(JSON.stringify(ready), /secret-not-for-response/);
});
test('provider checks explain missing executable or unsupported platform', async () => {
  const checks = new ProviderStatusChecks();
  const empty = await checks.check(provider('codex-cli')); assert.equal(empty.available, false); assert.equal(empty.authentication, 'unavailable');
  const missing = await checks.check(provider('codex-cli', { executable: '/does-not-exist-provider' })); assert.equal(missing.configured, true); assert.equal(missing.available, false);
});
test('read-only CLI status checks report login, redact diagnostics and share concurrent work', { skip: process.platform === 'win32' }, async t => {
  const path = await executable(t, `const fs = require('node:fs'); fs.appendFileSync(__filename + '.calls', 'x'); if (process.argv.slice(2).join(' ') !== 'login status') process.exit(3); console.error('Logged in using ChatGPT secret-private-account');`);
  const checks = new ProviderStatusChecks(), connection = provider('codex-cli', { executable: path });
  const results = await Promise.all([checks.check(connection), checks.check(connection), checks.check(connection)]);
  assert.equal(results[0].authentication, 'authenticated'); assert.equal(results[0].available, true); assert.doesNotMatch(JSON.stringify(results), /secret-private-account/);
  await checks.check(connection); assert.equal(await readFile(path + '.calls', 'utf8'), 'x');
  const claude = await executable(t, `if (process.argv.slice(2).join(' ') !== 'auth status') process.exit(3); console.log(JSON.stringify({loggedIn: true, email: 'private@example.com', authMethod: 'oauth_token'}));`);
  const status = await checks.check(provider('claude-cli', { executable: claude })); assert.equal(status.authentication, 'authenticated'); assert.doesNotMatch(JSON.stringify(status), /private@example|oauth_token/);
});
test('signed-out, malformed and excessive CLI output never becomes authenticated or exposes raw output', { skip: process.platform === 'win32' }, async t => {
  const signedOut = await executable(t, `console.log(JSON.stringify({loggedIn: false, error:'secret'})); process.exitCode = 1;`);
  const checks = new ProviderStatusChecks(); assert.equal((await checks.check(provider('claude-cli', { executable: signedOut }))).authentication, 'signed-out');
  const bad = await executable(t, `console.log('private broken status');`);
  const unknown = await checks.check(provider('claude-cli', { executable: bad })); assert.equal(unknown.authentication, 'unknown'); assert.doesNotMatch(JSON.stringify(unknown), /private broken/);
  const huge = await executable(t, `console.log('secret'.repeat(20_000)); setInterval(() => {}, 1000);`);
  assert.equal((await checks.check(provider('codex-cli', { executable: huge }))).authentication, 'unknown');
});

test('hanging status command times out and does not leak provider output', { skip: process.platform === 'win32' }, async t => {
  const hung = await executable(t, `console.log('private-account'); setInterval(() => {}, 1000);`);
  const started = Date.now(); const status = await new ProviderStatusChecks().check(provider('codex-cli', { executable: hung }));
  assert.equal(status.authentication, 'unknown'); assert.ok(Date.now() - started < 10_000); assert.doesNotMatch(JSON.stringify(status), /private-account/);
});

test('Codex negative status wins even with exit zero; changed configuration waits for a fresh probe', { skip: process.platform === 'win32' }, async t => {
  const old = await executable(t, `setTimeout(() => console.log('Not logged in'), 80);`);
  const fresh = await executable(t, `console.log('Logged in using ChatGPT');`);
  const checks = new ProviderStatusChecks();
  const first = checks.check(provider('codex-cli', { executable: old }));
  const second = checks.check(provider('codex-cli', { executable: fresh }));
  assert.equal((await first).authentication, 'signed-out');
  assert.equal((await second).authentication, 'authenticated');
});
