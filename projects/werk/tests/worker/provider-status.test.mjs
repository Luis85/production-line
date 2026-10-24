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
  const path = await executable(t, `const fs = require('node:fs'); fs.appendFileSync(__filename + '.calls', 'x'); if(process.argv.includes('--version')){console.log('codex-cli 0.1.0');process.exit(0)} if (process.argv.slice(2).join(' ') !== 'login status') process.exit(3); console.error('Logged in using ChatGPT secret-private-account');`);
  const checks = new ProviderStatusChecks(), connection = provider('codex-cli', { executable: path });
  const results = await Promise.all([checks.check(connection), checks.check(connection), checks.check(connection)]);
  assert.equal(results[0].authentication, 'authenticated'); assert.equal(results[0].available, true); assert.doesNotMatch(JSON.stringify(results), /secret-private-account/);
  await checks.check(connection); assert.equal(await readFile(path + '.calls', 'utf8'), 'xx'); assert.equal(results[0].version, '0.1.0');
  const claude = await executable(t, `if(process.argv.includes('--version')){console.log('2.1.257');process.exit(0)}console.error('private-startup-diagnostic'); if (process.argv.slice(2).join(' ') !== 'auth status') process.exit(3); console.log(JSON.stringify({loggedIn: true, email: 'private@example.com', authMethod: 'oauth_token'}));`);
  const status = await checks.check(provider('claude-cli', { executable: claude })); assert.equal(status.authentication, 'authenticated'); assert.doesNotMatch(JSON.stringify(status), /private@example|oauth_token|private-startup-diagnostic/);
});
test('signed-out, malformed and excessive CLI output never becomes authenticated or exposes raw output', { skip: process.platform === 'win32' }, async t => {
  const signedOut = await executable(t, `if(process.argv.includes('--version')){console.log('2.1.257');process.exit(0)}console.log(JSON.stringify({loggedIn: false, error:'secret'})); process.exitCode = 1;`);
  const checks = new ProviderStatusChecks(); assert.equal((await checks.check(provider('claude-cli', { executable: signedOut }))).authentication, 'signed-out');
  const bad = await executable(t, `console.log('private broken status');`);
  const unknown = await checks.check(provider('claude-cli', { executable: bad })); assert.equal(unknown.authentication, 'unknown'); assert.doesNotMatch(JSON.stringify(unknown), /private broken/);
  const huge = await executable(t, `console.log('secret'.repeat(20_000)); setInterval(() => {}, 1000);`);
  assert.equal((await checks.check(provider('codex-cli', { executable: huge }))).authentication, 'unknown');
  const hugeDiagnostics = await executable(t, `console.error('private-diagnostic'.repeat(20_000)); console.log(JSON.stringify({loggedIn:true})); setInterval(() => {}, 1000);`);
  const bounded = await checks.check(provider('claude-cli', { executable: hugeDiagnostics }));
  assert.equal(bounded.authentication, 'unknown'); assert.doesNotMatch(JSON.stringify(bounded), /private-diagnostic/);
});

