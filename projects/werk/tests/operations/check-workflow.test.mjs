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
const windowsJob = workflow.jobs.windows;
const windows = windowsJob.steps.find(step => step.name === 'Run complete Windows test partition');

test('full checks retain their platform shells, bounded job budgets, and failure diagnostics', () => {
  assert.deepEqual(job.strategy.matrix.os, ['ubuntu-latest', 'macos-latest']);
  assert.equal(job['timeout-minutes'], 25); assert.equal(posix['timeout-minutes'], 20); assert.equal(posix.if, undefined);
  assert.equal(windowsJob['runs-on'], 'windows-latest'); assert.deepEqual(windowsJob.strategy.matrix.shard, [1, 2, 3, 4]);
  assert.equal(windowsJob['timeout-minutes'], 35); assert.equal(windows['timeout-minutes'], 22); assert.equal(windows.if, undefined);
  assert.equal(workflow.defaults?.run?.shell, undefined);
  assert.match(posix.run, /npm run check/);
  assert.match(windows.run, /node scripts\/quality\/test-shard\.mjs --shard "\$\{\{ matrix\.shard \}\}\/4" --manifest "\$env:RUNNER_TEMP\/werk-test-shard\.json"/);
  assert.match(windows.run, /\$PSNativeCommandUseErrorActionPreference = \$false/); assert.match(windows.run, /exit \$LASTEXITCODE/);
  for (const [owner, step, name, paths] of [
    [job, posix, 'werk-check-output-${{ matrix.os }}', ['${{ runner.temp }}/werk-check.log']],
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
      assert.equal(required.if, owner === windowsJob ? 'matrix.shard == 1' : undefined);
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
