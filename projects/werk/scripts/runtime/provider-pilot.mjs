#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { createWorkerSessions, createLocalTaskboard } from '../../src/worker/dist/worker/infrastructure/workspace-services.js';
import { prepareRepositoryWorktree } from '../../src/worker/dist/worker/infrastructure/repositories.js';
import { prepareProcessRuntime } from '../../src/worker/dist/shared/process/launcher.js';
import { ProviderStatusChecks } from '../../src/worker/dist/worker/infrastructure/provider-status.js';
const { values } = parseArgs({ options: { help: { type: 'boolean' }, provider: { type: 'string', default: 'claude-cli' }, executable: { type: 'string' }, model: { type: 'string', default: '' }, 'allow-billable-model-call': { type: 'boolean' }, 'accept-cursor-native-permissions': { type: 'boolean' }, 'timeout-ms': { type: 'string', default: '900000' } } });
const usage = 'Usage: npm run pilot:provider -- --provider claude-cli|codex-cli|cursor-cli --executable <absolute official CLI> --allow-billable-model-call [--model <name>] [--timeout-ms 900000] [--accept-cursor-native-permissions]\nRuns one real local development Feature Request using the current CLI subscription login. It creates and retains a scratch Git repository, isolated worktree, checks and local review note; it does not push or merge. Provider calls consume your account allowance. A successful run qualifies only this exact host/CLI/version. Cursor uses its own native permissions and hooks.';
if (values.help) console.log(usage);
else if (!values['allow-billable-model-call'] || !['claude-cli', 'codex-cli', 'cursor-cli'].includes(values.provider) || !values.executable || !isAbsolute(values.executable) || values.provider === 'cursor-cli' && !values['accept-cursor-native-permissions'] || !/^\d+$/.test(values['timeout-ms']) || Number(values['timeout-ms']) < 1000 || Number(values['timeout-ms']) > 3600000) {
  console.error(usage); process.exitCode = 2;
} else await pilot();
async function pilot() {
  const provider = /** @type {'claude-cli'|'codex-cli'|'cursor-cli'} */ (values.provider), timeout = Number(values['timeout-ms']);
  const checks = new ProviderStatusChecks();
  const connection = { id: provider, executable: values.executable, model: values.model, authenticationMode: /** @type {const} */ ('cli-account'), apiKey: '' };
  let sessions, board, root;
  const receipt = { schemaVersion: 1, checkKind: 'real_provider_development_pilot', fixture: false, platform: process.platform, architecture: process.arch, node: process.versions.node, provider, authenticationMode: 'cli-account', startedAt: new Date().toISOString(), liveInferenceQualified: false };
  try {
    if (process.platform === 'win32') console.error('Preparing the trusted Windows command runtime (up to 30 seconds); provider checks keep their separate five-second deadlines.');
    await prepareProcessRuntime(process.cwd(), new AbortController().signal);
    const diagnostic = await checks.check(connection);
    if (!diagnostic.available || diagnostic.authentication !== 'authenticated') throw Error('The selected official CLI must pass its account/version diagnostic before billable execution.');
    root = await realpath(await mkdtemp(join(tmpdir(), 'werk-real-provider-pilot-')));
    const repository = join(root, 'project'), state = join(root, 'state');
    await mkdir(join(repository, 'src'), { recursive: true }); await mkdir(join(repository, 'tests')); await mkdir(state);
    const run = promisify(execFile);
    const git = async (...args) => (await run('git', ['-c', 'core.hooksPath=/dev/null', '-C', repository, ...args], { windowsHide: true, timeout: 30000 })).stdout.trim();
    await git('init', '--initial-branch=main'); await git('config', 'core.autocrlf', 'false');
    await git('config', 'user.name', 'Werk Provider Pilot'); await git('config', 'user.email', 'pilot@example.invalid');
    await writeFile(join(repository, 'src', 'value.mjs'), 'export const value = 1;\n');
    await writeFile(join(repository, 'tests', 'value.mjs'), "import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; assert.equal(value,2); console.log('Observed value two.');\n");
    await git('add', '.'); await git('commit', '-m', 'Provider pilot baseline');
    const baseline = await git('rev-parse', 'HEAD');
    const settings = new WorkerSettings(state); await settings.init();
    await settings.update({ provider: connection, board: { paused: false }, execution: { ...settings.value.execution, maxRuntimeMs: timeout } });
    const tools = settings.toolPolicy();
    await settings.updateToolAccess({ expectedRevision: tools.revision, builtins: { ...tools.builtins, files: true, commands: [{ id: 'pilot-value', name: 'Verify value two', executable: process.execPath, args: ['tests/value.mjs'], enabled: true, verification: true }] }, mcp: [] });
    sessions = createWorkerSessions(state, settings); await sessions.init();
    board = createLocalTaskboard(state, settings, sessions, { prepareWorktree: (selector, key, signal, commit, inspection) => prepareRepositoryWorktree(selector, key, signal, commit, inspection) }); await board.init();
    await board.create({ title: 'Provider pilot: implement value two', instruction: 'Change src/value.mjs so its exported value is exactly 2. Only src/value.mjs is approved for edits. Preserve the verification command and tests. Run the required candidate check, then return a concise summary. Do not commit, push or merge.', repository, paths: ['src/value.mjs'], provider });
    const id = board.view().tasks.at(-1).id, deadline = performance.now() + timeout + 120000;
    console.error('Real provider pilot running; retained evidence: ' + root);
    await board.tick();
    let task;
    while (performance.now() < deadline) {
      task = board.executionDetail(id);
      if (!['queued', 'running'].includes(task.status) && !sessions.executor.busy && !board.active) break;
      await delay(250);
    }
    const request = sessions.requests.get(task.requestId), review = request.delivery?.review;
    if (task.status !== 'review' || !review || !task.developmentCompletion?.verified) throw Error('The real provider did not reach verified human review. Inspect the retained private journal and worktree.');
    if (await git('rev-parse', 'HEAD') !== baseline || await git('status', '--porcelain') || await readFile(join(repository, 'src', 'value.mjs'), 'utf8') !== 'export const value = 1;\n') throw Error('The original checkout changed during the pilot.');
    await board.verifyDelivery(request.id, request.revision);
    const result = { ...receipt, finishedAt: new Date().toISOString(), liveInferenceQualified: true, providerVersion: diagnostic.version, requestId: request.id, candidateCommit: review.candidate.candidateCommit, candidateDigest: review.candidate.candidateDigest, reviewNotePath: review.reviewNotePath, retainedDirectory: root, checks: review.checks.map(check => ({ id: check.presetId, status: check.status, exitCode: check.exitCode })), humanAcceptance: false, remotePublication: false };
    await writeFile(join(root, 'pilot-result.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const result = { ...receipt, finishedAt: new Date().toISOString(), retainedDirectory: root ?? null, error: error instanceof Error ? error.message : 'Pilot failed.' };
    if (root) await writeFile(join(root, 'pilot-result.json'), JSON.stringify(result, null, 2) + '\n');
    console.error(JSON.stringify(result, null, 2)); process.exitCode = 1;
  } finally { await board?.close(); await sessions?.close(); await checks.close(); }
}
