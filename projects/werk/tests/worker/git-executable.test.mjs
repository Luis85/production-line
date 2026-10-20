import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gitExecutable } from '../../src/worker/dist/shared/git/executable.js';
import { prepareProcessRuntime, runProcess } from '../../src/worker/dist/shared/process/launcher.js';

// Startup is bounded separately; the test and each target retain their original deadlines.
before(async context => {
  if (process.platform === 'win32') await prepareProcessRuntime(process.cwd(), context.signal);
}, { timeout: 30000 });

test('Windows Git in both launch modes resolves native executable only from its supplied PATH', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-git-executable-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const first = join(directory, 'first'), second = join(directory, 'second'); await mkdir(first); await mkdir(second);
  await writeFile(join(first, 'git.cmd'), '@echo private-shell-wrapper\r\n');
  const expected = join(second, 'git.exe'); await copyFile(process.execPath, expected);
  // A repository-local executable is never an implicit search candidate.
  await copyFile(process.execPath, join(directory, 'git.exe'));
  const env = { SystemRoot: process.env.SystemRoot, Path: first + ';' + second, Pathext: '.CMD;.EXE' };
  for (const mode of /** @type {const} */ (['plain', 'contained'])) {
    assert.equal(await gitExecutable(directory, env, mode), expected);
    const result = await runProcess(await gitExecutable(directory, env, mode), ['-e', "process.stdout.write('native')"], { cwd: directory, env, mode, signal: t.signal, timeoutMs: 10000, maxOutputBytes: 1024 });
    assert.equal(result.stdout.toString(), 'native');
    await assert.rejects(gitExecutable(directory, { ...env, Path: first }, mode), /configured PATH/);
    await assert.rejects(gitExecutable(directory, { ...env, Pathext: '.CMD' }, mode), /configured PATH/);
  }
});
