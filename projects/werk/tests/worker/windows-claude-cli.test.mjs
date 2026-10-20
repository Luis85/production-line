import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareProcessRuntime } from '../../src/worker/dist/shared/process/launcher.js';
import { claudeArguments, modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { providerCommand, providerEnvironment } from '../../src/worker/dist/worker/infrastructure/codex-adapter.js';
import { ProviderStatusChecks } from '../../src/worker/dist/worker/infrastructure/provider-status.js';
import { ProviderAccountChecks } from '../../src/worker/dist/worker/infrastructure/provider-account.js';

const windows = { skip: process.platform !== 'win32' && 'Windows process and environment behavior' };
const posix = { skip: process.platform === 'win32' && 'POSIX shebang fixture' };
const connection = (id, extra = {}) => ({ id, executable: '', model: '', apiKey: '', ...extra });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const executeFile = promisify(execFile);
async function bounded(operation, milliseconds = 15000) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Provider fixture exceeded its deadline')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function waitFor(check) {
  const deadline = Date.now() + 10000;
  while (!(await check())) { if (Date.now() > deadline) throw Error('Provider fixture did not reach the expected state'); await delay(50); }
}
async function treeFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-provider-tree-')), pidFile = join(directory, 'children.pid');
  const controller = new AbortController();
  const pids = async () => (await readFile(pidFile, 'utf8').catch(() => '')).trim().split(/\s+/).map(Number).filter(Boolean);
  t.after(async () => {
    controller.abort();
    // Fixture-owned leaf PIDs are recorded solely to clean up if the containment regression fails.
    for (const pid of await pids()) if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {}
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { directory, pidFile, controller, pids };
}

test('Claude arguments keep every isolation flag and pass instructions only as a file', () => {
  const args = claudeArguments('claude-sonnet', '/private/system-prompt.md');
  for (const flag of ['--print', '--safe-mode', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--tools') + 1], ''); assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.deepEqual(args.slice(-2), ['--system-prompt-file', '/private/system-prompt.md']);
  assert.equal(args.includes('--system-prompt'), false);
  assert.equal(claudeArguments('', '/p').includes('--model'), false);
});

test('Windows provider environment keeps the account profile but drops unrelated secrets', windows, t => {
  const previous = process.env.WERK_UNRELATED_SECRET; process.env.WERK_UNRELATED_SECRET = 'private';
  t.after(() => { if (previous === undefined) delete process.env.WERK_UNRELATED_SECRET; else process.env.WERK_UNRELATED_SECRET = previous; });
  const env = providerEnvironment('claude');
  for (const key of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot']) assert.equal(env[key], process.env[key], key);
  assert.equal(env.WERK_UNRELATED_SECRET, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

test('Windows cancellation terminates the provider and its descendants', { ...windows, timeout: 30000 }, async t => {
  const f = await treeFixture(t);
  // Native setup has its own bounded lifecycle; the unchanged marker deadline measures the dispatched provider.
  await prepareProcessRuntime(f.directory, t.signal);
  const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').appendFileSync(${JSON.stringify(f.pidFile)},String(c.pid)+'\\n');setInterval(()=>{},1000);`;
  const execution = providerCommand(process.execPath, ['-e', script], f.directory, f.controller.signal, undefined, true, 'claude');
  let observed;
  const settled = execution.then(output => observed = { output }, error => observed = { error });
  try {
    await waitFor(async () => {
      if (observed) throw observed.error ?? Error('Provider fixture exited before starting its descendant');
      return (await f.pids()).length > 0;
    });
    f.controller.abort();
    const outcome = await bounded(settled);
    assert.equal(outcome.error?.name, 'ProviderModelError');
    assert.equal(outcome.error?.code, 'cancelled');
    await waitFor(() => f.pids().then(pids => pids.every(pid => !alive(pid))));
  } finally { f.controller.abort(); await settled; }
});

for (const inheritPipes of [false, true]) {
  test(`Windows cleans descendants after their parent exits with ${inheritPipes ? 'inherited' : 'ignored'} output`, { ...windows, timeout: 30000 }, async t => {
    const f = await treeFixture(t);
    const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:${JSON.stringify(inheritPipes ? ['ignore', 'inherit', 'inherit'] : 'ignore')}});c.unref();require('node:fs').appendFileSync(${JSON.stringify(f.pidFile)},String(c.pid)+'\\n');process.stdout.write('parent completed\\n');`;
    const output = await bounded(providerCommand(process.execPath, ['-e', script], f.directory, f.controller.signal, undefined, true, 'claude'));
    assert.equal(output.toString('utf8'), 'parent completed\n');
    const pids = await f.pids(); assert.equal(pids.length, 1);
    await waitFor(() => pids.every(pid => !alive(pid)));
  });
}

test('Windows preserves empty, quoted and Unicode arguments and raw stdin without shell interpretation', { ...windows, timeout: 30000 }, async t => {
  const f = await treeFixture(t);
  const args = ['', 'two words', '"quoted"', 'ends\\', 'slash\\"quote', 'snow ☃ 日本語', '$value; & echo not-a-command', 'first\nsecond'];
  const input = 'first\0line\r\n雪\n'.repeat(20000);
  const runtimeKeys = ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'NUMBER_OF_PROCESSORS', 'OS', 'PSModulePath'];
  const callerEnvironment = providerEnvironment('claude');
  // A direct child can receive standard runtime values absent from its supplied environment.
  const baselineScript = `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(runtimeKeys)}.map(key=>[key,process.env[key]]))))`;
  const baseline = await executeFile(process.execPath, ['-e', baselineScript], { cwd: f.directory, env: callerEnvironment, windowsHide: true, timeout: 10000, maxBuffer: 65536 });
  const expectedRuntime = JSON.parse(baseline.stdout);
  const script = `const chunks=[];process.stdin.on('data',chunk=>chunks.push(chunk));process.stdin.on('end',()=>{const input=Buffer.concat(chunks);process.stderr.write('fixture-only diagnostics');process.stdout.write(JSON.stringify({args:process.argv.slice(1),runtime:Object.fromEntries(${JSON.stringify(runtimeKeys)}.map(key=>[key,process.env[key]])),privateLaunchPresent:process.env.WERK_PROVIDER_LAUNCH!==undefined,bytes:input.length,hash:require('node:crypto').createHash('sha256').update(input).digest('hex')}));});`;
  const output = JSON.parse((await bounded(providerCommand(process.execPath, ['-e', script, '--', ...args], f.directory, f.controller.signal, input, true, 'claude'))).toString('utf8'));
  assert.deepEqual(output.args, args);
  assert.deepEqual(output.runtime, expectedRuntime, 'supervisor runtime context is restored before provider launch');
  assert.equal(output.privateLaunchPresent, false, 'private supervisor launch data is removed before provider launch');
  assert.equal(output.bytes, Buffer.byteLength(input));
  assert.equal(output.hash, createHash('sha256').update(input).digest('hex'));
});

test('Windows status and account checks stay bounded when exited providers leave descendants holding output pipes', { ...windows, timeout: 45000 }, async t => {
  const accounts = new ProviderAccountChecks(), checks = new ProviderStatusChecks();
  t.after(() => { accounts.close(); checks.close(); });
  const f = await treeFixture(t), scriptFile = join(f.directory, 'status.js');
  await writeFile(scriptFile, `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});c.unref();require('node:fs').appendFileSync(${JSON.stringify(f.pidFile)},String(c.pid)+'\\n');require('node:fs').appendFileSync(${JSON.stringify(f.pidFile + '.args')},JSON.stringify(process.argv.slice(2))+'\\n');process.stdout.write(process.argv.includes('--version')?'2.1.257\\n':JSON.stringify({loggedIn:true,email:'member@example.com',orgName:'Fixture team',subscriptionType:'pro',authMethod:'claude.ai',accessToken:'private-fixture-token'}));`);
  const executable = join(f.directory, 'status-fixture.exe'), source = join(f.directory, 'status-fixture.cs');
  await writeFile(source, `using System;using System.Diagnostics;public class Fixture {public static int Main(string[] args) {var start=new ProcessStartInfo {FileName=${JSON.stringify(process.execPath)},Arguments=${JSON.stringify('"' + scriptFile + '" ')}+String.Join(" ",args),UseShellExecute=false};using(var child=Process.Start(start)){child.WaitForExit();return child.ExitCode;}}}`);
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await executeFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; Add-Type -Path $env:WERK_TEST_SOURCE -OutputAssembly $env:WERK_TEST_EXE -OutputType ConsoleApplication'], { env: { ...process.env, WERK_TEST_SOURCE: source, WERK_TEST_EXE: executable }, timeout: 20000, windowsHide: true });
  const result = await bounded(checks.check(connection('claude-cli', { executable })));
  assert.equal(result.authentication, 'authenticated');
  const account = await bounded(accounts.check(connection('claude-cli', { executable })));
  assert.equal(account.signedIn, true); assert.equal(account.email, 'member@example.com');
  assert.equal(account.organization, 'Fixture team'); assert.equal(account.subscription, 'pro');
  assert.doesNotMatch(JSON.stringify(account), /private-fixture-token/);
  const calls = (await readFile(f.pidFile + '.args', 'utf8')).trim().split('\n').map(value => JSON.parse(value));
  assert.deepEqual(calls, [['--version'], ['auth', 'status'], ['auth', 'status']]);
  const pids = await f.pids(); assert.equal(pids.length, 3, 'version, auth, and structured account probes all ran');
  await waitFor(() => pids.every(pid => !alive(pid)));
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
  await writeFile(executable, '#!' + process.execPath + `\nconst fs=require('node:fs');const a=process.argv.slice(2);const f=a[a.indexOf('--system-prompt-file')+1];fs.writeFileSync(${JSON.stringify(seen)},JSON.stringify({file:f,inline:a.includes('--system-prompt'),mode:fs.statSync(f).mode&0o777,body:fs.readFileSync(f,'utf8')}));process.stdout.write(JSON.stringify({type:'result',is_error:false,result:'done'}));\n`);
  await chmod(executable, 0o700);
  const model = modelFor(connection('claude-cli', { executable, instruction: 'Project rule: '.padEnd(60000, 'x') }), directory);
  await model.reply([{ id: 'input', role: 'user', text: 'hello', state: 'complete', at: '2026-10-16T00:00:00Z' }], new AbortController().signal);
  const observed = JSON.parse(await readFile(seen, 'utf8'));
  assert.equal(observed.inline, false); assert.equal(observed.mode, 0o600);
  assert.match(observed.body, /^Task agent instructions:\nProject rule: x+/);
  await assert.rejects(readFile(observed.file), { code: 'ENOENT' });
  await assert.rejects(readFile(dirname(observed.file)), { code: 'ENOENT' });
});
