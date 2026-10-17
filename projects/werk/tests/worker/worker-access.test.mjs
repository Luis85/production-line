import { workerStatus } from '../helpers/worker-status.mjs';
import { testListeningAddress } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WorkerAccess } from '../../src/worker/dist/worker/status/access.js';
import { json, rejectRequest } from '../../src/worker/dist/shared/http/server.js';
import { ApiError, httpStatus } from '../../src/worker/dist/shared/http/errors.js';
const operatorToken = 'a'.repeat(64);
async function fixture(t, now, backendPort) {
  let access = new WorkerAccess(token => { if (token !== operatorToken) throw new ApiError(401, 'Incorrect worker token'); }, now);
  const server = createServer(async (req, res) => {
    if (backendPort) Object.defineProperty(req.socket, 'localPort', { value: backendPort, configurable: true });
    try { if (await access.route(req, res)) return; access.authenticate(req); json(res, 200, { private: 'worker data' }); }
    catch (error) { const status = httpStatus(error); rejectRequest(req, res, status); json(res, status, { error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${testListeningAddress(server).port}`;
  const headers = { 'content-type': 'application/json', 'x-werk-request': 'webview', origin: base };
  return { base, headers, restart() { access = new WorkerAccess(token => { if (token !== operatorToken) throw new ApiError(401, 'Incorrect worker token'); }, now); }, login: (extra = {}) => fetch(base + '/api/access', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ token: operatorToken }) }) };
}
test('worker access exchanges operator token for independent HttpOnly session; reload works and logout revokes', async t => {
  const { base, headers, login } = await fixture(t);
  assert.deepEqual(await (await fetch(base + '/api/access')).json(), { authenticated: false });
  assert.equal((await fetch(base + '/api/history')).status, 401);
  const response = await login(); assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /Path=\/api; HttpOnly; SameSite=Strict; Max-Age=43200/);
  assert.doesNotMatch(setCookie, new RegExp(operatorToken));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const cookie = setCookie.split(';')[0];
  assert.equal((await (await fetch(base + '/api/access', { headers: { ...headers, cookie } })).json()).authenticated, true);
  assert.equal((await fetch(base + '/api/history', { headers: { ...headers, cookie } })).status, 200);
  const loggedOut = await fetch(base + '/api/access', { method: 'DELETE', headers: { ...headers, cookie } });
  assert.match(loggedOut.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(base + '/api/history', { headers: { ...headers, cookie } })).status, 401);
});
test('cookie access rejects CSRF including cross-port same-site origins and malformed bearer never falls back', async t => {
  const { base, headers, login } = await fixture(t);
  const cookie = (await login()).headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/api/settings', { headers: { cookie } })).status, 403);
  assert.equal((await fetch(base + '/api/settings', { headers: { ...headers, cookie, origin: 'http://127.0.0.1:1' } })).status, 403);
  assert.equal((await fetch(base + '/api/settings', { headers: { ...headers, cookie, 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(base + '/api/settings', { headers: { ...headers, cookie, authorization: 'Basic invalid' } })).status, 401);
  assert.equal((await fetch(base + '/api/settings', { headers: { authorization: `Bearer ${operatorToken}` } })).status, 200);
  assert.equal((await fetch(base + '/api/access', { method: 'POST', headers: { 'content-type': 'application/json', 'x-werk-request': 'webview' }, body: JSON.stringify({ token: operatorToken }) })).status, 403);
  assert.equal((await fetch(base + '/api/access', { method: 'DELETE', headers: { cookie, origin: base } })).status, 403);
});
test('sessions expire, restart revokes them, re-login rotates them, and workers do not share session authority', async t => {
  let now = Date.now(); const worker = await fixture(t, () => now), other = await fixture(t, () => now);
  let cookie = (await worker.login()).headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(other.base + '/api/history', { headers: { ...other.headers, cookie } })).status, 401);
  const rotated = (await worker.login({ cookie })).headers.get('set-cookie').split(';')[0];
  assert.notEqual(rotated, cookie);
  assert.equal((await fetch(worker.base + '/api/history', { headers: { ...worker.headers, cookie } })).status, 401);
  cookie = rotated; now += 12 * 60 * 60 * 1000;
  assert.equal((await fetch(worker.base + '/api/history', { headers: { ...worker.headers, cookie } })).status, 401);
  cookie = (await worker.login()).headers.get('set-cookie').split(';')[0]; worker.restart();
  assert.deepEqual(await (await fetch(worker.base + '/api/access', { headers: { ...worker.headers, cookie } })).json(), { authenticated: false });
  assert.equal((await fetch(worker.base + '/api/history', { headers: { ...worker.headers, cookie } })).status, 401);
});
test('login input is bounded and failed attempts are throttled without leaking the token', async t => {
  let now = Date.now(); const { base, headers, login } = await fixture(t, () => now);
  assert.equal((await fetch(base + '/api/access', { method: 'POST', headers, body: JSON.stringify({ token: operatorToken, extra: true }) })).status, 400);
  assert.equal((await fetch(base + '/api/access', { method: 'POST', headers, body: 'a'.repeat(70_000) })).status, 413);
  for (let index = 0; index < 20; index++) assert.equal((await fetch(base + '/api/access', { method: 'POST', headers, body: JSON.stringify({ token: 'wrong' }) })).status, 401);
  const blocked = await login(); assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('retry-after'), '60');
  now += 60_001; assert.equal((await login()).status, 200);
});

test('worker status server routes browser access and provider checks through the authenticated boundary', async t => {
  const { statusServer } = await import('../../src/worker/dist/worker/status/server.js');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { WorkerWorkspace } = await import('../../src/worker/dist/worker/status/workspace.js');
  const { SnapshotJournal } = await import('../../src/worker/dist/worker/infrastructure/journal/snapshots.js');
  const directory = await mkdtemp(join(tmpdir(), 'werk-access-boundary-'));
  const journal = new SnapshotJournal(directory, 'a'.repeat(64), 'b'.repeat(64));
  await journal.init();
  const workspace = new WorkerWorkspace({ stateDir: directory, pollMs: 1000, timeoutMs: 60000 }, journal, workerStatus);
  await workspace.init();
  const operatorToken = (await readFile(join(directory, 'webview-token'), 'utf8')).trim();
  const server = await statusServer(() => workerStatus(), '127.0.0.1', 0, undefined, workspace);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await workspace.close();
    journal.close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${testListeningAddress(server).port}`, headers = { 'content-type': 'application/json', 'x-werk-request': 'webview', origin: base };
  const response = await fetch(base + '/api/access', { method: 'POST', headers, body: JSON.stringify({ token: operatorToken }) }); assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.deepEqual(await (await fetch(base + '/api/settings', { headers: { ...headers, cookie } })).json(), workspace.settings.publicView());
  assert.deepEqual(await (await fetch(base + '/api/definitions', { headers: { ...headers, cookie } })).json(), workspace.definitions.view());
  const check = { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ id: 'openai-api' }) };
  assert.equal((await (await fetch(base + '/api/providers/check', check)).json()).authentication, 'not-verified');
  assert.equal((await fetch(base + '/api/providers/check', { ...check, headers })).status, 401);
  assert.equal((await fetch(base + '/api/providers/check', { ...check, body: JSON.stringify({ id: 'openai-api', command: 'arbitrary' }) })).status, 400);
});

test('separate worker instances sharing a proxy backend port use independent cookie names', async t => {
  const first = await fixture(t, undefined, 3002), second = await fixture(t, undefined, 3002);
  const a = (await first.login()).headers.get('set-cookie').split(';')[0];
  const b = (await second.login()).headers.get('set-cookie').split(';')[0];
  assert.match(a, /^werk_worker_3002_/); assert.match(b, /^werk_worker_3002_/);
  assert.notEqual(a.split('=')[0], b.split('=')[0]);
  const cookie = a + '; ' + b;
  assert.equal((await fetch(first.base + '/api/history', { headers: { ...first.headers, cookie } })).status, 200);
  assert.equal((await fetch(second.base + '/api/history', { headers: { ...second.headers, cookie } })).status, 200);
});
