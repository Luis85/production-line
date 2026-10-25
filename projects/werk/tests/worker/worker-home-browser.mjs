import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { packageRelease } from '../../scripts/release/package.mjs';
import { extractRelease } from '../../scripts/release/extract.mjs';
import { writeDownloadedWorkerModel } from './helpers/downloaded-worker-model.mjs';

// Real released payload, browser, HTTP transport, journals, checks and Git. Only inference is a labelled CLI protocol fixture.
const project = fileURLToPath(new URL('../../', import.meta.url)), execute = promisify(execFile);
const outer = await mkdtemp(join(tmpdir(), 'werk downloaded browser ')), home = join(outer, 'Dedicated Worker Home');
const evidence = resolve(process.env.WERK_BROWSER_EVIDENCE ?? join(outer, '..', 'werk-downloaded-evidence-' + Date.now())); await mkdir(evidence, { recursive: true });
const result = { fixture: 'Deterministic Claude CLI protocol; no real provider login or inference', liveProvider: false, checks: [], screenshots: [], pageErrors: [] };
const environment = { ...process.env }; for (const key of Object.keys(environment)) if (key.startsWith('WERK_')) delete environment[key];
Object.assign(environment, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Browser Fixture', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'fixture@example.invalid' });
async function command(executable, args, cwd = outer) { return execute(executable, args, { cwd, env: environment, windowsHide: true, timeout: 180000, maxBuffer: 2097152 }); }
async function git(cwd, ...args) { return (await command('git', args, cwd)).stdout.trim(); }
async function until(predicate, label, timeout = 120000) { const end = performance.now() + timeout; while (performance.now() < end) { if (await predicate()) return; await delay(200); } throw Error('Timed out: ' + label); }
let entry, browser, page, url, token;
async function cli(...args) { return JSON.parse((await command(process.execPath, [entry, ...args], home)).stdout); }
async function api(path, body) {
  const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
  const value = await response.json(); assert.ok(response.ok, path + ': ' + JSON.stringify(value)); return value;
}
async function screenshot(name) { await page.screenshot({ path: join(evidence, name + '.png'), fullPage: true }); result.screenshots.push(name); }
async function refresh() { await page.getByRole('button', { name: 'Refresh worker', exact: true }).click(); await delay(250); }
try {
  const producer = join(outer, 'producer'), remote = join(outer, 'company.git'), fixture = join(outer, 'claude-protocol-fixture'); await mkdir(producer); await mkdir(join(producer, 'src')); await mkdir(join(producer, 'tests'));
  await writeDownloadedWorkerModel(fixture);
  await writeFile(join(producer, '.gitattributes'), '* text eol=lf\n');
  await writeFile(join(producer, 'src/value.mjs'), 'export const value = 1;\n');
  await writeFile(join(producer, 'tests/value.mjs'), "import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; assert.equal(value, 2); console.log('actual verification passed');\n");
  await git(outer, 'init', '--bare', '--initial-branch=main', remote); await git(producer, 'init', '--initial-branch=main'); await git(producer, 'add', '.'); await git(producer, 'commit', '-m', 'Initial plain Git project'); await git(producer, 'remote', 'add', 'origin', remote); await git(producer, 'push', 'origin', 'main');
  const artifacts = process.env.WERK_WORKER_HOME_ARCHIVES ? resolve(process.env.WERK_WORKER_HOME_ARCHIVES) : join(outer, 'artifacts');
  if (!process.env.WERK_WORKER_HOME_ARCHIVES) await packageRelease(project, artifacts);
  const extracted = await extractRelease(artifacts, home, 'zip'); entry = join(extracted.root, 'worker.mjs');
  const started = await cli('--no-open', '--port', '0'); url = started.url; token = (await readFile(started.credentialsFile, 'utf8')).trim(); assert.equal(started.stateDirectory, join(home, '.werk', 'worker'));
  const { chromium } = await import(process.env.WERK_PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.WERK_PLAYWRIGHT_MODULE)).href : 'playwright');
  browser = await chromium.launch({ ...(process.env.WERK_CHROMIUM ? { executablePath: process.env.WERK_CHROMIUM } : {}), args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(30000); page.on('pageerror', error => result.pageErrors.push(error.message));
  await page.goto(url); await page.getByLabel('Worker access token', { exact: true }).fill(token); await page.getByRole('button', { name: 'Unlock worker', exact: true }).click(); await page.getByRole('button', { name: 'Lock', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Prepare your first Feature Request', exact: true }).waitFor();
  assert.equal(await page.getByText(/Assignments:.*simulation/i).count(), 0);
  result.checks.push('Verified archive starts in an empty dedicated home and unlocks through the real browser without source/npm/init.'); await screenshot('01-first-worker-home');
  // Configure ordinary supported provider/settings and project setup endpoints; no injected model or private runtime hooks.
  await api('/api/settings', { defaultProvider: 'claude-cli', provider: { id: 'claude-cli', authenticationMode: 'cli-account', executable: fixture, model: 'deterministic-protocol-fixture' }, board: { paused: true } });
  const registered = await api('/api/managed-projects', { action: 'register', id: 'company', operationId: 'browser-register', repository: pathToFileURL(remote).href }); const checkout = registered.projects[0].path;
  const setup = await api('/api/managed-projects', { action: 'setup_plan', id: 'company', provider: 'claude-cli' });
  await api('/api/managed-projects', { action: 'setup_apply', id: 'company', operationId: 'browser-workflow', expectedPlan: setup.planDigest });
  const policy = await api('/api/requests', { action: 'delivery_policy', projectId: 'company' }); assert.equal(policy.configuration.localMerge, true); assert.equal(policy.configuration.remoteDelivery, undefined);
  await api('/api/requests', { action: 'approve_delivery_policy', repositoryId: 'company', configurationDigest: policy.configurationDigest, expectedApprovalRevision: policy.approvalRevision });
  const enabled = await api('/api/managed-projects', { action: 'reconcile', id: 'company', operationId: 'browser-enable' }); assert.equal(enabled.projects[0].intakeEnabled, true);
  const grant = await api('/api/tool-access'); await api('/api/tool-access', { expectedRevision: grant.revision, builtins: { ...grant.builtins, files: true, commands: [{ id: 'browser-value', name: 'Verify exported value', executable: process.execPath, args: ['tests/value.mjs'], enabled: true, verification: true }] }, mcp: [] });
  await page.reload(); await page.getByRole('heading', { name: 'Taskboard', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'New request', exact: true }).click();
  const composer = page.locator('.shared-feature-composer'); await composer.getByRole('heading', { name: 'Create a feature request', exact: true }).waitFor();
  await composer.getByLabel('Project', { exact: true }).selectOption('company');
  await composer.getByLabel('Request instructions', { exact: true }).fill('Change the exported value from one to two within the approved source file.');
  await composer.locator('.request-options > summary').click(); await composer.getByLabel('Request name · optional', { exact: true }).fill('Downloaded worker value increment'); await composer.getByLabel('Approved repository paths · one per line', { exact: true }).fill('src/value.mjs');
  await composer.getByRole('button', { name: 'Prepare request', exact: true }).click();
  await composer.getByLabel('Context', { exact: true }).fill('Preserve unrelated source and committed verification. This acceptance uses a deterministic protocol fixture.');
  await composer.getByLabel('Acceptance criteria', { exact: true }).fill('- The exported value is two and the committed value test passes.');
  await composer.getByLabel('Verification plan', { exact: true }).fill('Run the committed tests/value.mjs on the isolated candidate and inspect its exact diff.');
  await composer.getByRole('button', { name: /Check readiness|Check request details/, exact: true }).click();
  const publication = page.waitForResponse(response => response.url().endsWith('/api/features') && response.request().method() === 'POST' && response.request().postDataJSON().action === 'publish');
  await composer.getByRole('button', { name: 'Mark ready and publish', exact: true }).click(); const published = await publication; const ready = await published.json(); assert.ok(published.ok(), JSON.stringify(ready)); assert.ok(ready.publication?.commit);
  assert.equal(await git(remote, 'show', 'main:src/value.mjs'), 'export const value = 1;'); await assert.rejects(readFile(join(outer, 'fixture-calls.jsonl')), { code: 'ENOENT' });
  result.checks.push('Browser prepares, completes, checks and commits/pushes a ready Feature Request before any inference.'); await screenshot('02-published-feature-request');
  await api('/api/settings', { board: { paused: false } });
  let shared;
  /** @type {import('../../src/worker/application/shared-intake-contract.js').SharedFeatureView | undefined} */
  let record;
  let progressCaptured = false;
  await until(async () => { await api('/api/shared-intake', { action: 'sync', projectId: 'company' }); shared = await api('/api/shared-intake?projectId=company'); record = shared.requests.find(item => item.id === ready.featureId); if (record?.error) throw Error(record.error); if (record?.taskId && !progressCaptured && record.status !== 'ready_for_review') { await refresh(); await screenshot('03-taskboard-in-progress'); progressCaptured = true; } return record?.status === 'ready_for_review' && record.publication === 'synced'; }, 'verified candidate and Markdown review publication', 180000);
  assert.ok(record); assert.ok(record.taskId && record.featureBranch && record.reviewNote);
  const publishedFeatureCommit = await git(remote, 'rev-parse', 'refs/heads/' + record.featureBranch), reviewMarkdown = await git(remote, 'show', 'main:' + record.reviewNote);
  const catalog = await api('/api/sessions'), local = catalog.records.find(item => item.feature?.id === ready.featureId && item.feature.repositoryId === 'company'); assert.ok(local?.requestId);
  const subject = await api('/api/requests', { action: 'get', requestId: local.requestId }); const candidateCommit = subject.delivery.review.candidate.candidateCommit;
  assert.equal(await git(checkout, 'rev-parse', candidateCommit + '^{tree}'), await git(remote, 'rev-parse', publishedFeatureCommit + '^{tree}'), 'Shared publication and the independently verified local candidate must have identical complete trees.');
  assert.equal(await git(remote, 'show', publishedFeatureCommit + ':src/value.mjs'), 'export const value = 2;'); assert.match(reviewMarkdown, /Required checks passed for this candidate/); assert.ok(reviewMarkdown.includes(publishedFeatureCommit));
  assert.equal(await git(remote, 'show', 'main:src/value.mjs'), 'export const value = 1;'); assert.equal(await readFile(join(checkout, 'src/value.mjs'), 'utf8'), 'export const value = 1;\n');
  await refresh(); await page.getByRole('heading', { name: 'Worker updates', exact: true }).waitFor(); await screenshot('04-taskboard-review-ready');
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Downloaded worker value increment', exact: true }) }).first(); await card.getByRole('button', { name: /Review changes|Review result|Review candidate/ }).click();
  await page.getByRole('heading', { name: 'Record your review', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Open Markdown pull request', exact: true }).click(); await page.locator('.delivery-publication details[open]').waitFor();
  await screenshot('05-markdown-candidate-review');
  const outcomes = page.getByLabel('Review outcome', { exact: true }); for (let index = 0; index < await outcomes.count(); index++) { await outcomes.nth(index).selectOption('passed'); await page.getByLabel('What you checked or what needs to change', { exact: true }).nth(index).fill('Inspected the exact source diff and observed the committed value check pass.'); }
  await page.getByLabel('Review note', { exact: true }).fill('Accepted this exact candidate after reviewing its diff, real committed check and plain Git Markdown handoff.');
  await page.getByRole('button', { name: 'Record acceptance', exact: true }).click(); await page.getByRole('heading', { name: 'Acceptance recorded for this result', exact: true }).waitFor();
  const consent = page.getByLabel(/I approve merging this reviewed candidate into this project/); await consent.waitFor(); await until(() => consent.isEnabled(), 'current main checkout merge authority');
  assert.equal(await readFile(join(checkout, 'src/value.mjs'), 'utf8'), 'export const value = 1;\n'); await consent.check();
  await page.getByRole('button', { name: 'Merge reviewed candidate into main checkout', exact: true }).click(); await page.getByRole('status').filter({ hasText: 'Main checkout merge confirmed on main at' }).waitFor();
  assert.equal(await readFile(join(checkout, 'src/value.mjs'), 'utf8'), 'export const value = 2;\n'); await git(checkout, 'merge-base', '--is-ancestor', candidateCommit, 'HEAD'); assert.equal(await git(checkout, 'status', '--porcelain'), '');
  result.checks.push('Real candidate tools, committed verification, feature commit/push and Markdown pull request appear before browser acceptance; explicit exact-main consent merges into checkout.');
  await screenshot('06-main-checkout-merge-confirmed'); assert.deepEqual(result.pageErrors, []);
  const calls = (await readFile(join(outer, 'fixture-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); assert.equal(calls.filter(item => item.mode === 'candidate-tools').length, 1);
  const manifestContent = await readFile(join(extracted.root, 'release-manifest.json')), manifest = JSON.parse(manifestContent.toString('utf8'));
  Object.assign(result, { version: extracted.version, sourceCommit: manifest.sourceCommit, archiveSha256: createHash('sha256').update(await readFile(join(artifacts, 'werk-' + extracted.version + '.zip'))).digest('hex'), manifestSha256: createHash('sha256').update(manifestContent).digest('hex'), candidateCommit, publishedFeatureCommit, mergedCommit: await git(checkout, 'rev-parse', 'HEAD'), reviewNote: record.reviewNote, providerInvocations: calls });
  for (const name of ['failure.json', 'failure.png', 'failure-page.txt', 'failure-shared.json']) await rm(join(evidence, name), { force: true });
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ checks: result.checks.length, evidence, liveProvider: false }));
} catch (error) {
  await page?.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ ...result, error: error.message }, null, 2));
  await writeFile(join(evidence, 'failure-page.txt'), await page?.locator('body').innerText().catch(() => '') ?? '');
  if (url && token) await writeFile(join(evidence, 'failure-shared.json'), JSON.stringify(await api('/api/shared-intake?projectId=company').catch(() => null), null, 2));
  throw error;
} finally { await browser?.close(); if (entry) await cli('stop').catch(() => {}); await rm(outer, { recursive: true, force: true }); }
