import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setupSharedIntake } from '../../scripts/runtime/portable/shared-setup.mjs';
import { testListeningAddress } from '../helpers/typed-boundaries.mjs';

const discoveryId = 'a'.repeat(64);
const input = () => ({ expectedRevision: 0, repositoryId: 'project', provider: { id: 'claude-cli' }, intake: { remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 5000 }, resume: true });
/** @param {{busy?: boolean, signedOut?: boolean, workflowError?: boolean, resumeTimeout?: boolean}} [options] */
function fixture(options = {}) {
  /** @type {{method: string, path: string, body?: unknown}[]} */
  const calls = [];
  let paused = false, revision = 0;
  const workflow = { requestsDirectory: 'requests/features', reviewDirectory: 'reviews', tasksDirectory: 'tasks' };
  const discovery = { id: discoveryId, path: '/project', decision: 'pending', repositoryId: undefined };
  /** @type {import('../../scripts/runtime/portable/shared-setup.mjs').SetupCall} */
  const call = async (method, path, body) => {
    calls.push({ method, path, body });
    const data = body && typeof body === 'object' ? body : {};
    if (method === 'GET' && path === '/api/shared-intake') return { revision, canEdit: paused && !options.busy, blockedReason: options.busy ? 'Finish queued work.' : null };
    if (method === 'GET' && path === '/api/repositories') return { items: [{ id: 'project', path: '/project' }], discovery };
    if (method === 'GET' && path === '/api/settings') return { board: { paused }, providers: [{ id: 'claude-cli', executable: '/tools/claude' }] };
    if (method === 'GET' && path === '/api/tool-access') return { revision: 0 };
    if (path === '/api/settings') {
      if ('board' in data) {
        const board = data.board;
        assert.ok(board && typeof board === 'object' && 'paused' in board && typeof board.paused === 'boolean');
        paused = board.paused;
        if (!paused && options.resumeTimeout) throw Error('Operation may still be running.');
      }
      return { board: { paused } };
    }
    if (path === '/api/providers/check') return { available: true, authentication: options.signedOut ? 'signed-out' : 'authenticated', message: 'Sign in as the worker account.' };
    assert.equal(paused, true, 'Repository, grants, binding and first synchronization must stay paused');
    if (path === '/api/repositories') {
      assert.deepEqual(data, { action: 'accept', discoveryId });
      return { discovery: { ...discovery, decision: 'accepted', repositoryId: 'accepted-project' } };
    }
    if (path === '/api/tool-access') return { revision: 1 };
    if (path === '/api/shared-intake' && 'action' in data && data.action === 'configure') { revision++; return { revision }; }
    if (path === '/api/shared-intake' && 'action' in data && data.action === 'sync') return { revision, workflow: options.workflowError ? null : workflow, error: options.workflowError ? 'Workflow is not committed.' : null };
    throw Error('Unexpected setup call');
  };
  return { call, calls, paused: () => paused };
}

