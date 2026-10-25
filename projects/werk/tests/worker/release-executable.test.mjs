import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseBuildLaunch } from '../../src/worker/dist/worker/infrastructure/release-executable.js';

const environment = { Path: 'C:\\tools;C:\\Program Files\\nodejs', SystemRoot: 'C:\\Windows' };
function options(files) { return { platform: /** @type {const} */ ('win32'), nodeExecutable: 'C:\\runtime\\node.exe', accessible: async path => files.includes(path) }; }

test('Windows build node uses the running native executable rather than supervisor PATH lookup', async () => {
  const launch = await releaseBuildLaunch('node', ['build.mjs'], 'C:\\project', environment, options([]));
  assert.equal(launch.executable, 'C:\\runtime\\node.exe'); assert.deepEqual(launch.args, ['build.mjs']); assert.equal(launch.verbatimCmd, false);
});
test('Windows native build tools resolve absolute exe paths and never implicitly search the project', async () => {
  const files = ['C:\\tools\\builder.exe'];
  assert.equal((await releaseBuildLaunch('builder', ['build'], 'C:\\project', environment, options(files))).executable, files[0]);
  await assert.rejects(releaseBuildLaunch('builder', [], 'C:\\project', { ...environment, Path: ';relative' }, options(['C:\\project\\builder.exe'])), /operator PATH/);
});
test('Windows npm batch wrappers use the approved contained cmd launch with quoted fixed arguments', async () => {
  const files = ['C:\\Program Files\\nodejs\\npm.cmd', 'C:\\Windows\\System32\\cmd.exe'];
  const launch = await releaseBuildLaunch('npm', ['run', 'build'], 'C:\\project', environment, options(files));
  assert.equal(launch.executable, 'C:\\Windows\\System32\\cmd.exe'); assert.equal(launch.verbatimCmd, true);
  assert.deepEqual(launch.args, ['/d', '/s', '/c', '"C:\\Program Files\\nodejs\\npm.cmd" "run" "build"']);
  await assert.rejects(releaseBuildLaunch('npm', ['%SECRET%'], 'C:\\project', environment, options(files)), /shell variables/);
});
test('explicit Windows executable paths preserve spaces without shell interpretation', async () => {
  const executable = 'C:\\Program Files\\Build Tool\\tool.exe', launch = await releaseBuildLaunch(executable, ['one & two'], 'C:\\project', environment, options([executable]));
  assert.equal(launch.executable, executable); assert.deepEqual(launch.args, ['one & two']); assert.equal(launch.verbatimCmd, false);
});
