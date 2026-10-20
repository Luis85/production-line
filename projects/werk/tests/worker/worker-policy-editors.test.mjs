import test from 'node:test';
import assert from 'node:assert/strict';
import { reactive, nextTick } from 'vue';
import { frontend, deferred } from '../ui/helpers/frontend-loader.mjs';
const { createQueueSettingsEditor, createDurationSettingsEditor, queuePolicy, durationPolicy } = await frontend('src/worker/webview/worker-policy-editors.ts');
const queue = (overrides = {}) => ({ maxParallel: 1, queueCapacity: 16, orchestratorQueue: 0, order: 'fifo', ...overrides });
const inspection = (overrides = {}) => ({ candidateSourceMaxBytes: 64 * 1024 * 1024, candidateSourceMaxFiles: 20000, candidateFileMaxBytes: 8 * 1024 * 1024, ...overrides });
const duration = (overrides = {}) => ({ longRunningMs: 3600000, maxRuntimeMs: 21600000, maxToolCalls: 128, commandTimeoutMs: 300000, ...inspection(), fromEnvironment: false, ...overrides });
function editor(t, kind = 'queue', initial) {
  const state = reactive({ unlocked: true, epoch: 0, saved: initial ?? (kind === 'queue' ? queue() : duration()) });
  const commands = [];
  let write = async command => {
    state.saved = kind === 'queue' ? command.board : { ...command.execution, longRunningMs: command.resources.longRunningMs, maxRuntimeMs: command.execution?.maxRuntimeMs ?? state.saved.maxRuntimeMs, maxToolCalls: command.execution.maxToolCalls, commandTimeoutMs: command.execution.commandTimeoutMs, fromEnvironment: state.saved.fromEnvironment };
    return state.saved;
  }, refresh = async () => {};
  const create = kind === 'queue' ? createQueueSettingsEditor : createDurationSettingsEditor;
  const e = create({ saved: () => state.saved, unlocked: () => state.unlocked, epoch: () => state.epoch, write: command => { commands.push(structuredClone(command)); return write(command); }, refresh: () => refresh() });
  t.after(e.dispose);
  return { ...e, state, commands, onWrite: fn => { write = fn; }, onRefresh: fn => { refresh = fn; } };
}
test('queue form validates numeric bounds and submits only guarded policy fields, preserving pause authority', async t => {
  assert.deepEqual(queuePolicy({ board: { ...queue(), paused: true, maxParallel: 1 } }), queue());
  const e = editor(t);
  for (const capacity of ['', 0, 65, 1.2, 'Infinity']) { e.draft.values.queueCapacity = capacity; assert.match(e.validation.value, /1 to 64/); await e.save(); }
  assert.equal(e.commands.length, 0);
  e.draft.values.queueCapacity = 8;
  for (const remote of ['', -1, 65, .5]) { e.draft.values.orchestratorQueue = remote; assert.match(e.validation.value, /0 to 64/); }
  e.draft.values.orchestratorQueue = 0; e.draft.values.order = 'priority';
  assert.equal(e.canSave.value, true); await e.save();
  assert.deepEqual(e.commands, [{ board: queue({ queueCapacity: 8, order: 'priority' }), expectedBoard: queue() }]);
  assert.equal(e.dirty.value, false); assert.match(e.draft.notice, /saved/);
});
test('pristine queue refreshes follow saved settings; dirty drafts reject stale saves and survive expiry', async t => {
  const e = editor(t); e.state.saved = queue({ queueCapacity: 10 }); await nextTick();
  assert.equal(e.draft.values.queueCapacity, 10);
  e.draft.values.queueCapacity = 4; e.state.saved = queue({ queueCapacity: 9 }); await nextTick();
  assert.equal(e.stale.value, true); assert.equal(e.draft.values.queueCapacity, 4);
  await e.save(); assert.equal(e.commands.length, 0);
  e.state.unlocked = false; e.state.saved = null; await nextTick(); assert.equal(e.draft.values.queueCapacity, 4);
  e.state.saved = queue({ queueCapacity: 9 }); e.state.unlocked = true; await nextTick(); e.reload();
  assert.equal(e.draft.values.queueCapacity, 9); assert.equal(e.dirty.value, false); assert.equal(e.stale.value, false);
});
test('queue saves retain their submitted baseline, prevent duplicates and preserve later edits', async t => {
  const e = editor(t), pending = deferred(); e.draft.values.queueCapacity = 8;
  e.onWrite(() => pending.promise); const saving = e.save(); await e.save();
  assert.equal(e.commands.length, 1); assert.equal(e.locked.value, true); assert.deepEqual(e.commands[0].expectedBoard, queue());
  e.draft.values.orchestratorQueue = 4; e.state.saved = queue({ queueCapacity: 8 }); pending.resolve(e.state.saved); await saving;
  assert.equal(e.draft.values.orchestratorQueue, 4); assert.equal(e.dirty.value, true); assert.match(e.draft.notice, /newer edits/);
});
test('lost acknowledgement retries the exact command and reconciles a successful retry conflict', async t => {
  const e = editor(t); e.draft.values.queueCapacity = 8;
  e.onWrite(async () => { throw Error('Connection lost'); }); await e.save();
  assert.equal(e.locked.value, true); assert.match(e.draft.error, /Connection lost/); assert.ok(e.draft.uncertain);
  e.onWrite(async () => { throw Object.assign(Error('Reload current queue settings'), { status: 409 }); });
  e.onRefresh(async () => { e.state.saved = queue({ queueCapacity: 8 }); }); await e.retry();
  assert.deepEqual(e.commands[0], e.commands[1]); assert.equal(e.draft.uncertain, null); assert.equal(e.dirty.value, false); assert.match(e.draft.notice, /saved/);
});
test('a conflicting queue save keeps the draft and requires explicit reload of a changed policy', async t => {
  const e = editor(t); e.draft.values.queueCapacity = 8;
  e.onWrite(async () => { throw Object.assign(Error('Reload current queue settings'), { status: 409 }); });
  e.onRefresh(async () => { e.state.saved = queue({ queueCapacity: 7 }); }); await e.save();
  assert.equal(e.stale.value, true); assert.equal(e.draft.uncertain, null); assert.equal(e.draft.values.queueCapacity, 8); assert.match(e.draft.error, /Reload/);
  await e.save(); assert.equal(e.commands.length, 1); e.reload(); assert.equal(e.draft.values.queueCapacity, 7); assert.equal(e.draft.error, '');
});
test('explicit lock clears draft and uncertain submission and suppresses a delayed save acknowledgement', async t => {
  const e = editor(t), pending = deferred(); e.draft.values.queueCapacity = 8; e.onWrite(() => pending.promise);
  const saving = e.save(); e.state.epoch++; e.state.unlocked = false; e.state.saved = null; await nextTick();
  pending.resolve(queue({ queueCapacity: 8 })); await saving;
  assert.equal(e.draft.baseline, null); assert.equal(e.draft.uncertain, null); assert.equal(e.draft.notice, ''); assert.equal(e.draft.busy, false);
});
test('unconfirmed saves remain recoverable after a failed refresh and can be discarded explicitly', async t => {
  const e = editor(t); e.draft.values.queueCapacity = 8; e.onWrite(async () => undefined); await e.save();
  assert.match(e.draft.error, /could not be confirmed/); assert.ok(e.draft.uncertain);
  e.onRefresh(async () => { throw Error('Worker offline'); }); await e.check();
  assert.equal(e.draft.checking, false); assert.match(e.draft.error, /offline/); assert.ok(e.draft.uncertain);
  e.reload(); assert.equal(e.draft.uncertain, null); assert.equal(e.draft.values.queueCapacity, 16); assert.equal(e.dirty.value, false);
});
test('duration saves validate both fields and atomically submit warning, maximum and their baseline', async t => {
  const e = editor(t, 'duration');
  for (const value of ['', 0, -1, 25, Infinity]) { e.draft.values.warningHours = value; assert.match(e.validation.value, /one second to 24 hours/); await e.save(); }
  assert.equal(e.commands.length, 0); e.draft.values.warningHours = 1 / 3600;
  e.draft.values.maximumHours = 25; assert.match(e.validation.value, /one second to 24 hours/);
  e.draft.values.maximumHours = 24; await e.save();
  assert.deepEqual(e.commands[0], { resources: { longRunningMs: 1000 }, execution: { ...inspection(), maxRuntimeMs: 86400000, maxToolCalls: 128, commandTimeoutMs: 300000 }, expectedDuration: { longRunningMs: 3600000, maxRuntimeMs: 21600000 }, expectedToolBudget: { maxToolCalls: 128, commandTimeoutMs: 300000 }, expectedCandidateInspection: inspection() });
  assert.equal(e.dirty.value, false); assert.match(e.draft.notice, /New attempts/);
});
test('environment-controlled maximum stays authoritative and is omitted from warning-only saves', async t => {
  const settings = { resources: { longRunningMs: 3600000 }, execution: { maxRuntimeMs: 7200000 }, executionSource: 'environment' };
  const initial = durationPolicy(settings); assert.equal(initial.fromEnvironment, true);
  const e = editor(t, 'duration', initial); e.draft.values.warningHours = .5; e.draft.values.maximumHours = 25;
  assert.equal(e.validation.value, ''); await e.save();
  assert.deepEqual(e.commands[0], { resources: { longRunningMs: 1800000 }, execution: { ...inspection(), maxToolCalls: 128, commandTimeoutMs: 300000 }, expectedDuration: { longRunningMs: 3600000, maxRuntimeMs: 7200000 }, expectedToolBudget: { maxToolCalls: 128, commandTimeoutMs: 300000 }, expectedCandidateInspection: inspection() });
  assert.equal(e.draft.values.maximumHours, 2);
});
test('duration authority changes make an in-progress draft stale until reloaded', async t => {
  const e = editor(t, 'duration'); e.draft.values.maximumHours = 8;
  e.state.saved = duration({ maxRuntimeMs: 7200000, fromEnvironment: true }); await nextTick();
  assert.equal(e.stale.value, true); await e.save(); assert.equal(e.commands.length, 0);
  e.reload(); assert.equal(e.draft.baseline.fromEnvironment, true); assert.equal(e.draft.values.maximumHours, 2);
});

