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
const windows = job.steps.find(step => step.name === 'Run full check (Windows)');

test('full checks retain their platform shells, bounded job budgets, and failure diagnostics', () => {
  assert.deepEqual(job.strategy.matrix.os, ['ubuntu-latest', 'windows-latest', 'macos-latest']);
  assert.equal(job.strategy['fail-fast'], false);
  assert.equal(job['timeout-minutes'], "${{ matrix.os == 'windows-latest' && 60 || 25 }}");
  assert.equal(posix.if, "matrix.os != 'windows-latest'");
  assert.equal(windows.if, "matrix.os == 'windows-latest'");
  assert.equal(posix['timeout-minutes'], 20);
  assert.equal(windows['timeout-minutes'], 55);
  assert.equal(workflow.defaults?.run?.shell, undefined);
  for (const step of [posix, windows]) {
    assert.equal(step.shell, undefined); assert.equal(step['continue-on-error'], undefined);
    assert.match(step.run, /npm run check/);
  }
  const upload = job.steps[job.steps.indexOf(windows) + 1];
  assert.equal(upload.uses, 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9');
  assert.equal(upload.if, 'always()'); assert.equal(upload['continue-on-error'], true);
  assert.equal(upload.with.name, 'werk-check-output-${{ matrix.os }}');
  assert.equal(upload.with.path, '${{ runner.temp }}/werk-check.log');
  assert.equal(upload.with['retention-days'], 7); assert.equal(upload.with['if-no-files-found'], 'warn');
  assert.ok(job.steps.some(step => step.run === 'npm run audit:dependencies'));
  assert.ok(job.steps.some(step => step.run === 'node bin/forge.js workflows sync --check'));
});

for (const status of [0, 23]) test(`actual platform check script retains both output streams and exit status ${status}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk check diagnostics '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const win = process.platform === 'win32', executable = join(directory, win ? 'npm.cmd' : 'npm');
  await writeFile(executable, win
    ? `@echo off\r\necho check stdout\r\necho check stderr 1>&2\r\nexit /b ${status}\r\n`
    : `#!/bin/sh\nprintf 'check stdout\\n'\nprintf 'check stderr\\n' >&2\nexit ${status}\n`);
  if (!win) await chmod(executable, 0o755);
  const env = { ...process.env, RUNNER_TEMP: directory };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = directory + delimiter + (env[pathKey] ?? '');
  const result = spawnSync(win ? 'pwsh' : 'bash', win
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'stop'\n" + windows.run]
    : ['-e', '-c', posix.run], { env, cwd: directory, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined); assert.equal(result.status, status, result.stderr);
  const log = await readFile(join(directory, 'werk-check.log'), 'utf8');
  for (const output of ['check stdout', 'check stderr']) {
    assert.ok(log.includes(output)); assert.ok(result.stdout.includes(output));
  }
});
