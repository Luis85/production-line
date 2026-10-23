import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { parse } from 'yaml';

const workflow = parse(await readFile(new URL('../../src/infrastructure/workflows/check/check.yml', import.meta.url), 'utf8'));
const job = workflow.jobs.check;
const posix = job.steps.find(step => step.name === 'Run full check (POSIX)');
const macosJob = workflow.jobs.macos;
const macos = macosJob.steps.find(step => step.name === 'Run macOS quality, build and test partition');
const windowsJob = workflow.jobs.windows;
const windows = windowsJob.steps.find(step => step.name === 'Run complete Windows test partition');

test('full checks retain their platform shells, bounded job budgets, and failure diagnostics', () => {
  assert.deepEqual(job.strategy.matrix.os, ['ubuntu-latest']);
  assert.equal(macosJob['runs-on'], 'macos-latest'); assert.deepEqual(macosJob.strategy.matrix.shard, [1, 2, 3, 4]);
  assert.equal(macosJob['timeout-minutes'], 25); assert.equal(macos['timeout-minutes'], 20); assert.equal(macos.if, undefined);
  assert.equal(job['timeout-minutes'], 25); assert.equal(posix['timeout-minutes'], 20); assert.equal(posix.if, undefined);
  assert.equal(windowsJob['runs-on'], 'windows-latest'); assert.deepEqual(windowsJob.strategy.matrix.shard, [1, 2, 3, 4]);
  assert.equal(windowsJob['timeout-minutes'], 35); assert.equal(windows['timeout-minutes'], 22); assert.equal(windows.if, undefined);
  assert.equal(workflow.defaults?.run?.shell, undefined);
  assert.match(posix.run, /npm run check/);
  assert.match(windows.run, /node scripts\/quality\/test-shard\.mjs --shard "\$\{\{ matrix\.shard \}\}\/4" --manifest "\$env:RUNNER_TEMP\/werk-test-shard\.json"/);
  assert.match(windows.run, /\$PSNativeCommandUseErrorActionPreference = \$false/); assert.match(windows.run, /exit \$LASTEXITCODE/);
  for (const [owner, step, name, paths] of [
    [job, posix, 'werk-check-output-${{ matrix.os }}', ['${{ runner.temp }}/werk-check.log']],
    [macosJob, macos, 'werk-check-output-macos-${{ matrix.shard }}', ['${{ runner.temp }}/werk-check.log', '${{ runner.temp }}/werk-test-shard.json']],
    [windowsJob, windows, 'werk-check-output-windows-${{ matrix.shard }}', ['${{ runner.temp }}/werk-check.log', '${{ runner.temp }}/werk-test-shard.json']],
  ]) {
    assert.equal(owner.strategy['fail-fast'], false); assert.equal(owner.defaults?.run?.shell, undefined);
    assert.equal(step.shell, undefined); assert.equal(step['continue-on-error'], undefined);
    assert.ok(step['timeout-minutes'] < owner['timeout-minutes'], 'The test deadline leaves bounded time for failure diagnostics.');
    const upload = owner.steps[owner.steps.indexOf(step) + 1];
    assert.equal(upload.uses, 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9');
    assert.equal(upload.if, 'always()'); assert.equal(upload['continue-on-error'], true);
    assert.equal(upload.with.name, name); assert.deepEqual(upload.with.path.trim().split(/\r?\n/), paths);
    assert.equal(upload.with['retention-days'], 7); assert.equal(upload.with['if-no-files-found'], 'warn');
    for (const command of ['npm run audit:dependencies', 'node bin/forge.js workflows sync --check']) {
      const required = owner.steps.find(item => item.run === command); assert.ok(required);
      assert.equal(required.if, owner === job ? undefined : 'matrix.shard == 1');
      assert.equal(required['continue-on-error'], undefined);
    }
  }
  const quality = windowsJob.steps.find(step => step.name === 'Windows quality checks'), build = windowsJob.steps.find(step => step.name === 'Build all independent applications');
  assert.equal(quality.if, 'matrix.shard == 1'); assert.equal(quality.run, 'npm run check:fast'); assert.equal(quality['timeout-minutes'], 8);
  assert.equal(build.if, undefined); assert.equal(build.run, 'npm run build'); assert.equal(build['timeout-minutes'], 8);
  assert.equal(quality['continue-on-error'], undefined); assert.equal(build['continue-on-error'], undefined);
});

for (const status of [0, 23]) test(`actual platform check script retains both output streams and exit status ${status}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk check diagnostics '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const win = process.platform === 'win32', executable = join(directory, win ? 'node.cmd' : 'npm');
  await writeFile(executable, win
    ? `@echo off\r\necho check stdout\r\necho check stderr 1>&2\r\nexit /b ${status}\r\n`
    : `#!/bin/sh\nprintf 'check stdout\\n'\nprintf 'check stderr\\n' >&2\nexit ${status}\n`);
  if (!win) await chmod(executable, 0o755);
  const env = { ...process.env, RUNNER_TEMP: directory };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = directory + delimiter + (env[pathKey] ?? '');
  const result = spawnSync(win ? 'pwsh' : 'bash', win
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'stop'\n" + windows.run.replaceAll('${{ matrix.shard }}', '1')]
    : ['-e', '-c', posix.run], { env, cwd: directory, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined); assert.equal(result.status, status, result.stderr);
  const log = await readFile(join(directory, 'werk-check.log'), 'utf8');
  for (const output of ['check stdout', 'check stderr']) {
    assert.ok(log.includes(output)); assert.ok(result.stdout.includes(output));
  }
});


for (const scenario of [
  { shard: 1, failure: '', expected: ['quality', 'build', 'tests'] },
  { shard: 2, failure: '', expected: ['build', 'tests'] },
  { shard: 1, failure: 'quality', expected: ['quality'] },
  { shard: 1, failure: 'build', expected: ['quality', 'build'] },
  { shard: 1, failure: 'tests', expected: ['quality', 'build', 'tests'] },
]) test(`macOS partition ${scenario.shard} preserves ${scenario.failure || 'success'} outcome and command order`, {
  skip: process.platform === 'win32' && 'The macOS workflow uses the native POSIX shell',
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk macos check '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const observe = `printf '%s\\n' "$phase" >> "$RUNNER_TEMP/calls"\nprintf 'stdout %s\\n' "$phase"\nprintf 'stderr %s\\n' "$phase" >&2\n[ "$WERK_FAIL_PHASE" != "$phase" ] || exit 23\n`;
  const commands = {
    npm: '#!/bin/sh\ncase "$*" in\n"run check:fast") phase=quality;;\n"run build") phase=build;;\n*) exit 97;;\nesac\n' + observe,
    node: '#!/bin/sh\n[ "$#" = 5 ] && [ "$1" = scripts/quality/test-shard.mjs ] && [ "$2" = --shard ] && [ "$4" = --manifest ] || exit 98\nprintf \'%s\\n\' "$3" > "$RUNNER_TEMP/selected-shard"\nprintf \'{"fixture":"manifest"}\\n\' > "$5"\nphase=tests\n' + observe,
  };
  for (const [name, script] of Object.entries(commands)) {
    const executable = join(directory, name); await writeFile(executable, script); await chmod(executable, 0o755);
  }
  const environment = { ...process.env, RUNNER_TEMP: directory, WERK_FAIL_PHASE: scenario.failure, PATH: directory + delimiter + (process.env.PATH ?? '') };
  const result = spawnSync('bash', ['-e', '-c', macos.run.replaceAll('${{ matrix.shard }}', String(scenario.shard))], { env: environment, cwd: directory, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error); assert.equal(result.status, scenario.failure ? 23 : 0, result.stderr);
  assert.deepEqual((await readFile(join(directory, 'calls'), 'utf8')).trim().split('\n'), scenario.expected);
  const log = await readFile(join(directory, 'werk-check.log'), 'utf8');
  for (const phase of scenario.expected) for (const stream of ['stdout', 'stderr']) {
    assert.ok(log.includes(`${stream} ${phase}`)); assert.ok(result.stdout.includes(`${stream} ${phase}`));
  }
  if (scenario.expected.includes('tests')) {
    assert.equal((await readFile(join(directory, 'selected-shard'), 'utf8')).trim(), scenario.shard + '/4');
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'werk-test-shard.json'), 'utf8')), { fixture: 'manifest' });
  }
});
