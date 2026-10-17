import { workerStatus } from '../helpers/worker-status.mjs';
import { testListeningAddress } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { statusServer } from '../../src/worker/dist/worker/status/server.js';
const entry = new URL('../../scripts/runtime/portable/cli.mjs', import.meta.url).href;

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-definition-yaml-cli-')));
  let journal, worker, server;
  t.after(async () => {
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    try { await worker?.close(); } finally { journal?.close(); await rm(directory, { recursive: true, force: true }); }
  });
  const state = join(directory, 'state'); await mkdir(state);
  journal = new SnapshotJournal(state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
  const current = workerStatus({ activeTasks: [], queuedTasks: [] });
  worker = new WorkerWorkspace({ stateDir: state, projectDir: directory, pollMs: 1000, timeoutMs: 60000 }, journal, () => current);
  await worker.init();
  server = await statusServer(() => current, '127.0.0.1', 0, undefined, worker);
  let requests = 0; server.on('request', () => requests++);
  const base = 'http://127.0.0.1:' + testListeningAddress(server).port, tokenFile = join(state, 'webview-token');
  const command = (args, stdin) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['--input-type=module', '-e', 'import { main } from ' + JSON.stringify(entry) + "; await main('worker', process.argv.slice(1));", ...args, '--url', base, '--token-file', tokenFile, '--state-dir', state], { timeout: 15000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({ stdout, stderr });
    });
    // Bounded stdin rejection may close the pipe before the producer finishes.
    child.stdin.on('error', () => {}); child.stdin.end(stdin);
  });
  await worker.updateSettings({ board: { paused: true } });
  return { directory, state, worker, base, tokenFile, command, requests: () => requests };
}

const profile = ['version: "15"', 'agents:', '  root:', '    model: openai/fixture-model', '    instruction: Review acceptance criteria before proposing work.', ''].join('\n');
const revised = profile.replace('Review acceptance', 'Review risks and acceptance');
const failure = message => error => error.code === 2 && message.test(error.stderr) && error.stdout === '';
const run = async (f, args, stdin) => JSON.parse((await f.command(args, stdin)).stdout);

test('YAML profile files import with --name and update in place, keeping or changing the stored name', async t => {
  const f = await fixture(t), file = join(f.directory, 'lacforce.yaml'), upper = join(f.directory, 'LACFORCE.YML');
  // Editors and PowerShell prefix a UTF-8 BOM; it must not reach the YAML parser or the saved digest.
  await writeFile(file, String.fromCharCode(0xFEFF) + profile);
  assert.equal((await run(f, ['definition', 'preview', '--file', file])).agents[0].name, 'root');
  await assert.rejects(f.command(['definition', 'preview', '--file', file, '--name', 'x']), failure(/Unknown option --name/));
  const before = f.requests();
  await assert.rejects(f.command(['definition', 'import', '--file', file]), failure(/--name required when importing a YAML profile\./));
  assert.equal(f.requests(), before, 'the missing name is refused before any request');
  const imported = await run(f, ['definition', 'import', '--file', file, '--name', 'LAC Force']);
  assert.equal(imported.definitions.length, 1); assert.equal(imported.definitions[0].name, 'LAC Force');
  assert.equal((await run(f, ['definition', 'ref', '--id', imported.definitions[0].id, '--ref', 'lacforce'])).definitions[0].ref, 'lacforce');
  const stored = (await run(f, ['definition', 'list'])).definitions[0];
  await writeFile(upper, revised);
  const dryRun = await run(f, ['definition', 'update', '--ref', 'lacforce', '--file', upper, '--dry-run']);
  assert.equal(dryRun.definition.revision, stored.revision); assert.equal(dryRun.definition.name, 'LAC Force');
  assert.deepEqual(dryRun.changes.agents.changed, [{ name: 'root', fields: ['instruction'] }]); assert.equal(dryRun.changes.name, null);
  assert.equal((await run(f, ['definition', 'list'])).definitions[0].digest, stored.digest, 'dry run does not write');
  const applied = await run(f, ['definition', 'update', '--ref', 'lacforce', '--file', upper, '--if-match', stored.revision]);
  assert.equal(applied.definitions[0].id, stored.id); assert.equal(applied.definitions[0].name, 'LAC Force', 'no --name keeps the stored name');
  assert.notEqual(applied.definitions[0].digest, stored.digest);
  const renamed = await run(f, ['definition', 'update', '--ref', 'lacforce', '--file', file, '--name', 'LAC Force v2', '--if-match', applied.definitions[0].revision]);
  assert.equal(renamed.definitions[0].name, 'LAC Force v2'); assert.equal(renamed.definitions[0].digest, stored.digest);
});

test('--name combines with JSON input, conflicts with a JSON name, and JSON or stdin input is unchanged', async t => {
  const f = await fixture(t), file = join(f.directory, 'definition.json');
  await writeFile(file, JSON.stringify({ name: 'From JSON', yaml: profile }));
  const before = f.requests();
  await assert.rejects(f.command(['definition', 'import', '--file', file, '--name', 'Other']), failure(/Name given twice: --name and .{1,2}name.{1,2} in the --file JSON. Remove one/));
  await assert.rejects(f.command(['definition', 'update', '--ref', 'x', '--file', file, '--name', 'Other', '--dry-run']), failure(/Name given twice: --name and .{1,2}name.{1,2} in the --file JSON. Remove one/));
  assert.equal(f.requests(), before);
  assert.equal((await run(f, ['definition', 'import', '--file', file])).definitions[0].name, 'From JSON');
  await writeFile(file, JSON.stringify({ yaml: revised }));
  const named = await run(f, ['definition', 'import', '--file', file, '--name', 'From flag']);
  assert.deepEqual(named.definitions.map(item => item.name).sort(), ['From JSON', 'From flag']);
  assert.equal((await run(f, ['definition', 'preview', '--file', '-'], JSON.stringify({ yaml: profile }))).agents[0].name, 'root');
  await assert.rejects(f.command(['definition', 'preview', '--file', '-'], profile), failure(/Invalid JSON input/));
  await writeFile(join(f.directory, 'profile.txt'), profile);
  await assert.rejects(f.command(['definition', 'preview', '--file', join(f.directory, 'profile.txt')]), failure(/Invalid JSON input/));
});

test('YAML profile files keep the ordinary input size limit', async t => {
  const f = await fixture(t), file = join(f.directory, 'large.yaml'), before = f.requests();
  await writeFile(file, profile + '# ' + 'é'.repeat(40000) + '\n');
  await assert.rejects(f.command(['definition', 'preview', '--file', file]), failure(/Input limit: 64 KiB/));
  assert.equal(f.requests(), before);
});
