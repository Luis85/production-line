import test, { before } from 'node:test';
import { prepareProcessRuntime } from '../../src/worker/dist/shared/process/launcher.js';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { LocalTaskboard, WorkerSessions } from './application-fixtures.mjs';

// The real session composition includes trusted history tools. Prepare their native runtime
// outside the unchanged proposal/checkpoint bounds: 45 s setup plus 5 s cleanup margin.
before(async t => prepareProcessRuntime(process.cwd(), t.signal), { timeout: 50000 });

// These are offline wire-format fixtures through the real API adapters, not live inference.
function envelope(provider, text) {
  return provider === 'openai-api'
    ? { status: 'completed', usage: { input_tokens: 8, output_tokens: 3 }, output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
    : { stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text }] };
}

for (const provider of ['openai-api', 'anthropic-api']) {
  test(`${provider} unwraps a proposal for readable chat while preserving protocol evidence and checkpoint replay`, { timeout: process.platform === 'win32' ? 90_000 : 45_000 }, async t => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-readable-adapter-')));
    let sessions, board;
    t.after(async () => {
      await board?.close();
      await sessions?.close();
      await rm(directory, { recursive: true, force: true });
    });
    const repository = join(directory, 'repository');
    await mkdir(repository);
    await writeFile(join(repository, 'checkout.txt'), 'before\n');
    const settings = new WorkerSettings(directory);
    await settings.init();
    await settings.update({ provider: { id: provider, model: 'offline-fixture-model', apiKey: 'fixture-only' }, board: { queueCapacity: 2, paused: false } });

    const checkpoint = { schemaVersion: 1, kind: 'question', message: 'Keep the original line in checkout.txt?', choices: [{ id: 'keep', label: 'Keep the original line' }], reason: 'The approved file contains existing text.' };
    const checkpointText = JSON.stringify({ werkInteraction: checkpoint });
    const summary = 'Updated checkout.txt.\n\nTests belong in ../tests/unit/**/*.spec.ts; tests were not run.';
    // Deliberate JSON indentation and a private file body expose accidental reserialization or transcript leakage.
    const patchText = JSON.stringify({ summary, files: [{ path: 'checkout.txt', content: 'before\nPRIVATE-FILE-BODY\n' }] }, null, 2);
    const requests = [];
    const transport = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      assert.ok(requests.length <= 2, 'The worker must not retry completed fixture responses.');
      return Response.json(envelope(provider, requests.length === 1 ? checkpointText : patchText));
    };
    const adapter = (connection, stateDirectory, _transport, options) => modelFor(connection, stateDirectory, transport, options);
    sessions = WorkerSessions(directory, settings, adapter);
    await sessions.init();
    board = LocalTaskboard(directory, settings, sessions, adapter);
    await board.init();
    await board.create({ title: 'Readable adapter proposal', instruction: 'Append the approved fixture line.', repository, paths: ['checkout.txt'], provider });
    const id = board.view().tasks.at(-1).id;
    const sessionId = board.detail(id).sessionId;
    async function settle(status) {
      const timeoutMs = process.platform === 'win32' ? 60_000 : 20_000;
      const deadline = performance.now() + timeoutMs;
      t.signal.throwIfAborted();
      await board.tick();
      while (performance.now() < deadline) {
        t.signal.throwIfAborted();
        if (board.detail(id).status === status && !sessions.executor.busy) return;
        await delay(10, undefined, { signal: t.signal });
      }
      const task = board.detail(id), interaction = sessions.interactions.view(sessionId);
      assert.fail(`Expected ${status} within ${timeoutMs} ms: ${JSON.stringify({ taskStatus: task.status, taskError: task.error, interactionPhase: interaction.phase, executorBusy: sessions.executor.busy, providerRequests: requests.length })}`);
    }

    await settle('waiting_input');
    const waiting = sessions.interactions.view(sessionId);
    assert.deepEqual(sessions.interactions.turn(sessionId, waiting.latestTurn.id).result, { type: 'needs_input', request: checkpoint });
    /** @type {import('../../src/worker/application/interactions.js').InteractionCommand} */
    const answer = { action: 'answer', sessionId, pendingId: waiting.pending.id, expectedRevision: waiting.revision, operationId: 'answer-offline-checkpoint', answer: 'keep' };
    await board.interact(answer);
    await settle('review');
    await board.interact(answer);
    assert.equal(requests.length, 2, 'Replaying the accepted answer must not invoke the provider twice.');

    const finished = sessions.interactions.view(sessionId);
    const turn = sessions.interactions.turn(sessionId, finished.latestTurn.id);
    assert.deepEqual(turn.result, { type: 'completed', text: patchText }, 'The original model payload remains durable evidence.');
    assert.equal(turn.dispatch.operation, 'patch');
    assert.deepEqual(turn.dispatch.messages.filter(message => message.role === 'assistant').map(message => message.text), [checkpointText]);
    const sent = provider === 'openai-api' ? requests[1].input : requests[1].messages;
    assert.deepEqual(sent.filter(message => message.role === 'assistant').map(message => message.content), [checkpointText], 'Provider continuation receives protocol JSON, not the readable checkpoint projection.');
    assert.equal(sent.at(-1).content, 'keep');

    const transcript = sessions.detail(sessionId).chat.messages.at(-1);
    assert.equal(transcript.role, 'assistant');
    assert.equal(transcript.state, 'complete');
    assert.match(transcript.text, /Updated checkout\.txt\./);
    assert.match(transcript.text, /`\.\.\/tests\/unit\/\*\*\/\*\.spec\.ts`/);
    assert.match(transcript.text, /\*\*Changed files \(1\)\*\*/);
    assert.match(transcript.text, /- `checkout\.txt` · 1 line added, 0 removed/);
    assert.doesNotMatch(transcript.text, /PRIVATE-FILE-BODY|"files"|"output_text"|"stop_reason"|\\n/);
    assert.match(board.detail(id).patch, /\+PRIVATE-FILE-BODY/);
    assert.equal(await readFile(join(repository, 'checkout.txt'), 'utf8'), 'before\n', 'A proposal must leave the approved checkout unchanged.');
  });
}
