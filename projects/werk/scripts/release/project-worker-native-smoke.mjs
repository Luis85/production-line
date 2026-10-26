// Candidate Home qualification: real launcher/HTTP/Git/journals, deterministic CLI inference only.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { writeDownloadedWorkerModel } from './worker-home-protocol.mjs';
const execute = promisify(execFile), source = resolve(process.env.WERK_WORKER_HOME_ROOT ?? '.');
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'werk-native-home-'))), home = join(scratch, 'WerkHome'), entry = join(home, 'worker.mjs');
const environment = { ...process.env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Release Fixture', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'fixture@example.invalid' };
for (const key of Object.keys(environment)) if (key.startsWith('WERK_')) delete environment[key];
async function command(file, args, cwd = scratch) { return execute(file, args, { cwd, env: environment, timeout: 180000, maxBuffer: 2097152 }); }
async function git(cwd, ...args) { return (await command('git', args, cwd)).stdout.trim(); }
async function cli(...args) { return JSON.parse((await command(process.execPath, [entry, ...args])).stdout); }
let url, token, started = false;
async function api(path, body) {
  const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
  const value = await response.json(); assert.ok(response.ok, path + ': ' + JSON.stringify(value)); return value;
}
try {
  await cp(source, home, { recursive: true, filter: path => path !== join(source, 'state') && path !== join(source, 'projects') });
  const producer = join(scratch, 'producer'), remote = join(scratch, 'company.git'), fixture = join(scratch, 'claude-protocol-fixture');
  await mkdir(producer); await mkdir(join(producer, 'src')); await mkdir(join(producer, 'tests')); await writeDownloadedWorkerModel(fixture);
  await writeFile(join(producer, 'src/value.mjs'), 'export const value = 1;\n');
  await writeFile(join(producer, 'tests/value.mjs'), "import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; assert.equal(value, 2);\n");
  await git(scratch, 'init', '--bare', '--initial-branch=main', remote); await git(producer, 'init', '--initial-branch=main'); await git(producer, 'add', '.'); await git(producer, 'commit', '-m', 'Initial project'); await git(producer, 'remote', 'add', 'origin', remote); await git(producer, 'push', 'origin', 'main');
  const first = await cli('--no-open', '--port', '0'); started = true; url = first.url; token = (await readFile(first.credentialsFile, 'utf8')).trim();
  assert.equal(first.stateDirectory, join(home, 'state/worker'));
  await api('/api/settings', { defaultProvider: 'claude-cli', provider: { id: 'claude-cli', authenticationMode: 'cli-account', executable: fixture, model: 'deterministic-protocol-fixture' }, board: { paused: true } });
  const registered = await api('/api/managed-projects', { action: 'register', id: 'company', operationId: 'smoke-register', repository: pathToFileURL(remote).href });
  const checkout = registered.projects[0].path; assert.equal(checkout, join(home, 'projects/company'));
  const setup = await api('/api/managed-projects', { action: 'setup_plan', id: 'company', provider: 'claude-cli' });
  await api('/api/managed-projects', { action: 'setup_apply', id: 'company', operationId: 'smoke-workflow', expectedPlan: setup.planDigest });
  const policy = await api('/api/requests', { action: 'delivery_policy', projectId: 'company' }); assert.equal(policy.configuration.localMerge, true);
  await api('/api/requests', { action: 'approve_delivery_policy', repositoryId: 'company', configurationDigest: policy.configurationDigest, expectedApprovalRevision: policy.approvalRevision });
  assert.equal((await api('/api/managed-projects', { action: 'reconcile', id: 'company', operationId: 'smoke-enable' })).projects[0].intakeEnabled, true);
  const grant = await api('/api/tool-access'); await api('/api/tool-access', { expectedRevision: grant.revision, builtins: { ...grant.builtins, files: true, commands: [{ id: 'value', name: 'Verify exported value', executable: process.execPath, args: ['tests/value.mjs'], enabled: true, verification: true }] }, mcp: [] });
  const draft = await api('/api/features', { action: 'prepare', projectId: 'company', operationId: 'smoke-draft', seed: { title: 'Packaged Home value change', provider: 'claude-cli', message: 'Change the exported value to two in the approved file.', paths: ['src/value.mjs'] } });
  const markdown = draft.markdown.replace('<!-- Describe constraints, relevant behavior, and what is outside this request. -->', 'Preserve unrelated source and committed verification.').replace('<!-- Add one or more concrete, verifiable checklist items. -->', '- The value is two and the committed verification passes.').replace('<!-- Explain how each outcome will be checked and what evidence reviewers need. -->', 'Run tests/value.mjs against the isolated candidate.');
  const ready = await api('/api/features', { action: 'publish', projectId: 'company', operationId: 'smoke-ready', name: draft.name, markdown, status: 'ready', expectedRevision: draft.revision, expectedWorkflowDigest: draft.workflowDigest, expectedBinding: draft.binding });
  assert.ok(ready.publication?.commit); await assert.rejects(readFile(join(scratch, 'fixture-calls.jsonl')), { code: 'ENOENT' });
  await api('/api/settings', { board: { paused: false } });
  let retained;
  const deadline = performance.now() + 180000;
  while (performance.now() < deadline) {
    await api('/api/shared-intake', { action: 'sync', projectId: 'company' });
    retained = (await api('/api/shared-intake?projectId=company')).requests.find(item => item.id === ready.featureId);
    if (retained?.error) throw Error(retained.error);
    if (retained?.status === 'ready_for_review' && retained.publication === 'synced') break;
    await delay(200);
  }
  assert.equal(retained?.status, 'ready_for_review'); assert.ok(retained.featureBranch && retained.reviewNote && retained.taskId);
  const featureCommit = await git(remote, 'rev-parse', 'refs/heads/' + retained.featureBranch);
  assert.equal(await git(remote, 'show', featureCommit + ':src/value.mjs'), 'export const value = 2;');
  assert.match(await git(remote, 'show', 'main:' + retained.reviewNote), /Required checks passed for this candidate/);
  assert.equal(await readFile(join(checkout, 'src/value.mjs'), 'utf8'), 'export const value = 1;\n'); assert.equal(await git(checkout, 'status', '--porcelain'), '');
  const identity = (await api('/api/environment')).status.machineId, credentials = await readFile(first.credentialsFile);
  await cli('stop'); started = false; const restarted = await cli('--no-open', '--port', '0'); started = true; url = restarted.url;
  assert.equal((await api('/api/environment')).status.machineId, identity); assert.deepEqual(await readFile(restarted.credentialsFile), credentials);
  const restored = (await api('/api/shared-intake?projectId=company')).requests.find(item => item.id === ready.featureId); assert.equal(restored.taskId, retained.taskId); assert.equal(restored.featureBranch, retained.featureBranch);
  console.log(JSON.stringify({ ok: true, journey: 'central-werk-home-native', extractedHome: true, installedWithoutNpm: true, projectCloneVisible: true, featureCommittedBeforeInference: true, verifiedCandidatePushed: true, markdownReviewPublished: true, mainCheckoutUnchanged: true, identityAndCredentialsPreserved: true, restartPreserved: true, providerProtocolFixture: true, liveProvider: false }));
} finally { if (started) await cli('stop').catch(() => {}); await rm(scratch, { recursive: true, force: true }); }
