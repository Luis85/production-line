/** Runs as root only inside the disposable qualification VM. Never prints secrets. */
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
const state = '/var/lib/werk';
const artifacts = JSON.parse(await readFile('/etc/werk/artifacts.json', 'utf8'));
const definition = JSON.parse(await readFile('/etc/werk/system.yaml', 'utf8'));
const binary = `/opt/werk/node/${artifacts.node.version}/bin/node`;
const root = `/opt/werk/releases/${artifacts.release.version}`;
const systemctl = (...args) => execFileSync('systemctl', [...args, 'werk-system.service'], { encoding: 'utf8', timeout: 200000 });
const credentialPaths = [`${state}/factory/credentials.json`, ...definition.productionLines.map(line => `${state}/lines/${line.id}/credentials.json`)];
const fingerprint = async () => Promise.all(credentialPaths.map(async path => createHash('sha256').update(await readFile(path)).digest('hex')));
const credentials = await Promise.all(credentialPaths.map(async path => JSON.parse(await readFile(path, 'utf8'))));
const request = async (port, token, path, options = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(3000) });
  assert.equal(response.ok, true, `Application request failed (${response.status})`);
  return response.json();
};
const lineRequest = (index, path, options) => request(definition.productionLines[index].orchestrator.port, credentials[index + 1].WERK_ADMIN_TOKEN, path, options);
async function eventually(probe, label) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try { const result = await probe(); if (result) return result; } catch { /* A bounded retry allows service initialization. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error(`Timed out: ${label}`);
}
async function ready() {
  const result = JSON.parse(execFileSync('runuser', ['-u', 'werk', '--', binary, `${root}/runtime/werk.mjs`, 'system', 'doctor', '--state-dir', state, '--json'], { encoding: 'utf8', timeout: 15000 }));
  return result.ok && result.state === 'running';
}
await eventually(ready, 'authenticated readiness');
assert.equal(systemctl('show', '--property=User', '--value').trim(), 'werk');
assert.equal(systemctl('show', '--property=MainPID', '--value').trim() === '0', false);
const uid = Number(execFileSync('id', ['-u', 'werk'], { encoding: 'utf8' }).trim());
assert.notEqual(uid, 0);
assert.equal((await stat(state)).uid, uid);
assert.equal((await stat(state)).mode & 0o777, 0o700);
assert.equal((await stat(root)).uid, 0);
assert.equal((await stat(root)).mode & 0o222, 0);
for (const path of credentialPaths) assert.equal((await stat(path)).mode & 0o777, 0o600);
const listeners = execFileSync('ss', ['-H', '-ltn'], { encoding: 'utf8' });
const ports = [definition.factory.port, ...definition.productionLines.flatMap(line => [line.orchestrator.port, ...Array.from({ length: line.workers.count }, (_, n) => line.workers.statusPort + n)])];
for (const port of ports) {
  const entries = listeners.split('\n').filter(line => line.trim().split(/\s+/)[3]?.endsWith(`:${port}`));
  assert.ok(entries.length > 0, `Missing listener ${port}`);
  assert.ok(entries.every(line => line.trim().split(/\s+/)[3] === `127.0.0.1:${port}`), `Non-loopback listener ${port}`);
}
assert.equal((await fetch(`http://127.0.0.1:${definition.factory.port}/guide`)).status, 200);
const before = await fingerprint();
const workerIds = await Promise.all(definition.productionLines.map(async (_, index) => (await lineRequest(index, '/v1/workers?limit=100')).workers.map(worker => worker.id).sort()));
const task = await lineRequest(0, '/v1/tasks', { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ project: definition.productionLines[0].project, title: 'VM qualification', criteria: ['Persist simulated task evidence across systemd restart.'] }) });
await eventually(async () => (await lineRequest(0, `/v1/tasks/${task.id}`)).status === 'simulated', 'simulated task');
assert.equal((await lineRequest(0, `/v1/snapshots?task=${task.id}`)).snapshots.length, 2);
systemctl('stop');
assert.equal(systemctl('show', '--property=MainPID', '--value').trim(), '0');
for (const port of ports) await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) }));
systemctl('start');
await eventually(ready, 'restart readiness');
assert.deepEqual(await fingerprint(), before);
assert.deepEqual(await Promise.all(definition.productionLines.map(async (_, index) => (await lineRequest(index, '/v1/workers?limit=100')).workers.map(worker => worker.id).sort())), workerIds);
assert.equal((await lineRequest(0, `/v1/tasks/${task.id}`)).status, 'simulated');
assert.equal((await lineRequest(0, `/v1/snapshots?task=${task.id}`)).snapshots.length, 2);
console.log(JSON.stringify({ ok: true, profile: 'ubuntu-24.04', cloudInitBoot: true, loopbackOnly: true, serviceUser: 'werk', privateState: true, readOnlyRelease: true, simulatedTasks: 1, persistedSnapshots: 2, restartPreserved: true, lines: definition.productionLines.length }));