test('tool budget inputs reject invalid bounds and preserve the existing policy until one guarded save', async t => {
  const e = editor(t, 'duration');
  for (const value of ['', 0, 513, 1.5, Infinity]) { e.draft.values.maxToolCalls = value; assert.match(e.validation.value, /tool-call limit/); await e.save(); }
  e.draft.values.maxToolCalls = 256;
  for (const value of ['', 0, 3601, Infinity]) { e.draft.values.commandSeconds = value; assert.match(e.validation.value, /command timeout/); await e.save(); }
  assert.equal(e.commands.length, 0);
  e.draft.values.commandSeconds = 900; await e.save();
  assert.deepEqual(e.commands[0].execution, { ...inspection(), maxRuntimeMs: 21600000, maxToolCalls: 256, commandTimeoutMs: 900000 });
  assert.deepEqual(e.commands[0].expectedToolBudget, { maxToolCalls: 128, commandTimeoutMs: 300000 });
  assert.deepEqual(e.commands[0].expectedDuration, { longRunningMs: 3600000, maxRuntimeMs: 21600000 });
  assert.equal(e.dirty.value, false);
});
test('concurrent tool-budget edits retain the duration draft and require explicit reconciliation', async t => {
  const e = editor(t, 'duration'); e.draft.values.maximumHours = 8; e.draft.values.maxToolCalls = 64;
  e.state.saved = duration({ commandTimeoutMs: 900000 }); await nextTick();
  assert.equal(e.stale.value, true); await e.save(); assert.equal(e.commands.length, 0);
  assert.equal(e.draft.values.maximumHours, 8); assert.equal(e.draft.values.maxToolCalls, 64);
  e.reload(); assert.equal(e.draft.values.commandSeconds, 900); assert.equal(e.draft.values.maximumHours, 6);
});
test('lost tool-budget acknowledgement retries the original duration and budget guards even under an environment limit', async t => {
  const e = editor(t, 'duration', duration({ fromEnvironment: true }));
  e.draft.values.maxToolCalls = 64; e.draft.values.commandSeconds = 600;
  e.onWrite(async () => { throw Error('Response lost'); }); await e.save();
  const submitted = structuredClone(e.commands[0]);
  assert.equal('maxRuntimeMs' in submitted.execution, false); assert.ok(e.draft.uncertain);
  e.draft.values.maxToolCalls = 128;
  e.onWrite(async () => duration({ fromEnvironment: true, maxToolCalls: 64, commandTimeoutMs: 600000 })); await e.retry();
  assert.deepEqual(e.commands[1], submitted); assert.equal(e.draft.uncertain, null);
});


