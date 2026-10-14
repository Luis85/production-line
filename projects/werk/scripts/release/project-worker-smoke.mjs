import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
const exec = promisify(execFile), app = resolve(process.env.WERK_PROJECT_WORKER_APP ?? 'bin/apps/worker');
const image = 'node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df';
const project = await realpath(await mkdtemp(join(tmpdir(), 'werk-docker-project-')));
const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r));
let configured = false;
const docker = args => exec('docker', args, { cwd: project, timeout: 180000, maxBuffer: 1048576 });
const compose = (...args) => docker(['compose', '-f', '.werk/compose.worker.yaml', ...args]);
async function until(check) { for (let i = 0; i < 200; i++) { try { if (await check()) return; } catch {} await new Promise(r => setTimeout(r, 150)); } throw Error('Docker feature request did not reach the expected state.'); }
try {
  const initialized = await docker(['run', '--rm', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '--mount', `type=bind,src=${app},dst=/installer,readonly`, '--mount', `type=bind,src=${project},dst=/project`, '--workdir', '/project', image, 'node', '/installer/cli.mjs', 'init', '--features-dir', 'requests', '--port', String(port)]);
  assert.equal(JSON.parse(initialized.stdout).initialized, true); configured = true;
  await writeFile(join(project, 'provider-fixture'), '#!/usr/bin/env node\nfor await(const p of process.stdin){}console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Docker feature protocol fixture completed."}}));\n', { mode: 0o700 });
  await compose('up', '-d', '--wait', '--wait-timeout', '90');
  const token = (await readFile(join(project, '.werk/worker/webview-token'), 'utf8')).trim();
  const call = async (path, body) => { const r = await fetch(`http://127.0.0.1:${port}` + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const result = await r.json(); assert.ok(r.ok, result.error); return result; };
  await call('/api/settings', { provider: { id: 'codex-cli', executable: '/project/provider-fixture' } });
  await writeFile(join(project, 'requests/docker.md'), '---\nschemaVersion: 1\ntitle: Docker folder task\nstatus: ready\n---\nVerify the mounted project feature workflow.\n');
  await until(async () => (await call('/api/features')).records[0]?.result !== undefined);
  const before = (await call('/api/features')).records[0]; assert.match(await readFile(join(project, 'requests', before.result), 'utf8'), /protocol fixture completed/);
  const cli = JSON.parse((await compose('exec', '-T', 'worker', 'node', 'bin/apps/worker/cli.mjs', 'feature', 'list')).stdout); assert.equal(cli.records.length, 1);
  await compose('stop');
  const moved = JSON.parse((await compose('run', '--rm', '--no-deps', 'worker', 'node', 'bin/apps/worker/cli.mjs', 'feature', 'folder', 'set', '--path', 'feature-requests')).stdout);
  assert.equal(moved.path, 'feature-requests');
  assert.match(await readFile(join(project, 'feature-requests', before.result), 'utf8'), /protocol fixture completed/);
  await compose('up', '-d', '--wait', '--wait-timeout', '90');
  await until(async () => (await call('/api/features')).records[0]?.result !== undefined);
  assert.equal((await call('/api/features')).records[0].taskId, before.taskId); assert.equal((await call('/api/sessions')).records.length, 2);
  console.log(JSON.stringify({ ok: true, journey: 'project-worker-docker', setupInsideContainer: true, mountedFeatureIntake: true, templateInstalled: true, folderReconfigured: true, resultExported: true, restartPreserved: true, duplicateTasks: false, liveProvider: false }));
} finally {
  if (configured) await compose('down', '--remove-orphans').catch(() => {});
  await rm(project, { recursive: true, force: true });
}
