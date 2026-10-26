import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { featureContentHash } from '../../src/worker/dist/worker/application/feature-workflow.js';
import { ManagedProjectSetup, managedSetupDigest } from '../../src/worker/dist/worker/application/managed-project-setup.js';
import { managedProjectLocations } from '../../src/worker/dist/worker/infrastructure/managed-project-locations.js';
import { managedProjectGit } from '../../src/worker/dist/worker/infrastructure/managed-project-git.js';
import { managedProjectSetupGit } from '../../src/worker/dist/worker/infrastructure/managed-project-setup.js';
import { managedProjectSetupStorage } from '../../src/worker/dist/worker/infrastructure/managed-project-setup-storage.js';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { statusServer } from '../../src/worker/dist/worker/status/server.js';
import { workerStatus } from '../helpers/worker-status.mjs';
import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';

prepareNativeProcessFixture();
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
const timeout = process.platform === 'win32' ? 180000 : 60000;
async function fixture(t, { cleanup = true, home = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk-managed-setup-'))), source = join(root, 'source'), remote = join(root, 'company.git'), state = join(root, 'state');
  if (cleanup) t.after(() => rm(root, { recursive: true, force: true })); await mkdir(source); await mkdir(state);
  git(root, 'init', '--bare', '--initial-branch=main', remote); git(source, 'init', '--initial-branch=main');
  await writeFile(join(source, '.gitattributes'), '* text eol=lf\n'); await writeFile(join(source, 'value.txt'), 'original\n'); git(source, 'add', '.'); git(source, 'commit', '-m', 'Project before workflow setup'); git(source, 'remote', 'add', 'origin', remote); git(source, 'push', 'origin', 'main');
  const locations = managedProjectLocations(state, home ? root : undefined);
  const adapter = managedProjectGit(state, locations), initial = git(source, 'rev-parse', 'HEAD');
  /** @type {import('../../src/worker/application/managed-projects.ts').ManagedProject} */
  const project = { id: 'plain', name: 'Plain', mode: 'clone', repository: pathToFileURL(remote).toString(), branch: 'main', featuresDirectory: 'features', path: adapter.location('plain'), intake: 'shared', operationId: 'clone-setup', status: 'ready', attached: true, head: initial, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), detail: '', operations: [{ operationId: 'clone-setup', digest: 'a'.repeat(64), action: 'register' }] };
  await adapter.clone(project, t.signal);
  const ports = { ...managedProjectSetupStorage(state, project.id, locations.placement(project).privateDirectory), ...managedProjectSetupGit(state, project, t.signal, locations) };
  const setup = new ManagedProjectSetup(ports);
  return { root, source, state, remote, project, initial, ports, setup };
}
const preview = setup => setup.command({ action: 'setup_plan', id: 'plain', provider: 'claude-cli' }, 'claude-cli');
const apply = (setup, plan, operationId = 'workflow-setup') => setup.command({ action: 'setup_apply', id: 'plain', expectedPlan: plan.planDigest, operationId }, 'claude-cli');

test('workflow preview is read-only and explicit apply commits missing files to plain Git without policy approval', { timeout }, async t => {
  const f = await fixture(t), plan = await preview(f.setup);
  assert.ok('files' in plan); assert.equal(plan.files.length, 6); assert.ok(plan.files.every(file => file.status === 'create'));
  const { planDigest, ...subject } = plan; assert.equal(managedSetupDigest(subject), planDigest);
  assert.equal(git(f.remote, 'rev-parse', 'main'), f.initial); assert.equal(git(f.project.path, 'status', '--porcelain'), '');
  const result = await apply(f.setup, plan); assert.ok('status' in result); assert.equal(result.status, 'published'); assert.ok(result.commit);
  assert.equal(git(f.remote, 'rev-parse', 'main'), result.commit); assert.equal(git(f.project.path, 'rev-parse', 'HEAD'), result.commit);
  assert.equal(git(f.project.path, 'status', '--porcelain'), ''); assert.equal(git(f.source, 'rev-parse', 'HEAD'), f.initial);
  for (const file of plan.files) assert.equal(git(f.remote, 'show', result.commit + ':' + file.path), file.content.trimEnd());
  const policy = JSON.parse(git(f.remote, 'show', 'main:.werk/delivery-policy.json'));
  assert.equal(policy.localMerge, true); assert.equal(policy.remoteDelivery, undefined); assert.equal(policy.release, undefined);
  assert.equal(result.requiresPolicyApproval, true); assert.match(result.detail, /approve.*exact project delivery policy/);
  const first = git(f.remote, 'rev-parse', 'main');
  const replay = await apply(new ManagedProjectSetup(f.ports), plan); assert.ok('status' in replay); assert.equal(replay.commit, result.commit);
  assert.equal(git(f.remote, 'rev-parse', 'main'), first, 'Restart/replay must not publish a second setup commit.');
  await assert.rejects(apply(f.setup, { planDigest: 'b'.repeat(64) }), /another immutable preview/);
});

