import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, input } from './ready-review-fixtures.mjs';
import { readyReviewModels } from '../../src/worker/dist/worker/infrastructure/ready-review-model.js';
import { createProcessObservation } from '../../src/worker/dist/worker/infrastructure/process-observation.js';
import { FileModelSessionStore } from '../../src/worker/dist/worker/infrastructure/model-session-store.js';

// A local executable exercises the shipping subscription adapter without an account or paid request.
test('subscription Ready Check freezes model and effort, disables tools and reuses durable outcomes across reconstruction', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const observations = createProcessObservation();
  const f = await fixture(t, { maxRuntimeMs: 10000, model: ({ directory, settings, consumption, sessions }) => readyReviewModels(directory, settings, consumption, sessions.runs, observations) });
  const executable = join(f.directory, 'ready-review-claude-fixture'), log = join(f.directory, 'provider-calls.jsonl');
  await writeFile(executable, '#!' + process.execPath + '\n' + `
const fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2);
if (args.join(' ') === 'auth status') { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
if (args.includes('--version')) { process.stdout.write('2.1.277 (Claude Code)'); process.exit(0); }
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', data => input += data);
process.stdin.on('end', () => {
  const id = args[args.indexOf('--session-id') + 1];
  const states = fs.readdirSync(${JSON.stringify(join(f.directory, 'model-sessions'))}).filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(${JSON.stringify(join(f.directory, 'model-sessions'))}, name), 'utf8')));
  const checkpoint = states.find(state => state.checkpoint?.nativeId === id);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, id, input: JSON.parse(input), checkpoint, instructions: fs.readFileSync(args[args.indexOf('--system-prompt-file') + 1], 'utf8') }) + '\\n');
  const assessment = checkpoint.binding.generation === 1 ? { schemaVersion: 1, passed: false, summary: 'Clarify the target.', findings: [{ kind: 'question', message: 'Which target?', blocking: true }] } : { schemaVersion: 1, passed: true, summary: 'The request is actionable.', findings: [] };
  process.stdout.write(JSON.stringify({ type: 'result', session_id: id, result: JSON.stringify(assessment), usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, total_cost_usd: 0.01 }));
});
`, { mode: 0o700 });
  await f.settings.update({ provider: { id: 'claude-cli', executable, model: 'original-model' } });
  f.selectedProfile.id = 'claude-cli'; f.selectedProfile.authenticationMode = 'cli-account'; f.selectedProfile.effort = 'medium';
  const first = input(); first.provider = 'claude-cli';
  first.selection = { provider: 'claude-cli', authenticationMode: 'cli-account', model: 'original-model', effort: 'medium' };
  const attempt = await f.schedule(first); await f.settle();
  assert.equal(f.manager.inspect(first).result.passed, false);
  const turn = f.sessions.interactions.turn(attempt.sessionId, attempt.turnId), binding = turn.dispatch.session;
  assert.ok(binding);
  const store = new FileModelSessionStore(f.directory), checkpoint = await store.load(binding);
  assert.equal(checkpoint.status, 'idle'); assert.ok(checkpoint.checkpoint.nativeId);
  assert.equal(checkpoint.binding.featureRequestKey, first.feature.key);
  assert.equal(f.consumption.status().measuredTokens, 13);
  const observed = (await observations.status()).processes;
  assert.equal(observed.length, 1, 'Version probes are excluded from the execution process view.');
  assert.deepEqual([observed[0].featureRequestKey, observed[0].sessionId, observed[0].runId], [first.feature.key, attempt.sessionId, attempt.runId]);
  assert.equal(observed[0].kind, 'provider'); assert.equal(observed[0].state, 'exited');
  await f.settings.update({ provider: { id: 'claude-cli', model: 'updated-model', effort: 'high' } });
  await f.restart(); assert.deepEqual(await f.schedule(first), attempt);
  assert.equal((await observations.status()).processes.length, 1, 'Retained completed review cannot spawn another CLI.');
  const second = input('feature-one', 2); second.provider = 'claude-cli'; second.selection = { ...first.selection };
  second.previousAssessment = f.manager.inspect(first).result;
  const secondAttempt = await f.schedule(second); await f.settle();
  assert.equal(f.manager.inspect(second).result.passed, true);
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 2); assert.notEqual(calls[0].id, calls[1].id, 'A new committed review generation must not resume an uncertain earlier native invocation.');
  assert.deepEqual(calls.map(call => call.checkpoint.binding.generation), [1, 2]);
  assert.deepEqual(calls.map(call => call.args[call.args.indexOf('--model') + 1]), ['original-model', 'original-model']);
  assert.deepEqual(calls.map(call => call.args[call.args.indexOf('--effort') + 1]), ['medium', 'medium']);
  for (const call of calls) {
    assert.equal(call.checkpoint.status, 'running', 'The native execution fence must exist before the subprocess runs.');
    assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
    assert.equal(call.args[call.args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
    for (const flag of ['--restricted', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(call.args.includes(flag));
    assert.equal(call.args.includes('--resume'), false); assert.equal(call.input.length, 1);
    assert.match(call.instructions, /No tools, commands/);
    assert.equal(call.input[0].content.split(first.prompt.content).length, 2);
  }
  assert.ok(calls[1].input[0].content.includes(JSON.stringify(second.previousAssessment)));
  assert.equal(f.consumption.status().measuredTokens, 26);
  const after = (await observations.status()).processes;
  assert.equal(after.length, 2); assert.equal(after[1].runId, secondAttempt.runId); assert.equal(after[1].sessionId, attempt.sessionId);
  assert.equal(f.sessions.requests.list().total, 0);
});