test('hanging status command times out and does not leak provider output', { skip: process.platform === 'win32' }, async t => {
  const hung = await executable(t, `console.log('private-account'); setInterval(() => {}, 1000);`);
  const started = Date.now(); const status = await new ProviderStatusChecks({ timeoutMs: 500 }).check(provider('codex-cli', { executable: hung }));
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

test('Claude saved-connection preflight reports minimum version without a model request', { skip: process.platform === 'win32' }, async t => {
  for (const [version, compatibility] of [['2.1.247', 'unsupported'], ['2.1.256', 'unsupported'], ['2.1.257', 'minimum_met'], ['3.0.0', 'minimum_met']]) {
    const cli = await executable(t, `const args=process.argv.slice(2);if(args.join(' ')==='--version'){console.log(${JSON.stringify(version)}+' (Claude Code)')}else if(args.join(' ')==='auth status'){console.log(JSON.stringify({loggedIn:true,email:'private-account'}))}else{process.exit(99)}`);
    const result = await new ProviderStatusChecks().check(provider('claude-cli', { executable: cli }));
    assert.equal(result.version, version); assert.equal(result.minimumVersion, '2.1.257'); assert.equal(result.compatibility, compatibility);
    assert.equal(result.available, compatibility === 'minimum_met');
    assert.equal(result.authentication, compatibility === 'minimum_met' ? 'authenticated' : 'unknown');
    assert.doesNotMatch(JSON.stringify(result), /private-account/);
  }
});


test('status shutdown cancels an active probe and refuses later CLI launches', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const cli = await executable(t, "require('node:fs').writeFileSync(__filename+'.started',process.cwd());setInterval(()=>{},1000)");
  const checks = new ProviderStatusChecks(); t.after(() => checks.close());
  const pending = checks.check(provider('codex-cli', { executable: cli }));
  let directory;
  while (!directory) { t.signal.throwIfAborted(); directory = await readFile(cli + '.started', 'utf8').catch(() => null); if (!directory) await new Promise(resolve => setTimeout(resolve, 20)); }
  await checks.close();
  assert.equal((await pending).authentication, 'unknown');
  await assert.rejects(readFile(directory), { code: 'ENOENT' });
  assert.match((await checks.check(provider('codex-cli', { executable: cli }))).message, /stopping/);
});

// A fake probe replaces the CLI so cold-start behavior is checked without a real executable or real deadlines.
const fakeClaude = (authStatus, version = () => ({ exitCode: 0, stdout: Buffer.from('2.1.257'), stderr: Buffer.alloc(0) })) => {
  const calls = [];
  const probe = async (executable, kind, args, options) => {
    calls.push({ args: args.join(' '), timeoutMs: options.timeoutMs });
    if (args[0] === '--version') return version();
    return authStatus(calls.filter(call => call.args === 'auth status').length);
  };
  return { calls, probe };
};
const signedIn = { exitCode: 0, stdout: Buffer.from(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })), stderr: Buffer.alloc(0) };
const claudeConnection = () => provider('claude-cli', { executable: process.execPath });

test('Claude status check retries a failed auth probe once so a cold CLI start still authenticates', async () => {
  const { calls, probe } = fakeClaude(attempt => { if (attempt === 1) throw Error('timed out'); return signedIn; });
  const status = await new ProviderStatusChecks({ probe }).check(claudeConnection());
  assert.equal(status.authentication, 'authenticated'); assert.equal(status.available, true);
  assert.deepEqual(calls.map(call => call.args), ['--version', 'auth status', 'auth status']);
  assert.ok(calls.every(call => call.timeoutMs === 15000), 'every probe gets the 15 s cold-start deadline');
});

test('Claude status check retries the auth probe only once and never retries --version', async () => {
  const failing = fakeClaude(() => { throw Error('timed out'); });
  assert.equal((await new ProviderStatusChecks({ probe: failing.probe }).check(claudeConnection())).authentication, 'unknown');
  assert.deepEqual(failing.calls.map(call => call.args), ['--version', 'auth status', 'auth status']);
  const noVersion = fakeClaude(() => signedIn, () => { throw Error('timed out'); });
  assert.equal((await new ProviderStatusChecks({ probe: noVersion.probe }).check(claudeConnection())).authentication, 'unknown');
  assert.deepEqual(noVersion.calls.map(call => call.args), ['--version']);
});

test('Claude status check does not retry once the worker is stopping', async () => {
  let checks; const { calls, probe } = fakeClaude(() => { void checks.close(); throw Error('cancelled'); });
  checks = new ProviderStatusChecks({ probe });
  assert.equal((await checks.check(claudeConnection())).authentication, 'unknown');
  assert.deepEqual(calls.map(call => call.args), ['--version', 'auth status']);
});

test('concurrent Claude checks still share one probe sequence while a retry is in flight', async () => {
  const { calls, probe } = fakeClaude(attempt => { if (attempt === 1) throw Error('timed out'); return signedIn; });
  const checks = new ProviderStatusChecks({ probe }), connection = claudeConnection();
  const results = await Promise.all([checks.check(connection), checks.check(connection)]);
  assert.deepEqual(results.map(result => result.authentication), ['authenticated', 'authenticated']);
  assert.equal(calls.filter(call => call.args === 'auth status').length, 2);
});