test('setup preserves custom committed files and rejects stale previews, dirty clones and adopted checkouts', { timeout }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'fr-ready-check.json'), JSON.stringify({ schemaVersion: 1, id: 'team-ready', version: 7, stage: 'ready', rules: { chat: [], patch: [] } }));
  git(f.source, 'add', '.'); git(f.source, 'commit', '-m', 'Team readiness rules'); git(f.source, 'push', 'origin', 'main');
  const plan = await preview(f.setup); assert.ok('files' in plan); assert.equal(plan.files.find(file => file.path === 'fr-ready-check.json').status, 'preserve');
  await writeFile(join(f.source, 'value.txt'), 'teammate change\n'); git(f.source, 'add', '.'); git(f.source, 'commit', '-m', 'Concurrent team change'); git(f.source, 'push', 'origin', 'main');
  await assert.rejects(apply(f.setup, plan), /changed.*Refresh|changed.*preview/i);
  const refreshed = await preview(f.setup); const result = await apply(f.setup, refreshed); assert.ok('status' in result); assert.equal(result.status, 'published');
  assert.equal(JSON.parse(git(f.remote, 'show', 'main:fr-ready-check.json')).id, 'team-ready'); assert.equal(git(f.remote, 'show', 'main:value.txt'), 'teammate change');
  await writeFile(join(f.project.path, 'local.txt'), 'operator work'); await assert.rejects(preview(f.setup), /local changes/);
  assert.equal(await readFile(join(f.project.path, 'local.txt'), 'utf8'), 'operator work');
  const adopted = new ManagedProjectSetup({ ...f.ports, ...managedProjectSetupGit(f.state, { ...f.project, mode: 'adopt', path: f.source }, t.signal) });
  await assert.rejects(preview(adopted), /worker-owned managed clones/);
});

test('lost setup push acknowledgement reconciles the saved commit after restart without repeating publication', { timeout }, async t => {
  const f = await fixture(t), plan = await preview(f.setup); let pushes = 0;
  const interrupted = new ManagedProjectSetup({ ...f.ports, async publish(operation) { pushes++; await f.ports.publish(operation); throw Error('Lost acknowledgement after remote publication'); } });
  const uncertain = await apply(interrupted, plan); assert.ok('status' in uncertain); assert.equal(uncertain.status, 'unknown');
  assert.equal(git(f.project.path, 'rev-parse', 'HEAD'), f.initial);
  const recovered = await new ManagedProjectSetup({ ...f.ports, async publish() { assert.fail('Reconciliation must not repeat a push.'); } }).command({ action: 'setup_reconcile', id: 'plain', operationId: 'workflow-setup' }, 'claude-cli');
  assert.ok('status' in recovered); assert.equal(recovered.status, 'published'); assert.equal(recovered.commit, uncertain.commit); assert.equal(pushes, 1);
  assert.equal(git(f.remote, 'rev-parse', 'main'), uncertain.commit); assert.equal(git(f.project.path, 'rev-parse', 'HEAD'), uncertain.commit);
});


