import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { statusServer } from '../../src/worker/dist/worker/status/server.js';
const entry = new URL('../../scripts/runtime/portable/cli.mjs', import.meta.url).href;

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-tool-access-cli-')));
  let journal, worker, server;
  t.after(async () => {
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    try { await worker?.close(); } finally { journal?.close(); await rm(directory, { recursive: true, force: true }); }
  });
  const state = join(directory, 'state'); await mkdir(state);
  journal = new SnapshotJournal(state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
  const current = { activeTasks: [], queuedTasks: [] };
  worker = new WorkerWorkspace({ stateDir: state, projectDir: directory, pollMs: 1000, timeoutMs: 60000 }, journal, () => current);
  await worker.init();
  server = await statusServer(() => current, '127.0.0.1', 0, undefined, worker);
  let requests = 0; server.on('request', () => requests++);
  const base = 'http://127.0.0.1:' + server.address().port, tokenFile = join(state, 'webview-token');
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

async function seedCatalogs(worker) {
  const mcp = ['docs', 'project'].map(id => ({ id, name: id, transport: 'http', enabled: true, command: '', args: [], url: 'https://mcp.example.test/' + id, secretEnv: '', secret: 'fixture-private-' + id, allowedTools: [] }));
  await worker.updateToolAccess({ expectedRevision: 0, builtins: worker.settings.toolPolicy().builtins, mcp });
  for (const connection of mcp) {
    const definitions = Array.from({ length: 9 }, (_, index) => ({ name: 'read_' + index, description: 'a'.repeat(4000), inputSchema: { type: 'object', properties: {}, additionalProperties: false } }));
    await worker.settings.discoveredTools(connection.id, worker.settings.toolPolicy().revision, definitions);
  }
  const view = worker.toolAccess();
  await worker.updateToolAccess({ expectedRevision: view.revision, builtins: view.builtins, mcp: view.mcp.map(({ discoveredTools, hasSecret, ...item }) => ({ ...item, allowedTools: ['read_0'] })) });
}

const rejection = (message, status) => error => error.code === 2 && message.test(error.stderr) && (status === undefined || JSON.parse(error.stderr).status === status) && error.stdout === '' && !error.stderr.includes('fixture-private-');

test('tool-access CLI round-trips large exported catalogs through file and stdin with secret and revision guards', async t => {
  const f = await fixture(t); await seedCatalogs(f.worker);
  const file = join(f.directory, 'tool-access.json');
  const exported = (await f.command(['tool-access', 'get'])).stdout;
  assert.ok(Buffer.byteLength(exported) > 65536, 'two valid discovered catalogs exceed the ordinary JSON input limit');
  assert.doesNotMatch(exported, /fixture-private-/);
  const original = f.worker.settings.toolPolicy(), view = JSON.parse(exported);
  view.builtins.files = true; await writeFile(file, JSON.stringify(view));
  const saved = JSON.parse((await f.command(['tool-access', 'set', '--file', file])).stdout);
  assert.equal(saved.revision, original.revision + 1); assert.equal(saved.builtins.files, true);
  assert.deepEqual(f.worker.settings.toolPolicy().mcp, original.mcp, 'redacted export preserves every existing MCP credential, destination, grant and catalog');
  assert.equal('cliTools' in JSON.parse(await readFile(join(f.state, 'tool-access.json'), 'utf8')).builtins, false, 'empty CLI tools remain absent on disk for rollback');
  await assert.rejects(f.command(['tool-access', 'set', '--file', file]), rejection(/Tool access changed/, 409));
  assert.equal(f.worker.settings.toolPolicy().revision, saved.revision);
  const stdinView = JSON.parse((await f.command(['tool-access', 'get'])).stdout); stdinView.builtins.files = false;
  const stdinSaved = JSON.parse((await f.command(['tool-access', 'set', '--file', '-'], JSON.stringify(stdinView))).stdout);
  assert.equal(stdinSaved.revision, saved.revision + 1); assert.equal(stdinSaved.builtins.files, false);
  assert.deepEqual(f.worker.settings.toolPolicy().mcp, original.mcp);
  stdinSaved.mcp[1].url = 'https://different.example.test/project';
  const changed = JSON.parse((await f.command(['tool-access', 'set', '--file', '-'], JSON.stringify(stdinSaved))).stdout);
  assert.equal(changed.mcp[0].hasSecret, true); assert.equal(changed.mcp[1].hasSecret, false);
  assert.deepEqual(f.worker.settings.toolPolicy().mcp[0], original.mcp[0]);
  assert.equal(f.worker.settings.toolPolicy().mcp[1].secret, '');
  assert.deepEqual(changed.mcp[1].allowedTools, []); assert.deepEqual(changed.mcp[1].discoveredTools, []);
});

test('tool-access imports retain bounded file/stdin reads, normalized writes and ordinary API input limits', async t => {
  const f = await fixture(t), file = join(f.directory, 'input.json');
  const before = f.requests();
  // Multi-byte text proves that both limits count bytes, not JavaScript characters.
  const tooLarge = JSON.stringify({ revision: 0, discoveredTools: 'é'.repeat(524288) });
  await writeFile(file, tooLarge);
  await assert.rejects(f.command(['tool-access', 'set', '--file', file]), rejection(/Input limit: 1024 KiB/));
  await assert.rejects(f.command(['tool-access', 'set', '--file', '-'], tooLarge), rejection(/Input limit: 1024 KiB/));
  const largeUpdate = JSON.stringify({ expectedRevision: 0, builtins: f.worker.toolAccess().builtins, mcp: [], extra: 'é'.repeat(32768) });
  await writeFile(file, largeUpdate);
  await assert.rejects(f.command(['tool-access', 'set', '--file', file]), rejection(/update limit: 64 KiB/));
  await assert.rejects(f.command(['tool-access', 'set', '--file', '-'], largeUpdate), rejection(/update limit: 64 KiB/));
  await assert.rejects(f.command(['settings', 'set', '--file', file]), rejection(/Input limit: 64 KiB/));
  await assert.rejects(f.command(['settings', 'set', '--file', '-'], largeUpdate), rejection(/Input limit: 64 KiB/));
  assert.equal(f.requests(), before, 'oversized import and normalized bodies never reach the server');
  const token = (await readFile(f.tokenFile, 'utf8')).trim();
  const response = await fetch(f.base + '/api/tool-access', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: largeUpdate });
  assert.equal(response.status, 413); assert.match((await response.json()).error, /Body limit: 64 KiB/);
  assert.equal(f.worker.settings.toolPolicy().revision, 0, 'all rejection paths leave the saved policy unchanged');
});
