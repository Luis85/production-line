import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { buildInfoModule } from '../../scripts/build-info.mjs';
import { buildInfo as sourceInfo } from '../../src/shared/build-info.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'build-provenance-test', version: '1' } } };

test('build metadata is deterministic, validated and source execution is explicitly unversioned', async () => {
  const code = buildInfoModule({ version: '2.3.4-rc.1', private: true, secret: 'must not embed' });
  assert.equal(code, buildInfoModule({ version: '2.3.4-rc.1' }));
  assert.ok(!code.includes('must not embed'));
  const { buildInfo } = await import('data:text/javascript,' + encodeURIComponent(code));
  assert.deepEqual(buildInfo, { version: '2.3.4-rc.1' });
  assert.equal(Object.isFrozen(buildInfo), true);
  assert.deepEqual(sourceInfo, { version: 'development' });
  for (const value of [{}, {version: undefined}, {version: 7}, {version: 'development'}, {version: "1.0.0'; throw Error('bad')"}]) assert.throws(() => buildInfoModule(value));
});

test('every built and portable app carries its release version and MCP reports that artifact version', async () => {
  const expected = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  for (const app of ['factory', 'orchestrator', 'worker']) {
    const dist = join(root, 'src', app, 'dist'), portable = join(root, 'bin/apps', app);
    for (const [directory, compiled] of [[dist, dist], [portable, join(portable, 'src', app, 'dist')]]) {
      const packageInfo = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      const { buildInfo } = await import(pathToFileURL(join(compiled, 'shared/build-info.js')).href);
      assert.equal(buildInfo.version, expected, directory);
      assert.equal(packageInfo.version, expected, directory);
      assert.equal(JSON.parse(await readFile(join(compiled, 'package.json'), 'utf8')).version, expected, compiled);
      // Worker consumes build provenance through snapshots; only Factory and line expose MCP servers.
      if (app === 'worker') continue;
      const { serveStdio } = await import(pathToFileURL(join(compiled, 'shared/mcp/stdio.js')).href);
      let output = '';
      await serveStdio({}, app, Readable.from([Buffer.from(JSON.stringify(initialize) + '\n')]), new Writable({ write(chunk, encoding, callback) { output += chunk; callback(); } }));
      const response = JSON.parse(output);
      assert.deepEqual(response.result.serverInfo, { name: 'werk-' + app, version: expected }, directory);
    }
  }
});

test('new snapshot evidence uses the built worker version without rewriting historical evidence', async () => {
  const expected = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  const { SnapshotJournal } = await import('../../src/worker/dist/worker/infrastructure/journal/snapshots.js');
  const directory = await mkdtemp(join(tmpdir(), 'werk-version-'));
  const journal = new SnapshotJournal(directory, 'config', 'prompt');
  try {
    const task = { id: 'task', project: 'demo', title: 'Version', criteria: ['Recorded'], provider: 'auto', status: 'running', attempt: 1, lease: 'lease' };
    const profile = { id: 'mock', provider: 'codex', mode: 'mock' };
    const snapshot = journal.capture(task, 'worker', profile, { lastContact: null, heartbeatErrors: 0 }, 'before');
    assert.equal(snapshot.runtime.workerVersion, expected);
    const historical = structuredClone(snapshot);
    historical.runtime.workerVersion = '0.1.0';
    const { validateSnapshot } = await import('../../src/worker/dist/shared/snapshots.js');
    assert.equal(validateSnapshot(historical).runtime.workerVersion, '0.1.0');
  } finally { journal.close(); await rm(directory, { recursive: true, force: true }); }
});
