import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { findExecutable } from '../../src/worker/dist/worker/infrastructure/providers.js';

/** Tests only discovery: these labelled fixture files are never executed. */
test('executable discovery skips directories and understands quoted native Windows PATH entries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-native-discovery-')), first = join(directory, 'first'), second = join(directory, 'with spaces');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(first); await mkdir(second); await mkdir(join(first, 'claude.exe'));
  const native = join(second, 'claude.exe'); await writeFile(native, 'fixture executable bytes'); await chmod(native, 0o700);
  assert.equal(await findExecutable('claude', { platform: 'win32', path: `${first};"${second}"` }), native);
  await writeFile(join(first, 'gh.cmd'), 'fixture shell shim');
  assert.equal(await findExecutable('gh', { platform: 'win32', path: first }), '');
  assert.equal(await findExecutable('claude', { platform: 'win32', path: 'relative-path' }), '');
});

test('executable discovery retains POSIX PATH behavior and refuses a matching directory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-posix-discovery-')), first = join(directory, 'first'), second = join(directory, 'second');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(first); await mkdir(second); await mkdir(join(first, 'claude'));
  const executable = join(second, 'claude'); await writeFile(executable, 'fixture executable bytes'); await chmod(executable, 0o700);
  assert.equal(await findExecutable('claude', { platform: 'linux', path: [first, second].join(delimiter) }), executable);
});
