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
