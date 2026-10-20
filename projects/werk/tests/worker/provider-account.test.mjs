import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProviderAccountChecks, parseProviderAccount } from '../../src/worker/dist/worker/infrastructure/provider-account.js';
const provider = (id, extra = {}) => ({ id, executable: '', model: '', apiKey: '', ...extra });
async function executable(t, body) { const directory = await mkdtemp(join(tmpdir(), 'werk-account-test-')); t.after(() => rm(directory, { recursive: true, force: true })); const path = join(directory, 'provider'); await writeFile(path, '#!/usr/bin/env node\n' + body, { mode: 0o700 }); return path; }
test('Claude account parser exposes only bounded identity fields actually reported by a signed-in CLI', () => {
  const result = parseProviderAccount('claude-cli', 0, JSON.stringify({ loggedIn: true, email: 'member@example.com', accountName: 'Example member', orgName: 'Example team', subscriptionType: 'max', authMethod: 'claude.ai', apiKey: 'secret-private-key', accessToken: 'private-token', nested: { refreshToken: 'private-refresh' } }), 'private-diagnostic');
  assert.equal(result.signedIn, true); assert.equal(result.email, 'member@example.com'); assert.equal(result.account, 'Example member'); assert.equal(result.organization, 'Example team'); assert.equal(result.subscription, 'max'); assert.equal(result.authMethod, 'claude.ai');
  assert.doesNotMatch(JSON.stringify(result), /secret-private|private-token|private-refresh|private-diagnostic/);
});
test('malformed, signed-out and nonzero Claude status cannot expose stale account identity', () => {
  for (const [code, output, signedIn] of /** @type {const} */ ([[1, JSON.stringify({ loggedIn: false, email: 'old@example.com', subscriptionType: 'max' }), false], [1, JSON.stringify({ loggedIn: true, email: 'old@example.com' }), 'unknown'], [0, '{private-malformed', 'unknown'], [0, '[]', 'unknown'], [0, JSON.stringify({ loggedIn: 'true', email: 'old@example.com' }), 'unknown']])) {
    const result = parseProviderAccount('claude-cli', code, output); assert.equal(result.signedIn, signedIn); assert.equal(result.email, null); assert.equal(result.subscription, null); assert.doesNotMatch(JSON.stringify(result), /old@example|private-malformed/);
  }
});
test('untrusted status values with controls, credential patterns, excessive lengths or unknown methods are omitted', () => {
  const result = parseProviderAccount('claude-cli', 0, JSON.stringify({ loggedIn: true, email: 'not-an-email', accountName: 'Bearer private-secret', orgName: 'bad\u202ename', subscriptionType: 'x'.repeat(1000), authMethod: 'private-auth-value' }));
  assert.equal(result.signedIn, true); for (const key of ['email', 'account', 'organization', 'subscription', 'authMethod']) assert.equal(result[key], null);
  assert.equal(parseProviderAccount('claude-cli', 0, JSON.stringify({ loggedIn: true, accountName: 'sk-ant-abcdefghijklmnopqrstuvwxyz' })).account, null);
});
test('Codex reports fixed authentication labels without parsing account identity from free-form diagnostics', () => {
  const chatgpt = parseProviderAccount('codex-cli', 0, '', 'Logged in using ChatGPT private@example.com');
  assert.equal(chatgpt.signedIn, true); assert.equal(chatgpt.authMethod, 'ChatGPT'); assert.equal(chatgpt.email, null); assert.equal(chatgpt.subscription, null); assert.doesNotMatch(JSON.stringify(chatgpt), /private@example/);
  const key = parseProviderAccount('codex-cli', 0, '', 'Logged in using an API key - sk-private-secret'); assert.equal(key.authMethod, 'API key'); assert.doesNotMatch(JSON.stringify(key), /sk-private/);
  assert.equal(parseProviderAccount('codex-cli', 0, 'Logged in using ChatGPT\nNot logged in').signedIn, false);
});
test('API and unconfigured CLI account checks make no provider request and reveal no saved secrets', async t => {
  const checks = new ProviderAccountChecks(); t.after(() => checks.close());
  const api = await checks.check(provider('openai-api', { apiKey: 'private-api-secret', model: 'configured-model' })); assert.equal(api.signedIn, 'unknown'); assert.match(api.message, /No provider request/); assert.doesNotMatch(JSON.stringify(api), /private-api-secret/);
  assert.equal((await checks.check(provider('claude-cli'))).signedIn, 'unknown');
});
test('account probes use fixed read-only arguments, ignore stderr diagnostics and coalesce repeated requests', { skip: process.platform === 'win32' }, async t => {
  const cli = await executable(t, `const fs=require('node:fs');fs.appendFileSync(__filename+'.calls',JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv.slice(2).join(' ')!=='auth status')process.exit(9);console.error('private-startup-diagnostic');console.log(JSON.stringify({loggedIn:true,email:'member@example.com',orgName:'Example team',subscriptionType:'pro',accessToken:'private-oauth-token'}));`);
  const checks = new ProviderAccountChecks(); t.after(() => checks.close());
  const results = await Promise.all(Array.from({ length: 3 }, () => checks.check(provider('claude-cli', { executable: cli }))));
  assert.equal(results[0].email, 'member@example.com'); assert.equal(results[0].subscription, 'pro'); assert.doesNotMatch(JSON.stringify(results), /private-startup|private-oauth/);
  results[0].email = 'mutated@example.com'; assert.equal((await checks.check(provider('claude-cli', { executable: cli }))).email, 'member@example.com');
  assert.equal((await readFile(cli + '.calls', 'utf8')).trim(), '["auth","status"]');
});
test('unsupported status and excessive stdout or stderr remain unknown without diagnostics', { skip: process.platform === 'win32' }, async t => {
  const checks = new ProviderAccountChecks(); t.after(() => checks.close());
  for (const body of ["console.error('unknown option --json private-diagnostic');process.exit(2)", "console.log('private'.repeat(5000));setInterval(()=>{},1000)", "console.error('private'.repeat(5000));console.log(JSON.stringify({loggedIn:true,email:'hidden@example.com'}));setInterval(()=>{},1000)"]) {
    const cli = await executable(t, body); const value = await checks.check(provider('claude-cli', { executable: cli })); assert.equal(value.signedIn, 'unknown'); assert.doesNotMatch(JSON.stringify(value), /private-diagnostic|hidden@example/);
  }
});
test('shutdown cancels an account probe and prevents later CLI launches', { skip: process.platform === 'win32' }, async t => {
  const cli = await executable(t, "setInterval(()=>{},1000)"); const checks = new ProviderAccountChecks();
  const operation = checks.check(provider('claude-cli', { executable: cli })); await new Promise(resolve => setTimeout(resolve, 50)); const started = Date.now(); await checks.close();
  assert.equal((await operation).signedIn, 'unknown'); assert.ok(Date.now() - started < 3000);
  assert.match((await checks.check(provider('claude-cli', { executable: cli }))).message, /stopping/);
});

test('a hanging account status command reaches its bounded deadline without exposing output', { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  const cli = await executable(t, "console.log('private-account-diagnostic');setInterval(()=>{},1000)"); const checks = new ProviderAccountChecks(); t.after(() => checks.close());
  const started = Date.now(); const value = await checks.check(provider('claude-cli', { executable: cli }));
  assert.equal(value.signedIn, 'unknown'); assert.ok(Date.now() - started < 10000); assert.doesNotMatch(JSON.stringify(value), /private-account-diagnostic/);
});
