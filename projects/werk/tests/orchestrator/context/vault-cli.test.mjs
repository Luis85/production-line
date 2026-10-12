import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../../src/orchestrator/dist/orchestrator/server.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../../../src/orchestrator/dist/orchestrator/cli.js', import.meta.url));

test('headless intake accepts only project and vault reference, with stable retries', async () => {
  const adminToken = 'a'.repeat(48);
  const app = await startServer({db: ':memory:', host: '127.0.0.1', port: 0,
    adminToken, enrollmentToken: 'e'.repeat(48), project: 'demo'});
  const env = {...process.env, WERK_ADMIN_TOKEN: adminToken,
    WERK_URL: `http://127.0.0.1:${app.server.address().port}`};
  const args = ['task', 'create', '--project', 'demo', '--wikilink',
    '[[Features/Customer portal]]', '--key', 'vault-cli-feature'];
  try {
    const first = JSON.parse((await execute(process.execPath, [cli, ...args], {env})).stdout);
    const replay = JSON.parse((await execute(process.execPath, [cli, ...args], {env})).stdout);
    assert.equal(first.id, replay.id);
    assert.equal(first.requirementRef, '[[Features/Customer portal]]');
    assert.deepEqual(first.criteria, []);
    assert.equal(app.store.list().length, 1);
    const overview = JSON.parse((await execute(process.execPath, [cli, 'overview'], {env})).stdout);
    assert.equal(overview.tasks.queued, 1);
    for (const invalid of [
      ['task', 'create', '--key', 'bad', '--project', 'demo'],
      ['task', 'create', '--key', 'bad', '--wikilink', '[[Feature]]'],
      [...args, '--file', 'examples/task.json'],
      ['task', 'create', '--key', 'bad', '--project', 'demo', '--wikilink', '[[../secret]]'],
    ]) {
      await assert.rejects(execute(process.execPath, [cli, ...invalid], {env}), error => error.code === 2);
    }
    assert.equal(app.store.list().length, 1);
  } finally { await app.close(); }
});
