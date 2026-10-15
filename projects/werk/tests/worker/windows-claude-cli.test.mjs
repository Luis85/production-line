import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { claudeArguments, modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { providerCommand, providerEnvironment, providerSpawnOptions } from '../../src/worker/dist/worker/infrastructure/codex-adapter.js';
import { ProviderStatusChecks } from '../../src/worker/dist/worker/infrastructure/provider-status.js';

const windows = { skip: process.platform !== 'win32' && 'Windows process and environment behavior' };
const posix = { skip: process.platform === 'win32' && 'POSIX shebang fixture' };
const connection = (id, extra = {}) => ({ id, executable: '', model: '', apiKey: '', ...extra });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const prompts = async () => (await readdir(tmpdir())).filter(name => name.startsWith('werk-claude-prompt-'));

test('Claude arguments keep every isolation flag and pass instructions only as a file', () => {
  const args = claudeArguments('claude-sonnet', '/private/system-prompt.md');
  for (const flag of ['--print', '--safe-mode', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--tools') + 1], ''); assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.deepEqual(args.slice(-2), ['--system-prompt-file', '/private/system-prompt.md']);
  assert.equal(args.includes('--system-prompt'), false);
  assert.equal(claudeArguments('', '/p').includes('--model'), false);
});

test('provider processes are hidden and only POSIX providers lead a process group', () => {
  assert.deepEqual(providerSpawnOptions(), { detached: process.platform !== 'win32', windowsHide: true });
});

test('Windows provider environment keeps the account profile but drops unrelated secrets', windows, t => {
  const previous = process.env.WERK_UNRELATED_SECRET; process.env.WERK_UNRELATED_SECRET = 'private';
  t.after(() => { if (previous === undefined) delete process.env.WERK_UNRELATED_SECRET; else process.env.WERK_UNRELATED_SECRET = previous; });
  const env = providerEnvironment('claude');
  for (const key of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot']) assert.equal(env[key], process.env[key], key);
  assert.equal(env.WERK_UNRELATED_SECRET, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

test('Windows cancellation terminates the provider and its descendants', { ...windows, timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-provider-tree-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const pidFile = join(directory, 'grandchild.pid');
  const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`;
  const controller = new AbortController();
  const execution = providerCommand(process.execPath, ['-e', script], directory, controller.signal, undefined, true, 'claude');
  let grandchild;
  for (let i = 0; i < 100 && !grandchild; i++) { await delay(100); grandchild = Number(await readFile(pidFile, 'utf8').catch(() => '')) || undefined; }
  assert.ok(grandchild, 'grandchild started');
  controller.abort();
  await assert.rejects(execution, { name: 'ProviderModelError', code: 'cancelled' });
  for (let i = 0; i < 50 && alive(grandchild); i++) await delay(100);
  assert.equal(alive(grandchild), false);
});

test('Windows enables Claude Code CLI but keeps Codex CLI unavailable', windows, async () => {
  assert.ok(modelFor(connection('claude-cli', { executable: process.execPath }), tmpdir()));
  assert.equal(modelFor(connection('codex-cli', { executable: process.execPath }), tmpdir()), undefined);
  const checks = new ProviderStatusChecks();
  const codex = await checks.check(connection('codex-cli', { executable: process.execPath }));
  assert.equal(codex.authentication, 'unavailable'); assert.match(codex.message, /Codex CLI execution needs a native Linux or macOS worker/);
  const claude = await checks.check(connection('claude-cli', { executable: join(tmpdir(), 'werk-missing-claude.exe') }));
  assert.equal(claude.authentication, 'unavailable'); assert.match(claude.message, /cannot be run/);
});

test('Claude receives its instructions from a private file that is removed afterwards', { ...posix, timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-claude-file-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'claude'), seen = join(directory, 'seen.json');
  await writeFile(executable, '#!' + process.execPath + `\nconst fs=require('node:fs');const a=process.argv.slice(2);const f=a[a.indexOf('--system-prompt-file')+1];fs.writeFileSync(${JSON.stringify(seen)},JSON.stringify({inline:a.includes('--system-prompt'),mode:fs.statSync(f).mode&0o777,body:fs.readFileSync(f,'utf8')}));process.stdout.write(JSON.stringify({type:'result',is_error:false,result:'done'}));\n`);
  await chmod(executable, 0o700);
  const before = await prompts();
  const model = modelFor(connection('claude-cli', { executable, instruction: 'Project rule: '.padEnd(60000, 'x') }), directory);
  await model.reply([{ role: 'user', text: 'hello' }], new AbortController().signal);
  const observed = JSON.parse(await readFile(seen, 'utf8'));
  assert.equal(observed.inline, false); assert.equal(observed.mode, 0o600);
  assert.match(observed.body, /^Task agent instructions:\nProject rule: x+/);
  assert.deepEqual(await prompts(), before);
});
