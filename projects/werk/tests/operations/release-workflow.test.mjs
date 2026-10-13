import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { parse } from 'yaml';

// Publication runs on Ubuntu. Exercise its actual Bash with a recording GitHub CLI.
const supported = process.platform !== 'win32' && spawnSync('jq', ['--version']).status === 0;
const workflow = parse(await readFile(new URL('../../src/infrastructure/workflows/release/release.yml', import.meta.url), 'utf8'));
async function publish(t, version, scenario = 'new') {
  const directory = await mkdtemp(join(tmpdir(), 'werk publish test '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, 'calls.jsonl');
  await writeFile(join(directory, 'gh'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
if (args[1] === 'view') {
  if (process.env.SCENARIO === 'draft') console.log(JSON.stringify({ isDraft: true }));
  else if (process.env.SCENARIO === 'published') console.log(JSON.stringify({ isDraft: false }));
  else process.exitCode = 1;
}
if (args[1] === 'upload' && process.env.SCENARIO === 'upload-fails') process.exitCode = 1;
`);
  await chmod(join(directory, 'gh'), 0o755);
  const script = workflow.jobs.publish.steps.at(-1).run;
  const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
    cwd: directory, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PATH: directory + delimiter + process.env.PATH, GITHUB_WORKSPACE: directory, GH_REPO: 'example/werk', RELEASE_VERSION: version, CALL_LOG: log, SCENARIO: scenario },
  });
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { result, calls, notes: await readFile(join(directory, 'release-notes.md'), 'utf8') };
}

test('stable publication uploads the complete draft before selecting latest', { skip: !supported }, async t => {
  const { result, calls, notes } = await publish(t, '0.1.0');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls.map(args => args[1]), ['view', 'create', 'upload', 'edit']);
  assert.ok(calls[1].includes('--draft'));
  for (const path of ['release/werk-0.1.0.tar.gz', 'release/werk-0.1.0.zip', 'release/install.mjs', 'release/SHA256SUMS']) assert.ok(calls[2].includes(path));
  assert.ok(calls[3].includes('--latest'));
  assert.ok(calls[3].includes('--draft=false'));
  assert.match(notes, /https:\/\/github.com\/example\/werk\/releases\/latest\/download\/install.mjs/);
  assert.match(notes, /\$LASTEXITCODE -eq 0/);
});

test('prereleases publish without replacing the stable latest release', { skip: !supported }, async t => {
  const { result, calls } = await publish(t, '0.2.0-rc.1');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls.at(-1).includes('--prerelease'));
  assert.ok(calls.at(-1).includes('--latest=false'));
});

test('failed uploads remain unpublished and only drafts can be repaired', { skip: !supported }, async t => {
  const failed = await publish(t, '0.1.0', 'upload-fails');
  assert.notEqual(failed.result.status, 0);
  assert.ok(!failed.calls.some(args => args[1] === 'edit'));
  const retry = await publish(t, '0.1.0', 'draft');
  assert.equal(retry.result.status, 0, retry.result.stderr);
  assert.deepEqual(retry.calls.map(args => args[1]), ['view', 'upload', 'edit']);
  const published = await publish(t, '0.1.0', 'published');
  assert.notEqual(published.result.status, 0);
  assert.deepEqual(published.calls.map(args => args[1]), ['view']);
});
