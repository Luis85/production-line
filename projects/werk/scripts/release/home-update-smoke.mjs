// Actual extracted launchers and payloads; only the previous version number is a labelled fixture.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { extractRelease } from './extract.mjs';
const artifacts = resolve(process.argv[2] ?? 'release'), execute = promisify(execFile);
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'werk-home-upgrade-'))), home = join(scratch, 'Home'), candidate = join(scratch, 'Candidate');
let running = false;
async function cli(root, ...args) { const result = await execute(process.execPath, [join(root, 'worker.mjs'), ...args], { cwd: scratch, timeout: 180000, maxBuffer: 2097152 }); return JSON.parse(result.stdout); }
try {
  await extractRelease(artifacts, home); await extractRelease(artifacts, candidate);
  const manifest = JSON.parse(await readFile(join(home, 'release-manifest.json'), 'utf8')); manifest.version = '0.0.0';
  await writeFile(join(home, 'release-manifest.json'), JSON.stringify(manifest));
  await mkdir(join(home, 'projects/company/.git'), { recursive: true }); await writeFile(join(home, 'projects/company/uncommitted.txt'), 'retain developer work');
  const before = await cli(home, '--no-open', '--port', '0'); running = true;
  const credentials = await readFile(before.credentialsFile), marker = await readFile(join(home, 'state/home.json'));
  const plan = await cli(home, 'update', 'plan', '--from', candidate);
  assert.equal(plan.from, '0.0.0'); assert.equal(plan.to, manifest.version === '0.0.0' ? JSON.parse(await readFile(join(candidate, 'release-manifest.json'), 'utf8')).version : manifest.version);
  const applied = await cli(home, 'update', 'apply', '--from', candidate, '--if-match', plan.id, '--stop'); running = false; assert.equal(applied.status, 'confirmed');
  assert.equal((await cli(home, 'update', 'status')).status, 'confirmed');
  const restarted = await cli(home, '--no-open', '--port', '0'); running = true; assert.deepEqual(await readFile(restarted.credentialsFile), credentials);
  assert.deepEqual(await readFile(join(home, 'state/home.json')), marker); assert.equal(await readFile(join(home, 'projects/company/uncommitted.txt'), 'utf8'), 'retain developer work');
  const rolledBack = await cli(home, 'update', 'rollback', '--stop'); running = false; assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(JSON.parse(await readFile(join(home, 'release-manifest.json'), 'utf8')).version, '0.0.0');
  // Reproduce a lost acknowledgement with runtime absent; use the separate verified candidate launcher for recovery.
  const second = await cli(home, 'update', 'apply', '--from', candidate); assert.equal(second.status, 'confirmed');
  await rename(join(home, 'runtime'), join(home, 'state/updates', second.id, 'lost-ack-runtime'));
  const journalPath = join(home, 'state/updates/latest.json'), journal = JSON.parse(await readFile(journalPath, 'utf8'));
  journal.status = 'pending'; journal.intent = { action: 'activate_new', name: 'runtime' }; await writeFile(journalPath, JSON.stringify(journal));
  assert.equal((await cli(candidate, 'update', 'status', '--home', home)).status, 'pending');
  assert.equal((await cli(candidate, 'update', 'rollback', '--home', home)).status, 'rolled_back');
  assert.equal(await readFile(join(home, 'projects/company/uncommitted.txt'), 'utf8'), 'retain developer work'); assert.deepEqual(await readFile(join(home, 'state/worker/webview-token')), credentials);
  const restored = await cli(home, '--no-open', '--port', '0'); running = true; assert.equal(restored.state, 'running');
  console.log(JSON.stringify({ ok: true, journey: 'flat-home-selective-update', previousVersionFixture: '0.0.0', exactPreviewApplied: true, authenticatedStop: true, credentialsAndSelectionPreserved: true, visibleProjectPreserved: true, rollbackVerified: true, runtimeGapRecoveredThroughCandidateLauncher: true, finalStartConfirmed: true }));
} finally { if (running) await cli(home, 'stop').catch(() => {}); await rm(scratch, { recursive: true, force: true }); }
