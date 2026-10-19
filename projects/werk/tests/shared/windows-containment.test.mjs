import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { runProcess } from '../../src/worker/dist/shared/process/launcher.js';
import { windowsContainment } from '../../src/worker/dist/shared/process/windows-containment.js';

const windows = process.platform === 'win32';
const skip = windows ? false : 'Windows PowerShell job supervisor exists only on Windows';
const node = process.execPath;
const base = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
const printPathext = `process.stdout.write(JSON.stringify(Object.entries(process.env).filter(([k]) => k.toLowerCase()==='pathext')))`;

// The cmd.exe command line is built by the plan (host-independent) and handed to the supervisor as base64 JSON.
function windowsCommandLine(executable, args) {
  const previous = process.env.SystemRoot;
  process.env.SystemRoot = 'C:\\Windows';
  try {
    const plan = windowsContainment(executable, args, {});
    return JSON.parse(Buffer.from(plan.env.WERK_PROVIDER_LAUNCH, 'base64').toString('utf8')).commandLine ?? null;
  } finally { if (previous === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previous; }
}

function restoreList(env) {
  const previous = process.env.SystemRoot;
  process.env.SystemRoot = 'C:\\Windows'; // the plan only needs an absolute win32 path, never the host's real one
  try {
    const plan = windowsContainment('C:\\tool.exe', [], env);
    return JSON.parse(Buffer.from(plan.env.WERK_PROVIDER_LAUNCH, 'base64').toString('utf8')).restoreEnvironment;
  } finally { if (previous === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previous; }
}

test('windowsContainment records the caller PATHEXT, case-insensitively, or null when absent', () => {
  assert.equal(restoreList({ PATH: 'x', PATHEXT: '.EXE;.CMD' }).PATHEXT, '.EXE;.CMD');
  assert.equal(restoreList({ PATH: 'x', PathExt: '.BAT' }).PATHEXT, '.BAT');
  assert.equal(restoreList({ PATH: 'x' }).PATHEXT, null);
});

test('contained Windows processes keep the caller PATHEXT instead of the PowerShell default', { skip, timeout: 60000 }, async () => {
  const run = async env => JSON.parse((await runProcess(node, ['-e', printPathext], { env, mode: 'contained', maxOutputBytes: 65536 })).stdout.toString());
  assert.deepEqual(await run({ ...base, PATHEXT: '.COM;.EXE;.BAT;.CMD' }), [['PATHEXT', '.COM;.EXE;.BAT;.CMD']]);
  assert.deepEqual(await run(base), [], 'no PATHEXT is not replaced with PowerShell\'s .CPL');
});

test('contained Windows cmd.exe resolves extension-less commands such as node', { skip, timeout: 60000 }, async () => {
  // No caller PATHEXT: PowerShell would otherwise leave 'PathEXT=.CPL'. Like an npm lifecycle script: Node starts 'cmd.exe /d /s /c node --version' for a shell command.
  const script = `const r=require('node:child_process').spawnSync('node --version',{shell:true,encoding:'utf8'});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exitCode=r.status;`;
  const env = { ...base, PATH: `${dirname(node)};${process.env.PATH}`, ComSpec: process.env.ComSpec };
  const result = await runProcess(node, ['-e', script], { env, mode: 'contained', maxOutputBytes: 65536, captureStderr: true });
  assert.equal(result.stdout.toString().trim(), process.version, result.stderr.toString());
});

test('windowsCommandLine builds cmd.exe command lines like Node shell:true and leaves other executables to CRT quoting', () => {
  const cmd = 'C:\\Windows\\System32\\cmd.exe';
  assert.equal(windowsCommandLine(cmd, ['/d', '/s', '/c', 'node --version']), `"${cmd}" /d /s /c "node --version"`);
  assert.equal(windowsCommandLine('CMD.EXE', ['/D', '/S', '/C', 'echo a b & echo c']), '"CMD.EXE" /D /S /C "echo a b & echo c"');
  assert.equal(windowsCommandLine('C:/Windows/Cmd.exe', ['/q', '/d', '/s', '/k', 'dir']), '"C:/Windows/Cmd.exe" /q /d /s /k "dir"');
  assert.equal(windowsCommandLine(cmd, ['/d', '/s', '/c', '"C:\\Program Files\\x.exe" "a b" 100%']), `"${cmd}" /d /s /c ""C:\\Program Files\\x.exe" "a b" 100%"`, 'command text after /c is verbatim');
  assert.equal(windowsCommandLine(cmd, ['/d', '/c', 'echo', 'hi']), `"${cmd}" /d /c echo hi`, 'without /s there is no outer quote pair');
  assert.equal(windowsCommandLine(cmd, ['/d', '/s', '/c']), `"${cmd}" /d /s /c`);
  assert.equal(windowsCommandLine(cmd, ['/?']), null, 'unrecognised switch shapes keep the standard quoting');
  assert.equal(windowsCommandLine(cmd, ['script.cmd', '/c', 'x']), null, 'a non-switch before /c keeps the standard quoting');
  assert.equal(windowsCommandLine(cmd, ['echo']), null);
  assert.equal(windowsCommandLine('C:\\tool\\notcmd.exe', ['/d', '/s', '/c', 'x']), null);
  assert.equal(windowsCommandLine('C:\\tool\\cmd.exe.bak', ['/c', 'x']), null);
  assert.equal(windowsCommandLine('C:\\tool.exe', ['a b', '"q"']), null);
});

test('windowsContainment sends the cmd.exe command line only for cmd.exe, as base64 JSON', () => {
  const previous = process.env.SystemRoot;
  process.env.SystemRoot = 'C:\\Windows';
  try {
    const launch = plan => JSON.parse(Buffer.from(plan.env.WERK_PROVIDER_LAUNCH, 'base64').toString('utf8'));
    const cmd = launch(windowsContainment('C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', 'echo "x"'], {}));
    assert.equal(cmd.commandLine, '"C:\\Windows\\System32\\cmd.exe" /d /s /c "echo "x""');
    assert.deepEqual(cmd.arguments, ['/d', '/s', '/c', 'echo "x"']);
    assert.equal(launch(windowsContainment('C:\\tool.exe', ['/d', 'a b'], {})).commandLine, undefined);
  } finally { if (previous === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previous; }
});

test('contained Windows cmd.exe parses /d /s /c command text like Node shell:true', { skip, timeout: 60000 }, async () => {
  const comspec = process.env.ComSpec;
  const env = { ...base, PATH: `${dirname(node)};${process.env.PATH}`, ComSpec: comspec };
  const run = command => runProcess(comspec, ['/d', '/s', '/c', command], { env, mode: 'contained', maxOutputBytes: 65536, captureStderr: true });
  const version = await run('node --version');
  assert.equal(version.stdout.toString().trim(), process.version, version.stderr.toString());
  const both = await run('echo a b & echo c');
  assert.match(both.stdout.toString(), /^a b\s*\r?\nc\s*$/, both.stderr.toString());
});
