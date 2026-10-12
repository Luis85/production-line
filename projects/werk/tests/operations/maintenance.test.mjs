import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, link, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomInt } from 'node:crypto';
import { tmpdir } from 'node:os';
import { setup } from '../../scripts/runtime/config.mjs';
import { backupState, verifyBackup, restoreState, diagnose, diskCheck } from '../../scripts/runtime/maintenance/backup.mjs';
import { main } from '../../scripts/runtime/maintenance/cli.mjs';
async function reserveFixturePorts(count) {
  const listeners = [], ports = [];
  const release = async () => { await Promise.all(listeners.splice(0).map(server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))); };
  try {
    for (let attempt = 0; ports.length < count && attempt < 100; attempt++) {
      // Avoid both hardcoded shared ports and the ephemeral client-socket ranges
      // used by Linux/macOS/Windows CI. Reserve the whole batch before setup.
      const port = randomInt(12000, 29000), server = createServer();
      try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve); });
        listeners.push(server); ports.push(port);
      } catch (error) { if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error; }
    }
    if (ports.length !== count) throw Error('Could not reserve isolated maintenance fixture ports');
    return { ports, release };
  } catch (error) { await release(); throw error; }
}
const fixture = async operation => {
  const root = await mkdtemp(join(tmpdir(), 'werk-maintenance-'));
  let reservation;
  try {
    reservation = await reserveFixturePorts(5);
    const state = join(root, 'state');
    await setup({ stateDir: state, port: reservation.ports[0], workerPort: reservation.ports[1] });
    await reservation.release();
    await operation({ root, state, ports: reservation.ports });
  } finally { await reservation?.release(); await rm(root, { recursive: true, force: true }); }
};
test('stopped native backup verifies and restores credentials, WAL and pending evidence privately into new state', () => fixture(async ({ root, state }) => {
  await mkdir(join(state, 'workers', 'worker-1', 'outbox'), { recursive: true, mode: 0o700 });
  await writeFile(join(state, 'workers', 'worker-1', 'outbox', 'pending.json'), '{"pending":true}', { mode: 0o600 });
  await writeFile(join(state, 'orchestrator.sqlite-wal'), 'wal fixture', { mode: 0o600 });
  const backup = join(root, 'backup'), restored = join(root, 'restored');
  const result = await backupState(state, backup);
  assert.equal(result.ok, true); assert.equal((await verifyBackup(backup)).manifestSha256, result.manifestSha256);
  assert.equal((await restoreState(backup, restored)).ok, true);
  assert.deepEqual(await readFile(join(restored, 'credentials.json')), await readFile(join(state, 'credentials.json')));
  assert.equal(await readFile(join(restored, 'orchestrator.sqlite-wal'), 'utf8'), 'wal fixture');
  assert.equal(await readFile(join(restored, 'workers/worker-1/outbox/pending.json'), 'utf8'), '{"pending":true}');
  assert.equal((await readdir(state)).includes('runtime.lock'), false);
  await assert.rejects(restoreState(backup, restored), { code: 'EEXIST' });
}));
test('backup refuses unreachable owners and worker locks without deleting them', () => fixture(async ({ root, state }) => {
  await writeFile(join(state, 'runtime.lock'), '{"pid":123}', { mode: 0o600 });
  await assert.rejects(backupState(state, join(root, 'backup')), /owner cannot be verified/);
  assert.equal((await diagnose(state)).ok, false);
  assert.equal(await readFile(join(state, 'runtime.lock'), 'utf8'), '{"pid":123}');
  await rm(join(state, 'runtime.lock'));
  await mkdir(join(state, 'workers/worker-1'), { recursive: true, mode: 0o700 });
  await writeFile(join(state, 'workers/worker-1/worker.lock'), 'owner', { mode: 0o600 });
  await assert.rejects(backupState(state, join(root, 'backup')), /owner holds a lock/);
  assert.equal(await readFile(join(state, 'workers/worker-1/worker.lock'), 'utf8'), 'owner');
  assert.equal((await readdir(state)).includes('runtime.lock'), false);
}));
test('checksum corruption and manifest traversal refuse restore without creating destination', () => fixture(async ({ root, state }) => {
  const backup = join(root, 'backup'), destination = join(root, 'restored');
  await backupState(state, backup);
  await writeFile(join(backup, 'state/credentials.json'), 'tampered', { mode: 0o600 });
  await assert.rejects(restoreState(backup, destination), /inventory|checksum/);
  assert.equal((await readdir(root)).includes('restored'), false);
  const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'));
  manifest.files[0].path = '../outside';
  await writeFile(join(backup, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyBackup(backup), /unsafe/);
}));
test('backup refuses symlinks, overlapping locations and existing destination', { skip: process.platform === 'win32' }, () => fixture(async ({ root, state }) => {
  await symlink('/etc/passwd', join(state, 'escape'));
  await assert.rejects(backupState(state, join(root, 'backup')), /symlinks/);
  await rm(join(state, 'escape'));
  await assert.rejects(backupState(state, join(state, 'backup')), /separate/);
  await mkdir(join(root, 'existing')); await writeFile(join(root, 'existing/sentinel'), 'keep');
  await assert.rejects(backupState(state, join(root, 'existing')), { code: 'EEXIST' });
  assert.equal(await readFile(join(root, 'existing/sentinel'), 'utf8'), 'keep');
}));
test('disk pressure diagnostics are actionable without revealing credential content', () => fixture(async ({ state }) => {
  const check = await diskCheck(state, async () => ({ bavail: 1n, bsize: 4096n, blocks: 100n }));
  assert.equal(check.ok, false); assert.match(check.message, /Do not delete databases/);
  const output = []; assert.equal(await main(['diagnose', '--state-dir', state, '--json'], { stdout: line => output.push(line) }), 0);
  const credentials = JSON.parse(await readFile(join(state, 'credentials.json')));
  assert.equal(output.join('').includes(credentials.WERK_ADMIN_TOKEN), false);
}));

test('whole-system backup preserves Factory and all line credentials and refuses hidden worker locks', () => fixture(async ({ root, ports }) => {
  const { setupSystem } = await import('../../scripts/system/state.mjs');
  const { validateDefinition } = await import('../../scripts/system/definition.mjs');
  const state = join(root, 'system');
  const definition = validateDefinition({ schemaVersion: 1, id: 'restore-system', environment: 'native', factory: { id: 'factory', name: 'Factory', port: ports[2] }, productionLines: [{ id: 'line', name: 'Line', project: 'demo', orchestrator: { port: ports[3] }, workers: { count: 1, statusPort: ports[4] } }] });
  await setupSystem(definition, { stateDir: state });
  const backup = join(root, 'system-backup'), restored = join(root, 'system-restored');
  await backupState(state, backup); await restoreState(backup, restored);
  for (const file of ['system.json', 'factory/credentials.json', 'lines/line/credentials.json']) assert.deepEqual(await readFile(join(restored, file)), await readFile(join(state, file)));
  await mkdir(join(state, 'lines/line/workers/worker-1'), { recursive: true, mode: 0o700 });
  await writeFile(join(state, 'lines/line/workers/worker-1/worker.lock'), 'stale owner', { mode: 0o600 });
  const result = await diagnose(state);
  assert.equal(result.ok, false); assert.ok(result.checks.some(check => check.name.includes('worker.lock')));
}));


test('hard-linked source files and symlinked backup entries cannot be restored', { skip: process.platform === 'win32' }, () => fixture(async ({ root, state }) => {
  const external = join(root, 'external.txt'); await writeFile(external, 'private external content', { mode: 0o600 });
  await link(external, join(state, 'linked.txt'));
  await assert.rejects(backupState(state, join(root, 'refused')), /hard-linked/);
  assert.equal(await readFile(external, 'utf8'), 'private external content');
  await rm(join(state, 'linked.txt'));
  const backup = join(root, 'backup'); await backupState(state, backup);
  const credentials = join(backup, 'state/credentials.json'); await rm(credentials); await symlink(external, credentials);
  await assert.rejects(restoreState(backup, join(root, 'restored')), /symlinks/);
  assert.equal((await readdir(root)).includes('restored'), false);
}));

test('canonical ancestor aliases retain containment checks and support platform temporary paths', { skip: process.platform === 'win32' }, () => fixture(async ({ root, state }) => {
  const alias = join(root, 'alias'); await symlink(root, alias, 'dir');
  const backup = join(alias, 'backup'); await backupState(join(alias, 'state'), backup);
  assert.equal((await verifyBackup(backup)).ok, true);
  await assert.rejects(backupState(state, join(alias, 'state/nested-backup')), /separate/);
  await assert.rejects(restoreState(backup, join(alias, 'backup/nested-restore')), /separate/);
}));


test('backup still refuses a configured port owned by another listener and preserves state', () => fixture(async ({ root, state, ports }) => {
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(ports[0], '127.0.0.1', resolve); });
  const before = await readFile(join(state, 'credentials.json'));
  try {
    await assert.rejects(backupState(state, join(root, 'refused')), /Port [0-9]+ is unavailable/);
    assert.deepEqual(await readFile(join(state, 'credentials.json')), before);
    assert.equal((await readdir(root)).includes('refused'), false);
    assert.equal((await readdir(state)).includes('runtime.lock'), false);
    assert.equal(listener.listening, true);
  } finally { await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); }
}));