test('web-only registration and setup leave exact policy approval and intake activation as separate explicit actions', { timeout }, async t => {
  const f = await fixture(t, { cleanup: false });
  // The worker starts outside any project with only its private state; no project-init CLI or provider fixture is used.
  const journal = new SnapshotJournal(f.state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
  const worker = new WorkerWorkspace({ stateDir: f.state, projectDir: f.root, pollMs: 1000, timeoutMs: 60000 }, journal, workerStatus);
  await worker.init(); await worker.updateSettings({ board: { paused: true } });
  const server = await statusServer(workerStatus, '127.0.0.1', 0, undefined, worker);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await worker.close(); journal.close(); await rm(f.root, { recursive: true, force: true }); });
  const token = (await readFile(join(f.state, 'webview-token'), 'utf8')).trim(), address = server.address(); assert.ok(address && typeof address === 'object'); const port = address.port;
  async function api(path, body) {
    const response = await fetch('http://127.0.0.1:' + port + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: t.signal });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  }
  const registered = await api('/api/managed-projects', { action: 'register', operationId: 'browser-register', id: 'browser', repository: pathToFileURL(f.remote).toString() });
  assert.equal(registered.projects[0].workflow.configured, false); assert.equal(registered.projects[0].intakeEnabled, false);
  const plan = await api('/api/managed-projects', { action: 'setup_plan', id: 'browser', provider: 'claude-cli' });
  assert.equal(plan.files.length, 6); assert.ok(plan.planDigest); assert.equal(git(f.remote, 'rev-parse', 'main'), f.initial);
  const applied = await api('/api/managed-projects', { action: 'setup_apply', id: 'browser', operationId: 'browser-workflow', expectedPlan: plan.planDigest });
  assert.equal(applied.status, 'published');
  const setupStorage = managedProjectSetupStorage(f.state, 'browser'), retained = await setupStorage.load(); retained.operations[0].status = 'unknown'; await setupStorage.save(retained);
  const recovery = (await worker.managedProjectsView()).projects[0].setup; assert.ok(recovery); assert.equal(recovery.operationId, 'browser-workflow'); assert.equal(recovery.commit, applied.commit);
  assert.equal((await api('/api/managed-projects', { action: 'setup_reconcile', id: 'browser', operationId: recovery.operationId })).status, 'published');
  const pending = (await worker.managedProjectsView()).projects[0];
  assert.equal(pending.workflow.configured, true); assert.equal(pending.policyApproved, false); assert.equal(pending.intakeEnabled, false);
  const policy = await api('/api/requests', { action: 'delivery_policy', projectId: 'browser' });
  assert.equal(policy.configuration.localMerge, true); assert.equal(policy.configuration.remoteDelivery, undefined); assert.equal(policy.configuration.release, undefined);
  await api('/api/requests', { action: 'approve_delivery_policy', repositoryId: 'browser', configurationDigest: policy.configurationDigest, expectedApprovalRevision: policy.approvalRevision });
  assert.equal((await worker.managedProjectsView()).projects[0].intakeEnabled, false, 'Policy approval does not silently activate intake.');
  const enabled = await api('/api/managed-projects', { action: 'reconcile', id: 'browser', operationId: 'browser-enable' });
  assert.equal(enabled.projects[0].policyApproved, true); assert.equal(enabled.projects[0].intakeEnabled, true);
  assert.equal(worker.board.view().tasks.length, 0); assert.equal(worker.sessions.runs.list().total, 0);
});


test('a failed local setup preparation retains its immutable operation ID while allowing a fresh preview', { timeout }, async t => {
  const f = await fixture(t), plan = await preview(f.setup);
  const stopped = new ManagedProjectSetup({ ...f.ports, async commit() { throw Error('Interrupted before commit publication'); } });
  await assert.rejects(apply(stopped, plan), /Interrupted before commit publication/);
  assert.equal(git(f.remote, 'rev-parse', 'main'), f.initial);
  const fresh = await preview(f.setup);
  await assert.rejects(apply(f.setup, fresh), /stopped before any push/);
  const result = await apply(f.setup, fresh, 'new-reviewed-setup'); assert.ok('status' in result); assert.equal(result.status, 'published');
});


for (const kind of ['link', 'case']) test('workflow setup rejects tracked ' + kind + ' aliases before any publication', { timeout }, async t => {
  const f = await fixture(t);
  if (kind === 'link') {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.source, input: 'outside-project', encoding: 'utf8', windowsHide: true }).trim();
    git(f.source, 'update-index', '--add', '--cacheinfo', '120000', blob, '.werk');
  } else { await mkdir(join(f.source, '.WERK')); await writeFile(join(f.source, '.WERK', 'team.txt'), 'preserve alias'); git(f.source, 'add', '.WERK'); }
  git(f.source, 'commit', '-m', 'Tracked path that must not be replaced by setup'); git(f.source, 'push', 'origin', 'main');
  const head = git(f.remote, 'rev-parse', 'main');
  await assert.rejects(preview(f.setup), kind === 'link' ? /non-directory or symbolic-link ancestor/ : /case-insensitive/);
  assert.equal(git(f.remote, 'rev-parse', 'main'), head); assert.equal(git(f.project.path, 'rev-parse', 'HEAD'), f.initial);
});


test('a definite setup lease rejection preserves teammate work and permits a newly reviewed operation', { timeout }, async t => {
  const f = await fixture(t), plan = await preview(f.setup);
  const raced = new ManagedProjectSetup({ ...f.ports, async commit(current, operationId) {
    const candidate = await f.ports.commit(current, operationId);
    await writeFile(join(f.source, 'value.txt'), 'concurrent teammate source\n'); git(f.source, 'add', '.'); git(f.source, 'commit', '-m', 'Team commit after setup preparation'); git(f.source, 'push', 'origin', 'main');
    return candidate;
  } });
  await assert.rejects(apply(raced, plan), /rejected.*Refresh.*preview/i);
  assert.equal(git(f.remote, 'show', 'main:value.txt'), 'concurrent teammate source'); assert.equal(git(f.project.path, 'rev-parse', 'HEAD'), f.initial);
  const retained = await f.ports.load(); assert.equal(retained.operations[0].status, 'not_published');
  const refreshed = await preview(f.setup), result = await apply(f.setup, refreshed, 'reviewed-after-rejection');
  assert.ok('status' in result); assert.equal(result.status, 'published'); assert.equal(git(f.remote, 'show', 'main:value.txt'), 'concurrent teammate source');
});