test('inspection defaults use readable units and preserve exact saved bytes through an unrelated edit', async t => {
  const defaults = durationPolicy({ resources: { longRunningMs: 3600000 }, execution: { maxRuntimeMs: 7200000 } });
  assert.deepEqual({ candidateSourceMaxBytes: defaults.candidateSourceMaxBytes, candidateSourceMaxFiles: defaults.candidateSourceMaxFiles, candidateFileMaxBytes: defaults.candidateFileMaxBytes }, inspection());
  const exact = inspection({ candidateSourceMaxBytes: 64 * 1024 * 1024 + 1, candidateFileMaxBytes: 8 * 1024 * 1024 + 1 });
  const e = editor(t, 'duration', duration(exact));
  assert.equal(e.draft.values.sourceMiB, exact.candidateSourceMaxBytes / 1048576); assert.equal(e.dirty.value, false);
  e.draft.values.warningHours = 2; await e.save();
  assert.deepEqual(e.commands[0].expectedCandidateInspection, exact);
  assert.equal(e.commands[0].execution.candidateSourceMaxBytes, exact.candidateSourceMaxBytes);
  assert.equal(e.commands[0].execution.candidateFileMaxBytes, exact.candidateFileMaxBytes); assert.equal(e.dirty.value, false);
});

test('inspection form rejects out-of-range, fractional-byte and inconsistent limits before saving', async t => {
  const e = editor(t, 'duration');
  /** @type {Array<[string, Array<string | number>, RegExp]>} */
  const cases = [
    ['sourceMiB', ['', 0, 1025, Infinity, 1.00000001], /total source/],
    ['sourceFiles', ['', 0, 200001, 1.5, Infinity], /file limit/],
    ['fileMiB', ['', 0, 0.0624, 257, Infinity, 8.00000001], /individual file/],
  ];
  for (const [field, values, message] of cases) {
    for (const value of values) { e.draft.values[field] = value; assert.match(e.validation.value, message); await e.save(); }
    e.reload();
  }
  e.draft.values.sourceMiB = 4; e.draft.values.fileMiB = 8; assert.match(e.validation.value, /cannot exceed/); await e.save();
  assert.equal(e.commands.length, 0);
  e.draft.values.fileMiB = .0625; e.draft.values.sourceFiles = 200000; await e.save();
  assert.equal(e.commands[0].execution.candidateSourceMaxBytes, 4194304); assert.equal(e.commands[0].execution.candidateFileMaxBytes, 65536);
  assert.equal(e.commands[0].execution.candidateSourceMaxFiles, 200000);
});

