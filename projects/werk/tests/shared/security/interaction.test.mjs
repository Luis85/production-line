import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { interactWithWorker } from '../../../src/orchestrator/dist/orchestrator/infrastructure/interaction.js';
import { DomainError } from '../../../src/orchestrator/dist/shared/errors.js';

async function fixture(t) {
  const requests = []; let selected = 'original', worker = 'registered', reject = false;
  const credential = 'private-worker-fixture-token';
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, method: req.method, body: raw ? JSON.parse(raw) : undefined });
    assert.equal(req.headers.authorization, 'Bearer ' + credential);
    res.setHeader('content-type', 'application/json');
    if (reject) { res.writeHead(401); res.end(JSON.stringify({ error: credential })); return; }
    const sessions = () => ({ selected, records: [{ id: selected, title: selected === 'created' ? 'New task' : 'Original task', provider: 'claude-cli' }] });
    let value;
    if (req.url === '/status') value = { workerId: worker };
    else if (req.url === '/api/chat/session') value = { sessions: sessions(), chat: { messages: [], available: true, busy: false, phase: 'idle' } };
    else if (req.url === '/api/sessions') { selected = 'created'; value = sessions(); }
    else value = { messages: [], busy: false };
    res.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { requests, call: input => interactWithWorker({ workerUrl: 'http://127.0.0.1:' + server.address().port, workerToken: credential, ...input }, id => { if (id !== 'registered') throw new DomainError('not_found', 'Worker not registered in this line'); }), foreign: () => { worker = 'foreign'; }, reject: () => { reject = true; }, credential };
}

test('New task uses the selected provider and returns the worker atomic task/session view', async t => {
  const f = await fixture(t);
  const result = await f.call({ action: 'new', sessionId: 'original' });
  assert.equal(result.workerId, 'registered'); assert.equal(result.sessions.selected, 'created');
  assert.equal(result.sessions.records[0].title, 'New task'); assert.deepEqual(result.chat.messages, []);
  assert.deepEqual(f.requests.map(item => item.path), ['/status', '/api/chat/session', '/api/sessions', '/api/chat/session']);
  assert.deepEqual(f.requests[2].body, { action: 'create', title: 'New task', provider: 'claude-cli' });
  assert.ok(!JSON.stringify(result).includes(f.credential));
  await f.call({ action: 'send', sessionId: 'created', message: 'First task message' });
  await f.call({ action: 'send', sessionId: 'created', message: 'Follow up on the same task' });
  assert.deepEqual(f.requests.filter(item => item.path === '/api/chat').map(item => item.body.sessionId), ['created', 'created']);
});

test('New task holds worker and selected-session boundaries before creating anything', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call({ action: 'new', sessionId: 'stale' }), error => error.code === 'conflict');
  assert.equal(f.requests.some(item => item.method === 'POST'), false);
  f.requests.length = 0; f.foreign();
  await assert.rejects(f.call({ action: 'new', sessionId: 'original' }), error => error.code === 'not_found');
  assert.deepEqual(f.requests.map(item => item.path), ['/status']);
  f.requests.length = 0;
  await assert.rejects(f.call({ action: ['new'], sessionId: 'original' }), error => error.code === 'invalid_input');
  assert.equal(f.requests.length, 0);
});

test('upstream rejection hides private response bodies and creates no retry mutation', async t => {
  const f = await fixture(t); f.reject();
  await assert.rejects(f.call({ action: 'new', sessionId: 'original' }), error => error.code === 'unavailable' && !error.message.includes(f.credential));
  assert.equal(f.requests.length, 1);
});