test('setup preview performs only reads and never reveals supplied MCP credentials', async () => {
  const f = fixture();
  const result = await setupSharedIntake({ ...input(), toolAccess: { expectedRevision: 0, builtins: { files: true, commands: [], webOrigins: [] }, mcp: [{ secret: 'private-fixture-secret' }] } }, f.call, { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.ok(f.calls.every(item => item.method === 'GET'));
  assert.equal(f.paused(), false);
  assert.doesNotMatch(JSON.stringify(result), /private-fixture-secret/);
  assert.ok(result.operations.includes('tool_access'));
});

test('setup reuses assigned repositories, preserves omitted grants and synchronizes before explicit resume', async () => {
  const f = fixture();
  const result = await setupSharedIntake(input(), f.call);
  assert.equal(result.dryRun, false);
  assert.equal('configured' in result && result.configured, true);
  assert.equal(f.paused(), false);
  assert.equal(result.intake.repositoryId, 'project');
  const writes = f.calls.filter(item => item.method === 'POST');
  assert.deepEqual(writes.map(item => item.path), ['/api/settings', '/api/providers/check', '/api/shared-intake', '/api/shared-intake', '/api/settings']);
  assert.deepEqual(writes.at(-1).body, { board: { paused: false } });
});

test('setup accepts only an explicitly inspected discovery and supports remaining paused', async () => {
  const f = fixture(), { repositoryId: _, ...body } = input();
  const result = await setupSharedIntake({ ...body, discoveryId, resume: false }, f.call);
  assert.equal(result.intake.repositoryId, 'accepted-project');
  assert.equal(result.repository.id, 'accepted-project');
  assert.equal(f.paused(), true);
  assert.equal(f.calls.filter(item => item.path === '/api/repositories' && item.method === 'POST').length, 1);
});

test('setup rejects ambiguous consent and stale guards before mutations', async () => {
  for (const bad of [
    { ...input(), discoveryId }, { ...input(), repositoryId: undefined },
    { ...input(), expectedRevision: 1 }, { ...input(), repositoryId: 'absent' },
    { ...input(), repositoryId: undefined, discoveryId: 'b'.repeat(64) },
    { ...input(), toolAccess: { expectedRevision: 1, builtins: {}, mcp: [] } },
    { ...input(), resume: undefined }, { ...input(), provider: { id: 'openai-api' } },
  ]) {
    const f = fixture();
    await assert.rejects(setupSharedIntake(bad, f.call));
    assert.ok(f.calls.every(item => item.method === 'GET'));
  }
});

test('busy work and failed local login stop setup before binding or any resume', async () => {
  for (const options of [{ busy: true }, { signedOut: true }]) {
    const f = fixture(options);
    await assert.rejects(setupSharedIntake(input(), f.call), /New starts remain paused/);
    assert.equal(f.paused(), true);
    assert.equal(f.calls.some(item => item.path === '/api/shared-intake' && item.method === 'POST'), false);
  }
});

test('failed committed workflow checks retain the binding and never retry or resume', async () => {
  const f = fixture({ workflowError: true });
  await assert.rejects(setupSharedIntake(input(), f.call), /shared_sync: Workflow is not committed.*New starts remain paused.*earlier writes are retained/);
  assert.equal(f.paused(), true);
  assert.equal(f.calls.filter(item => item.path === '/api/shared-intake' && item.method === 'POST').length, 2);
});

test('setup distinguishes transport failures from rejected input without replaying a failed write', async () => {
  for (const [failure, exitCode] of [
    [Object.assign(Error('Timed out'), { exitCode: 1 }), 1],
    [Object.assign(Error('Revision changed'), { status: 409 }), 2],
    [Object.assign(Error('Service unavailable'), { status: 503 }), 1],
    [Object.assign(Error('Invalid settings'), { exitCode: 2 }), 2],
  ]) {
    const f = fixture();
    let writes = 0;
    await assert.rejects(setupSharedIntake(input(), async (method, path, body) => {
      if (method === 'POST' && path === '/api/shared-intake') { writes++; throw failure; }
      return f.call(method, path, body);
    }), error => {
      assert.ok(error instanceof Error && 'exitCode' in error);
      assert.equal(error.exitCode, exitCode);
      assert.equal(error.cause, failure);
      assert.match(error.message, /New starts remain paused/);
      return true;
    });
    assert.equal(writes, 1);
  }
});

test('ambiguous resume acknowledgement reports uncertainty instead of claiming the queue stayed paused', async () => {
  const f = fixture({ resumeTimeout: true });
  await assert.rejects(setupSharedIntake(input(), f.call), /resume:.*Pause state is unconfirmed/);
  assert.equal(f.paused(), false);
  assert.equal(f.calls.filter(item => item.method === 'POST' && item.path === '/api/settings').length, 2);
});

test('explicit provider and tool updates use existing API bodies without granting any additional access', async () => {
  const f = fixture(), tools = { expectedRevision: 0, builtins: { files: true, commands: [], webOrigins: [] }, mcp: [] };
  await setupSharedIntake({ ...input(), provider: { id: 'claude-cli', executable: process.execPath, model: 'selected' }, toolAccess: tools }, f.call);
  assert.deepEqual(f.calls.find(item => item.path === '/api/tool-access' && item.method === 'POST').body, tools);
  assert.deepEqual(f.calls.find(item => item.method === 'POST' && item.path === '/api/settings' && item.body && typeof item.body === 'object' && 'provider' in item.body).body, { provider: { id: 'claude-cli', executable: process.execPath, model: 'selected' } });
});

test('portable CLI forwards private setup input through authenticated APIs and honors dry run', async t => {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), 'werk-shared-setup-cli-'));
  const token = 'c'.repeat(64), tokenFile = join(directory, 'token'), file = join(directory, 'setup.json');
  await writeFile(tokenFile, token, { mode: 0o600 }); await writeFile(file, JSON.stringify(input()));
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + token);
    let raw = ''; for await (const chunk of req) raw += chunk;
    try { const value = await f.call(req.method ?? 'GET', req.url ?? '/', raw ? JSON.parse(raw) : undefined); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); }
    catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Failed' })); }
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const entry = new URL('../../scripts/runtime/portable/cli.mjs', import.meta.url).href;
  const run = async (...extra) => {
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', 'import { main } from ' + JSON.stringify(entry) + "; await main('worker', process.argv.slice(1));", 'shared', 'setup', '--file', file, '--url', 'http://127.0.0.1:' + testListeningAddress(server).port, '--token-file', tokenFile, '--state-dir', join(directory, 'state'), ...extra], { timeout: 20000 });
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
    return JSON.parse(result.stdout);
  };
  assert.equal((await run('--dry-run')).dryRun, true);
  assert.ok(f.calls.every(item => item.method === 'GET'));
  assert.equal((await run()).configured, true);
  assert.equal(f.paused(), false);
});
