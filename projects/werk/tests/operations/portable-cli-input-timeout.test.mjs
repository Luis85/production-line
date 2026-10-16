import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commands } from '../../scripts/runtime/portable/commands.mjs';
import { request, RequestTimeoutError, DEFAULT_REQUEST_TIMEOUT_MS } from '../../src/worker/dist/shared/http/client.js';

const entry = new URL('../../scripts/runtime/portable/cli.mjs', import.meta.url).href;
const bom = Buffer.from([0xef, 0xbb, 0xbf]);
function run(args, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import { main } from ${JSON.stringify(entry)}; await main('worker', process.argv.slice(1));`, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 20000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(stdin ?? '');
  });
}
async function fixture(t, delayMs = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-cli-input-')), tokenPath = join(directory, 'token');
  await writeFile(tokenPath, 'labelled-local-transport-fixture-token', { mode: 0o600 });
  const calls = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url, body: raw ? JSON.parse(raw) : undefined });
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    if (res.destroyed) return;
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ schemaVersion: 1, revision: 4 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const client = ['--url', `http://127.0.0.1:${server.address().port}`, '--token-file', tokenPath, '--state-dir', join(directory, 'state')];
  return { directory, calls, client };
}
const configure = { expectedRevision: 3, config: { enabled: true, repositoryId: 'local-project', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 60000 } };

test('JSON input accepts a UTF-8 BOM from files and from Windows PowerShell 5.1 stdin', async t => {
  const f = await fixture(t);
  const file = join(f.directory, 'intake.json');
  await writeFile(file, Buffer.concat([bom, Buffer.from(JSON.stringify(configure))]));
  const fromFile = await run(['shared', 'configure', '--file', file, ...f.client]);
  assert.equal(fromFile.code, 0, fromFile.stderr);
  assert.deepEqual(f.calls.at(-1).body, { action: 'configure', ...configure });
  const fromStdin = await run(['shared', 'configure', '--file', '-', ...f.client], Buffer.concat([bom, Buffer.from(JSON.stringify(configure) + '\r\n')]));
  assert.equal(fromStdin.code, 0, fromStdin.stderr);
  assert.deepEqual(f.calls.at(-1).body, { action: 'configure', ...configure });
  // Only one leading mark is removed; anything else stays invalid JSON.
  const doubled = await run(['shared', 'configure', '--file', '-', ...f.client], Buffer.concat([bom, bom, Buffer.from(JSON.stringify(configure))]));
  assert.equal(doubled.code, 2);
  assert.match(doubled.stderr, /Invalid JSON input/);
});

test('API waits time out with an actionable message that the operation may still be running', async t => {
  const f = await fixture(t, 1500);
  const slow = await run(['shared', 'sync', '--request-timeout-ms', '1000', ...f.client]);
  assert.equal(slow.code, 1);
  const error = JSON.parse(slow.stderr.trim().split('\n').at(-1));
  assert.equal(error.code, 'timeout');
  assert.match(error.error, /No response within 1 s\. The operation may still be running on the server; inspect its status before retrying\./);
  assert.equal(f.calls.length, 1);
  const patient = await run(['shared', 'sync', '--request-timeout-ms', '5000', ...f.client]);
  assert.equal(patient.code, 0, patient.stderr);
  const invalid = await run(['shared', 'sync', '--request-timeout-ms', '50', ...f.client]);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /request-timeout-ms/);
  assert.equal(f.calls.length, 2);
});

test('Git-backed worker commands wait longer than ordinary API calls', () => {
  const catalog = commands('worker');
  for (const name of ['shared sync', 'shared configure', 'repository sync']) assert.ok(catalog[name].timeoutMs >= 60000, name);
  for (const name of ['shared status', 'repository status', 'settings get']) assert.equal(catalog[name].timeoutMs, undefined, name);
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 10000);
});

test('the shared HTTP client reports its own timeout instead of a raw abort', async t => {
  const f = await fixture(t, 400);
  const base = f.client[1];
  await assert.rejects(request(base, '/api/shared-intake', 'token', 'GET', undefined, undefined, 100), error => error instanceof RequestTimeoutError && error.code === 'timeout' && error.timeoutMs === 100 && /request may still be running/.test(error.message));
  assert.deepEqual(await request(base, '/api/shared-intake', 'token', 'GET', undefined, undefined, 2000), { schemaVersion: 1, revision: 4 });
});
