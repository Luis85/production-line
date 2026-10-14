import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

test('packaged launcher preserves independent commands alongside managed system updates', async t => {
  const root = await mkdtemp(join(tmpdir(), 'werk launcher dispatch '));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(path, content) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await put('werk.mjs', await readFile(new URL('../../werk.mjs', import.meta.url)));
  await put('package.json', '{"type":"module"}');
  await put('release-manifest.json', '{"name":"werk","version":"0.2.0"}');
  for (const kind of ['worker', 'orchestrator', 'factory']) {
    await put(`src/${kind}/dist/${kind}/cli.js`, `console.log(JSON.stringify({kind:'${kind}',args:process.argv.slice(2)}));`);
  }
  await put('scripts/runtime/component.mjs', 'export async function runComponent(kind,args) { console.log(JSON.stringify({kind,args})); }');
  await put('scripts/runtime/update/launcher.mjs', 'export async function runNative(root,args) { console.log(JSON.stringify({kind:"managed",args})); return 0; }');
  await put('scripts/runtime/update/cli.mjs', 'export async function main(args) { console.log(JSON.stringify({kind:"update",args})); return 0; }');
  await put('scripts/runtime/cli.mjs', 'export async function main(args) { console.log(JSON.stringify({kind:"external",args})); return 0; }');
  function run(args, environment = {}) {
    const result = spawnSync(process.execPath, [join(root, 'werk.mjs'), ...args], {
      cwd: root, env: { ...process.env, WERK_UPDATES: '', ...environment }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  for (const kind of ['worker', 'orchestrator', 'factory']) {
    assert.deepEqual(run([kind, '--help']), { kind, args: ['--help'] });
    const portFlag = kind === 'worker' ? '--status-port' : '--port';
    assert.deepEqual(run([kind, 'run', '--state-dir', 'private state', portFlag, '0']), {
      kind, args: [...(kind === 'worker' ? ['run'] : []), '--state-dir', 'private state', portFlag, '0'],
    });
  }
  assert.deepEqual(run(['up', '--no-open']), { kind: 'managed', args: ['up', '--no-open'] });
  assert.deepEqual(run(['system', 'status', '--json']), { kind: 'managed', args: ['system', 'status', '--json'] });
  assert.deepEqual(run(['update', 'status', '--line']), { kind: 'update', args: ['status', '--line'] });
  assert.deepEqual(run(['start', '--no-update'], { WERK_UPDATES: 'external' }), { kind: 'external', args: ['start'] });
});
