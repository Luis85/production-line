import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { claudeArguments, modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { providerCommand, providerEnvironment, providerSpawnOptions } from '../../src/worker/dist/worker/infrastructure/codex-adapter.js';
import { ProviderStatusChecks } from '../../src/worker/dist/worker/infrastructure/provider-status.js';

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

test('Windows compiles a known supervisor type with its restricted runtime environment', { ...windows, timeout: 25000 }, async t => {
  const f = await treeFixture(t);
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const restricted = providerEnvironment('claude');
  const runtime = { ...restricted };
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'PSModulePath', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'NUMBER_OF_PROCESSORS', 'OS']) if (process.env[key]) runtime[key] = process.env[key];
  const source = await readFile(new URL('../../src/worker/infrastructure/provider-process.ts', import.meta.url), 'utf8');
  const definition = /Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/.exec(source)?.[1];
  assert.ok(definition, 'static supervisor C# source is available');
  const minimal = 'public static class WerkCompileProbe { public static string Value() { return "compiled"; } }';
  const command = `$ErrorActionPreference='Stop'; [Console]::Error.WriteLine('WERK_PHASE:shell'); try { Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:WERK_TEST_TYPE))); [Console]::WriteLine('compiled'); [Console]::Error.WriteLine('WERK_PHASE:compiled'); exit 0 } catch { [Console]::Error.WriteLine('WERK_PHASE:caught'); [Console]::Error.WriteLine('WERK_ERROR:'+$_.Exception.GetType().FullName+':'+$_.Exception.HResult); foreach ($code in [regex]::Matches([string]$_,'CS[0-9]{4}')) { [Console]::Error.WriteLine('WERK_CS:'+$code.Value) }; exit 125 }`;
  const results = await Promise.all([['minimal-restricted', restricted, minimal], ['minimal-runtime', runtime, minimal], ['minimal-ordinary', process.env, minimal], ['supervisor-restricted', restricted, definition], ['supervisor-runtime', runtime, definition], ['supervisor-ordinary', process.env, definition]].map(async ([name, env, type]) => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { cwd: f.directory, env: { ...env, WERK_TEST_TYPE: Buffer.from(type, 'utf8').toString('base64') }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    child.stdin.on('error', () => {}); child.stdin.end();
    let output = '', diagnostics = '', exit = null;
    child.stdout.on('data', chunk => { output = (output + chunk.toString('utf8')).slice(-4096); });
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-4096); });
    child.once('exit', (code, signal) => { exit = { code, signal }; });
    const close = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    let code = null, timedOut = false;
    try { code = await bounded(close); } catch { timedOut = true; }
    const phases = [...diagnostics.matchAll(/WERK_PHASE:([a-z-]+)/g)].map(match => match[1]);
    const error = /WERK_ERROR:([A-Za-z.]+):-?\d+/.exec(diagnostics)?.[0];
    return { name, code, exit, timedOut, phases, error, compilerCodes: [...diagnostics.matchAll(/WERK_CS:(CS[0-9]{4})/g)].map(match => match[1]), outputMatches: output.trim() === 'compiled' };
  }));
  t.diagnostic(JSON.stringify(results));
  for (const result of results) assert.ok(result.code === 0 && !result.timedOut && result.outputMatches, result.name + ' compiler probe failed');
});

test('Windows supervisor completes a contained invocation without blocking startup or drain', { ...windows, timeout: 25000 }, async t => {
  const f = await treeFixture(t);
  const source = await readFile(new URL('../../src/worker/infrastructure/provider-process.ts', import.meta.url), 'utf8');
  let supervisor = /const supervisor = String\.raw`([\s\S]*?)`;/.exec(source)?.[1]?.replace(/\r\n/g, '\n');
  assert.ok(supervisor, 'static supervisor source is available');
  // Instrument this known fixture only. Report fixed phase names, never subprocess
  // diagnostics or invocation arguments, if native process startup/drain stalls.
  const phases = [
    ['IntPtr lifetimeJob = CreateContainedJob();', 'lifetime-create'],
    ['if (!AssignProcessToJobObject(lifetimeJob, GetCurrentProcess()))', 'lifetime-assign'],
    ['job = CreateContainedJob();', 'provider-job'],
    ['Check(CreatePipe(out inRead, out inWrite, ref security, 0));', 'pipes'],
    ['Check(CreateProcess(executable, command,', 'process-create'],
    ['if (!AssignProcessToJobObject(job, child.Process))', 'provider-assign'],
    ['input = new FileStream(', 'streams'],
    ['Check(ResumeThread(child.Thread)', 'resume'],
    ['if (WaitForSingleObject(child.Process, uint.MaxValue)', 'provider-wait'],
    ['Check(TerminateJobObject(job, 125));', 'descendants-stop'],
    ['Task.WaitAll(stdout, stderr);', 'streams-drain'],
    ['return unchecked((int)code);', 'return'],
  ];
  for (const [needle, phase] of phases) {
    assert.ok(supervisor.includes(needle), phase);
    supervisor = supervisor.replace(needle, `Console.Error.WriteLine("WERK_PHASE:${phase}");\n      ${needle}`);
  }
  supervisor = supervisor.replace("$ErrorActionPreference = 'Stop'", "$ErrorActionPreference = 'Stop'\n[Console]::Error.WriteLine('WERK_PHASE:shell')")
    .replace('  $spec = ', "  [Console]::Error.WriteLine('WERK_PHASE:compiled')\n  $spec = ")
    .replace('} catch {\n  [Console]::Error.WriteLine', "} catch {\n  [Console]::Error.WriteLine('WERK_PHASE:caught'); [Console]::Error.WriteLine('WERK_ERROR:'+$_.Exception.GetType().FullName+':'+$_.Exception.HResult); foreach ($code in [regex]::Matches([string]$_,'CS[0-9]{4}')) { [Console]::Error.WriteLine('WERK_CS:'+$code.Value) }\n  [Console]::Error.WriteLine");
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(supervisor, 'utf16le').toString('base64')], {
    cwd: f.directory, env: { ...providerEnvironment('claude'), WERK_PROVIDER_LAUNCH: Buffer.from(JSON.stringify({ executable: process.execPath, arguments: ['-e', "process.stdout.write('fixture completed')"] }), 'utf8').toString('base64') },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  child.stdin.on('error', () => {}); child.stdin.end();
  let output = '', diagnostics = '', exit = null;
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-16384); });
  const close = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  let code;
  try { code = await bounded(close); }
  catch { throw Error('Supervisor deadline; exit: ' + JSON.stringify(exit) + '; phases: ' + [...diagnostics.matchAll(/WERK_PHASE:([a-z-]+)/g)].map(match => match[1]).join(', ') + '; category: ' + (/WERK_ERROR:([A-Za-z.]+):-?\d+/.exec(diagnostics)?.[0] ?? 'none') + '; compiler codes: ' + [...diagnostics.matchAll(/WERK_CS:(CS[0-9]{4})/g)].map(match => match[1]).join(', ')); }
  assert.equal(code, 0, 'Supervisor exit; phases: ' + [...diagnostics.matchAll(/WERK_PHASE:([a-z-]+)/g)].map(match => match[1]).join(', '));
  assert.equal(output, 'fixture completed');
});