test('setup verifies a retained commit before any push, including a well-shaped substituted Git object', { timeout }, async t => {
  const f = await fixture(t), plan = await preview(f.setup), before = git(f.remote, 'rev-parse', 'main');
  const forged = git(f.project.path, 'commit-tree', git(f.project.path, 'rev-parse', 'HEAD^{tree}'), '-p', before, '-m', 'An unreviewed retained object');
  const substituted = new ManagedProjectSetup({ ...f.ports, async commit() { return forged; } });
  const result = await apply(substituted, plan); assert.ok('status' in result); assert.equal(result.status, 'unknown'); assert.match(result.detail, /retained setup commit.*reviewed plan/);
  assert.equal(git(f.remote, 'rev-parse', 'main'), before, 'Verification must precede the first mutation of the remote branch.');
  assert.equal(git(f.project.path, 'rev-parse', 'HEAD'), before);
});

test('confirmed setup publication preserves local changes and explains how to reconcile its clean checkout', { timeout }, async t => {
  const f = await fixture(t), plan = await preview(f.setup); let pushes = 0;
  const changed = new ManagedProjectSetup({ ...f.ports, async publish(operation) {
    pushes++; const result = await f.ports.publish(operation); await writeFile(join(f.project.path, 'operator.txt'), 'retain operator work'); return result;
  } });
  const result = await apply(changed, plan); assert.ok('status' in result); assert.equal(result.status, 'unknown'); assert.match(result.detail, /local changes.*Preserve and resolve/);
  assert.equal(await readFile(join(f.project.path, 'operator.txt'), 'utf8'), 'retain operator work'); assert.equal(git(f.project.path, 'rev-parse', 'HEAD'), f.initial);
  await rm(join(f.project.path, 'operator.txt'));
  const recovered = await f.setup.command({ action: 'setup_reconcile', id: 'plain', operationId: 'workflow-setup' }, 'claude-cli');
  assert.ok('status' in recovered); assert.equal(recovered.status, 'published'); assert.equal(pushes, 1); assert.equal(git(f.project.path, 'rev-parse', 'HEAD'), result.commit);
});

test('setup journal storage refuses an oversized history before replacing its previously readable state', { timeout }, async t => {
  const f = await fixture(t), current = await preview(f.setup); assert.ok('files' in current);
  const path = join(f.state, 'projects', 'plain', 'workflow-setup.json'), before = await readFile(path, 'utf8'), content = 'a'.repeat(65536);
  const { planDigest: _digest, ...subject } = current;
  const large = { ...subject, files: Array.from({ length: 17 }, (_value, index) => ({ path: 'templates/' + index + '.md', status: /** @type {const} */ ('preserve'), sha256: featureContentHash(content), content })) };
  const plan = { ...large, planDigest: managedSetupDigest(large) };
  const operations = Array.from({ length: 16 }, (_value, index) => ({ operationId: 'retained-' + index, plan, status: /** @type {const} */ ('not_published') }));
  await assert.rejects(f.ports.save({ schemaVersion: 1, operations }), /storage limit/);
  assert.equal(await readFile(path, 'utf8'), before); assert.equal((await f.ports.load()).plan.planDigest, current.planDigest);
});


test('direct Home checkout setup keeps publication outboxes private and the canonical repository clean', { timeout }, async t => {
  const f = await fixture(t, { home: true }), plan = await preview(f.setup);
  assert.equal(f.project.path, join(f.root, 'projects', 'plain'));
  const result = await apply(f.setup, plan); assert.ok('status' in result); assert.equal(result.status, 'published');
  assert.equal(git(f.project.path, 'status', '--porcelain'), '');
  const outbox = JSON.parse(await readFile(join(f.state, 'managed-projects', f.project.id, 'workflow-setup.json'), 'utf8'));
  assert.equal(outbox.operations[0].commit, result.commit); assert.equal(outbox.operations[0].status, 'published');
  await assert.rejects(readFile(join(f.project.path, 'registration.json')), { code: 'ENOENT' });
  assert.equal(git(f.source, 'rev-parse', 'HEAD'), f.initial);
});