test('concurrent inspection edits block stale duration saves and preserve the draft until explicit reload', async t => {
  const e = editor(t, 'duration'); e.draft.values.maximumHours = 8; e.draft.values.sourceFiles = 40000;
  e.state.saved = duration({ candidateSourceMaxBytes: 128 * 1048576 }); await nextTick();
  assert.equal(e.stale.value, true); assert.equal(e.draft.values.sourceFiles, 40000); await e.save(); assert.equal(e.commands.length, 0);
  e.reload(); assert.equal(e.draft.values.sourceMiB, 128); assert.equal(e.draft.values.maximumHours, 6); assert.equal(e.stale.value, false);
});

test('an uncertain inspection save retries the exact byte values and baseline under an environment duration', async t => {
  const e = editor(t, 'duration', duration({ fromEnvironment: true })); e.draft.values.sourceMiB = 128; e.draft.values.fileMiB = 16;
  e.onWrite(async () => { throw Error('Response lost'); }); await e.save(); const submitted = structuredClone(e.commands[0]);
  assert.equal('maxRuntimeMs' in submitted.execution, false); assert.deepEqual(submitted.expectedCandidateInspection, inspection());
  e.draft.values.sourceMiB = 256;
  e.onWrite(async () => duration({ fromEnvironment: true, candidateSourceMaxBytes: 128 * 1048576, candidateFileMaxBytes: 16 * 1048576 })); await e.retry();
  assert.deepEqual(e.commands[1], submitted); assert.equal(e.draft.uncertain, null);
});


test('a refreshed saved inspection policy confirms a lost acknowledgement without another write', async t => {
  const e = editor(t, 'duration'); e.draft.values.sourceMiB = 128;
  e.onWrite(async () => { throw Error('Response lost'); }); await e.save(); assert.ok(e.draft.uncertain);
  e.state.saved = durationPolicy({ resources: { longRunningMs: 3600000 }, execution: { maxRuntimeMs: 21600000, maxToolCalls: 128, commandTimeoutMs: 300000, ...inspection({ candidateSourceMaxBytes: 128 * 1048576 }) } });
  await nextTick(); assert.equal(e.draft.uncertain, null); assert.equal(e.dirty.value, false); assert.equal(e.commands.length, 1);
});

test('execution capacity is bounded and submitted with the exact machine baseline', async t => {
  const e = editor(t);
  for (const value of ['', 0, 9, 1.5]) { e.draft.values.maxParallel = value; assert.match(e.validation.value, /1 to 8/); await e.save(); }
  assert.equal(e.commands.length, 0); e.draft.values.maxParallel = 3; await e.save();
  assert.equal(e.commands[0].board.maxParallel, 3); assert.equal(e.commands[0].expectedBoard.maxParallel, 1);
});