test('Windows cancellation terminates the provider and its descendants', { ...windows, timeout: 30000 }, async t => {
  const f = await treeFixture(t);
  const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').appendFileSync(${JSON.stringify(f.pidFile)},String(c.pid)+'\\n');setInterval(()=>{},1000);`;
  const execution = providerCommand(process.execPath, ['-e', script], f.directory, f.controller.signal, undefined, true, 'claude');
  // Observe startup failures immediately while waiting for the child fixture.
  const settled = execution.then(output => ({ output }), error => ({ error }));
  await waitFor(async () => (await f.pids()).length > 0);
  f.controller.abort();
  const outcome = await bounded(settled);
  assert.equal(outcome.error?.name, 'ProviderModelError');
  assert.equal(outcome.error?.code, 'cancelled');
  await waitFor(async () => (await f.pids()).every(pid => !alive(pid)));
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
  const script = `const chunks=[];process.stdin.on('data',chunk=>chunks.push(chunk));process.stdin.on('end',()=>{const input=Buffer.concat(chunks);process.stderr.write('fixture-only diagnostics');process.stdout.write(JSON.stringify({args:process.argv.slice(1),bytes:input.length,hash:require('node:crypto').createHash('sha256').update(input).digest('hex')}));});`;
  const output = JSON.parse((await bounded(providerCommand(process.execPath, ['-e', script, '--', ...args], f.directory, f.controller.signal, input, true, 'claude'))).toString('utf8'));
  assert.deepEqual(output.args, args);
  assert.equal(output.bytes, Buffer.byteLength(input));
  assert.equal(output.hash, createHash('sha256').update(input).digest('hex'));
});

test('Windows status checks stay bounded when exited providers leave descendants holding output pipes', { ...windows, timeout: 45000 }, async t => {
  const f = await treeFixture(t), scriptFile = join(f.directory, 'status.js');
  await writeFile(scriptFile, `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});c.unref();require('node:fs').appendFileSync(${JSON.stringify(f.pidFile)},String(c.pid)+'\\n');process.stdout.write(process.argv.includes('--version')?'2.1.248\\n':JSON.stringify({loggedIn:true}));`);
  const executable = join(f.directory, 'status-fixture.exe'), source = join(f.directory, 'status-fixture.cs');
  await writeFile(source, `using System;using System.Diagnostics;public class Fixture {public static int Main(string[] args) {var start=new ProcessStartInfo {FileName=${JSON.stringify(process.execPath)},Arguments=${JSON.stringify('"' + scriptFile + '" ')}+String.Join(" ",args),UseShellExecute=false};using(var child=Process.Start(start)){child.WaitForExit();return child.ExitCode;}}}`);
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await executeFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; Add-Type -Path $env:WERK_TEST_SOURCE -OutputAssembly $env:WERK_TEST_EXE -OutputType ConsoleApplication'], { env: { ...process.env, WERK_TEST_SOURCE: source, WERK_TEST_EXE: executable }, timeout: 20000, windowsHide: true });
  const result = await bounded(new ProviderStatusChecks().check(connection('claude-cli', { executable })));
  assert.equal(result.authentication, 'authenticated');
  const pids = await f.pids(); assert.equal(pids.length, 2, 'version and auth probes both ran');
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
  await model.reply([{ role: 'user', text: 'hello' }], new AbortController().signal);
  const observed = JSON.parse(await readFile(seen, 'utf8'));
  assert.equal(observed.inline, false); assert.equal(observed.mode, 0o600);
  assert.match(observed.body, /^Task agent instructions:\nProject rule: x+/);
  await assert.rejects(readFile(observed.file), { code: 'ENOENT' });
  await assert.rejects(readFile(dirname(observed.file)), { code: 'ENOENT' });
});
