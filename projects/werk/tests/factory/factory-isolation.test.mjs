import test from 'node:test';
import assert from 'node:assert/strict';
import { startFactoryServer } from '../../src/factory/dist/factory/server.js';
import { startServer } from '../../src/orchestrator/dist/orchestrator/server.js';

test('factory scopes two real production lines without sharing tasks, credentials or lifecycle', async () => {
  const adminA = 'a'.repeat(48), adminB = 'b'.repeat(48), factoryToken = 'f'.repeat(48);
  let a, b, factory;
  const origin = app => `http://127.0.0.1:${app.server.address().port}`;
  try {
    a = await startServer({db: ':memory:', host: '127.0.0.1', port: 0,
      project: 'demo', adminToken: adminA, enrollmentToken: 'c'.repeat(48)});
    b = await startServer({db: ':memory:', host: '127.0.0.1', port: 0,
      project: 'demo', adminToken: adminB, enrollmentToken: 'd'.repeat(48)});
    const urlA = origin(a), urlB = origin(b);
    const profiles = [{id: 'claude', provider: 'claude', mode: 'mock', maxParallel: 1}];
    const identityA = a.store.register('demo', profiles);
    const identityB = b.store.register('demo', profiles);
    const taskA = a.store.submit({project: 'demo', requirementRef: '[[Features/Alpha]]'}, 'same-key');
    const taskB = b.store.submit({project: 'demo', requirementRef: '[[Features/Beta]]'}, 'same-key');
    assert.notEqual(taskA.id, taskB.id);
    assert.equal(a.store.claim(a.store.worker(identityA.token)).id, taskA.id);
    assert.equal(b.store.claim(b.store.worker(identityB.token)).id, taskB.id);
    const rejected = await fetch(urlB + '/v1/worker/assignments/current', {
      headers: {Authorization: `Bearer ${identityA.token}`},
    });
    assert.equal(rejected.status, 401);

    factory = await startFactoryServer({db: ':memory:', host: '127.0.0.1', port: 0,
      adminToken: factoryToken, credentials: {WERK_LINE_ALPHA_TOKEN: adminA, WERK_LINE_BETA_TOKEN: adminB},
      pollTimeoutMs: 1000, pollConcurrency: 2});
    async function api(path, method = 'GET', body) {
      const response = await fetch(origin(factory) + path, {method,
        headers: {Authorization: `Bearer ${factoryToken}`, 'Content-Type': 'application/json'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)})});
      const value = await response.json();
      assert.ok(response.ok, JSON.stringify(value));
      return value;
    }
    await api('/v1/factories', 'POST', {id: 'root', name: 'Werk'});
    await api('/v1/factories', 'POST', {id: 'child', name: 'Product team', parentId: 'root'});
    for (const [id, factoryId, url, tokenEnv] of [
      ['alpha', 'root', urlA, 'WERK_LINE_ALPHA_TOKEN'],
      ['beta', 'child', urlB, 'WERK_LINE_BETA_TOKEN'],
    ]) await api('/v1/lines', 'POST', {id, name: id, factoryId,
      orchestratorUrl: url, webviewUrl: url, tokenEnv});
    const all = await api('/v1/overview?factoryId=root');
    assert.equal(all.totals.lines, 2);
    assert.equal(all.totals.tasks.running, 2);
    assert.equal(all.totals.workers.total, 2);
    assert.equal(all.totals.partial, false);
    assert.equal(all.totals.cost.amountUsd, null);
    assert.ok(!JSON.stringify(all).includes(adminA));
    const child = await api('/v1/overview?factoryId=child');
    assert.deepEqual(child.lines.map(item => item.line.id), ['beta']);
    assert.equal(child.totals.tasks.running, 1);

    await b.close(); b = undefined;
    const partial = await api('/v1/overview?factoryId=root');
    assert.equal(partial.totals.partial, true);
    assert.equal(partial.totals.availableLines, 1);
    assert.equal(partial.totals.tasks.running, 1);
    assert.equal(partial.lines.find(item => item.line.id === 'beta').overview, null);
    await api('/v1/lines/alpha', 'DELETE');
    assert.equal((await fetch(urlA + '/healthz')).status, 200);
    assert.equal(a.store.get(taskA.id).status, 'running');
  } finally {
    await factory?.close(); await a?.close(); await b?.close();
  }
});
