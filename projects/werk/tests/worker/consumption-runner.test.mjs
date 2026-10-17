import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker } from '../../src/worker/dist/worker/runner.js';
import { configuration } from '../../src/worker/dist/worker/config.js';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { workspaceModelFactory } from '../../src/worker/dist/worker/infrastructure/workspace-services.js';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { const deadline = performance.now() + 10000; while (performance.now() < deadline) { if (await predicate()) return; await delay(20); } throw Error('Queued worker did not resume.'); }

test('running worker keeps accepted chats queued and automatically resumes exactly once at the next UTC window', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-consumption-runner-')), stop = new AbortController();
  /** @type {WorkerWorkspace | undefined} */
  let workspace;
  let run, requests = 0, clock = new Date('2026-10-16T23:59:59Z');
  const originalInit = WorkerWorkspace.prototype.init;
  WorkerWorkspace.prototype.init = async function () {
    await originalInit.call(this);
    // @ts-expect-error Inject the private clock to test UTC rollover without waiting a day.
    this.consumption.now = () => clock;
    await this.updateSettings({ consumption: { enabled: true, period: 'daily', allowance: 100, workerPercent: 50, perRunReservation: 40 }, provider: { id: 'openai-api', model: 'protocol-fixture', apiKey: 'fixture-only' } });
    // @ts-expect-error Replace the private provider factory with a deterministic paid-call fixture.
    this.sessions.model = workspaceModelFactory(directory, this.settings, (connection, state) => modelFor(connection, state, async () => {
      requests++; return Response.json({ status: 'completed', usage: { input_tokens: 3, output_tokens: 2 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Fixture reply after reset.' }] }] });
    }), this.consumption);
    const prior = this.consumption.begin('openai-api');
    this.consumption.finish(prior.id, { inputTokens: 30, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null, providerReportedCostUsd: null, costBasis: 'unavailable', source: 'provider_reported', reason: null });
    workspace = this;
  };
  t.after(async () => { stop.abort(); try { await run; } finally { WorkerWorkspace.prototype.init = originalInit; await rm(directory, { recursive: true, force: true }); } });
  const config = await configuration({ 'poll-ms': '100', profiles: 'codex' });
  run = runWorker({ ...config, stateDir: directory, url: '', enrollmentToken: '', statusHost: '127.0.0.1', statusPort: 0 }, stop.signal);
  await Promise.race([until(() => workspace), run.then(() => { throw Error('Worker exited before readiness.'); })]);
  assert.ok(workspace, 'Worker initialization must finish before submitting tasks.');
  for (const id of ['first', 'second']) await workspace.task({ action: 'create', id, title: 'Queued ' + id, provider: 'openai-api', message: 'Answer the fixture.' });
  await delay(350);
  assert.equal(requests, 0); assert.equal(workspace.executor.waiting, 2);
  for (const id of ['first', 'second']) assert.equal(workspace.sessions.detail(id).session.status, 'queued');
  clock = new Date('2026-10-17T00:00:00Z');
  // No wake, retry, policy edit or task resubmission: the actual runner timer owns recovery.
  await until(() => ['first', 'second'].every(id => workspace.sessions.detail(id).session.status === 'completed'));
  assert.equal(requests, 2); assert.equal(workspace.consumption.status().measuredTokens, 10);
  assert.equal(workspace.consumption.status().uncertainInvocations, 0);
  assert.equal(workspace.sessions.runs.list().rows.length, 2);
  for (const id of ['first', 'second']) assert.equal(workspace.sessions.detail(id).chat.messages.at(-1).text, 'Fixture reply after reset.');
  stop.abort(); await run;
});
