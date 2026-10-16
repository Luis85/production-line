import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, lstat, rename, symlink, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDevelopmentRuntime } from '../../src/worker/dist/worker/infrastructure/candidate-tools.js';
import { createToolRuntime } from '../../src/worker/dist/worker/infrastructure/tool-runtime.js';
import { createRepositoryWorktree, repositoryRoot } from '../../src/worker/dist/worker/infrastructure/repositories-git.js';
import { defaultToolPolicy, validateToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { freezeDevelopmentScope, developmentVerified } from '../../src/worker/dist/worker/application/development.js';
import { cleanup } from './fixture-cleanup.mjs';
const signal = () => new AbortController().signal;
const git = (directory, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
async function fixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-candidate-'))), repository = join(directory, 'repo');
  await mkdir(repository); cleanup(t, () => rm(directory, { recursive: true, force: true }));
  git(repository, 'init', '-b', 'main'); git(repository, 'config', 'core.autocrlf', 'false'); git(repository, 'config', 'user.name', 'Fixture'); git(repository, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repository, '.gitignore'), 'generated/\n');
  await writeFile(join(repository, 'sum.mjs'), 'export const sum = (a, b) => a - b;\n');
  await writeFile(join(repository, 'remove.txt'), 'remove me\n');
  await writeFile(join(repository, 'test.mjs'), options.script ?? "import {sum} from './sum.mjs'; import assert from 'node:assert/strict'; assert.equal(sum(2, 3), 5); console.log('candidate passed');\n");
  git(repository, 'add', '.'); git(repository, 'commit', '-m', 'Baseline');
  const base = await repositoryRoot(repository, signal());
  const prepared = await createRepositoryWorktree(base, 'project', 'candidate', signal());
  const info = await lstat(prepared.path), identity = { dev: String(info.dev), ino: String(info.ino), birthtimeMs: info.birthtimeMs };
  let policy = defaultToolPolicy();
  policy.builtins.files = true; policy.builtins.commands = [{ id: 'test', name: 'Project tests', executable: process.execPath, args: ['test.mjs'], enabled: true, verification: true }]; policy = validateToolPolicy(policy);
  const scope = freezeDevelopmentScope(prepared.baseCommit, ['sum.mjs', 'remove.txt', 'new/notes.txt', 'empty.txt'], policy);
  let saved, rejectSave = false;
  const checkpoints = [];
  const create = () => createDevelopmentRuntime({ scope, worktree: prepared.path, worktreeIdentity: identity, repository, initialEvidence: saved, commandTimeoutMs: options.timeout ?? 10000, currentPolicy: () => policy,
    checkpoint: async value => { if (rejectSave) throw Error('disk full'); saved = structuredClone(value); checkpoints.push(saved); },
    verifyWorkspace: async abort => { const value = await createRepositoryWorktree(base, 'project', 'candidate', abort, prepared.baseCommit); assert.equal(value.path, prepared.path); assert.equal(value.reused, true); },
  });
  let candidate = create();
  const broker = createToolRuntime({ policy, currentRevision: () => policy.revision, directory, worktree: prepared.path, worktreeIdentity: identity, development: candidate }); cleanup(t, () => broker.close());
  return { directory, repository, worktree: prepared.path, scope, identity, broker, checkpoints, get candidate() { return candidate; }, get saved() { return saved; }, get policy() { return policy; }, restart() { candidate = create(); }, failWrites() { rejectSave = true; }, revoke() { policy.builtins.files = false; policy.revision++; } };
}
async function apply(f, path, content) { const snapshot = await f.candidate.capture(signal()); return f.candidate.apply({ path, content, expectedHash: snapshot.files.find(file => file.path === path).hash }, signal()); }
const unpack = result => JSON.parse(result.content[0].text);

test('broker performs a real failing test, approved repair and passing test in the pinned worktree', async t => {
  const f = await fixture(t);
  assert.equal(f.checkpoints.length, 0, 'construction and manifest generation have no filesystem or persistence side effects');
  assert.ok(f.broker.manifest.tools.some(tool => tool.name === 'werk_candidate_apply'));
  const failed = await f.broker.call('werk_candidate_check', { preset: 'test' }, signal());
  assert.equal(failed.isError, true); assert.equal(unpack(failed).status, 'failed'); assert.notEqual(unpack(failed).exitCode, 0);
  const status = unpack(await f.broker.call('werk_candidate_status', {}, signal()));
  const expectedHash = status.files.find(file => file.path === 'sum.mjs').hash;
  const result = await f.broker.call('werk_candidate_apply', { path: 'sum.mjs', content: 'export const sum = (a, b) => a + b;\n', expectedHash }, signal());
  assert.equal(result.isError, undefined, result.content[0].text); assert.deepEqual(f.saved.checks, []);
  const passed = unpack(await f.broker.call('werk_candidate_check', { preset: 'test' }, signal()));
  assert.equal(passed.status, 'passed'); assert.equal(passed.exitCode, 0); assert.match(passed.stdout, /candidate passed/);
  const final = await f.candidate.capture(signal());
  assert.equal(developmentVerified(f.scope, final, f.saved), true); assert.match(final.patch, /\+export const sum = \(a, b\) => a \+ b/);
  assert.equal(await readFile(join(f.repository, 'sum.mjs'), 'utf8'), 'export const sum = (a, b) => a - b;\n');
  assert.equal(git(f.repository, 'status', '--porcelain'), '');
  assert.ok(f.checkpoints.some(value => value.checks.some(check => check.status === 'interrupted')), 'running checks are durably incomplete until process and candidate inspection finish');
  f.restart(); assert.equal(developmentVerified(f.scope, await f.candidate.capture(signal()), f.candidate.evidence()), true, 'exact disk/evidence survive restart');
  await apply(f, 'sum.mjs', 'export const sum = (a, b) => a + b + 1;\n');
  assert.equal(developmentVerified(f.scope, await f.candidate.capture(signal()), f.saved), false, 'a later edit invalidates the old success');
});

test('approved additions and deletions produce an applicable patch from actual disk', async t => {
  const f = await fixture(t);
  await apply(f, 'new/notes.txt', 'new file without newline'); await apply(f, 'empty.txt', ''); await apply(f, 'remove.txt', null);
  const candidate = await f.candidate.capture(signal()); assert.deepEqual(candidate.changedPaths, ['empty.txt', 'new/notes.txt', 'remove.txt']);
  const patch = join(f.directory, 'candidate.patch'); await writeFile(patch, candidate.patch);
  git(f.repository, 'apply', '--check', patch);
  assert.equal(await readFile(join(f.repository, 'remove.txt'), 'utf8'), 'remove me\n');
  await assert.rejects(readFile(join(f.worktree, 'remove.txt')), { code: 'ENOENT' });
});

test('candidate tools reject stale, unapproved and administrative writes without touching them', async t => {
  const f = await fixture(t); const current = await f.candidate.capture(signal());
  for (const path of ['test.mjs', '../outside.txt', '.git/config']) await assert.rejects(f.candidate.apply({ path, content: 'bad', expectedHash: null }, signal()), /explicitly approved/);
  await assert.rejects(f.candidate.apply({ path: 'sum.mjs', content: 'bad' }, signal()), /expectedHash/);
  await apply(f, 'sum.mjs', 'export const sum = (a,b) => a+b;\n');
  await assert.rejects(f.candidate.apply({ path: 'sum.mjs', content: 'stale', expectedHash: current.files.find(file => file.path === 'sum.mjs').hash }, signal()), /content changed/);
  await writeFile(join(f.worktree, 'test.mjs'), 'outside approved change');
  await assert.rejects(f.candidate.capture(signal()), /outside the approved paths/);
});

for (const kind of ['symbolic', 'hard', 'parent']) test(`candidate tools refuse ${kind} links`, async t => {
  const f = await fixture(t), outside = join(f.directory, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'preserved');
  if (kind === 'parent') await symlink(outside, join(f.worktree, 'new'), process.platform === 'win32' ? 'junction' : 'dir');
  else { await unlink(join(f.worktree, 'sum.mjs')); if (kind === 'symbolic') { try { await symlink(join(outside, 'secret.txt'), join(f.worktree, 'sum.mjs')); } catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Host lacks file symlink privilege'); throw error; } } else await link(join(outside, 'secret.txt'), join(f.worktree, 'sum.mjs')); }
  await assert.rejects(f.candidate.apply({ path: kind === 'parent' ? 'new/notes.txt' : 'sum.mjs', content: 'bad', expectedHash: null }, signal()), /links|outside the approved paths/);
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'preserved');
});

test('verification that changes approved source cannot pass even with exit zero', async t => {
  const f = await fixture(t, { script: "import {writeFileSync} from 'node:fs'; writeFileSync('sum.mjs', 'changed by check'); console.log('exit zero');\n" });
  const receipt = await f.candidate.check('test', signal()); assert.equal(receipt.exitCode, 0); assert.equal(receipt.status, 'failed'); assert.match(receipt.stderr, /changed candidate source/);
  assert.equal(developmentVerified(f.scope, await f.candidate.capture(signal()), f.saved), false);
});

test('ignored build output is excluded while tracked source remains part of verification', async t => {
  const f = await fixture(t, { script: "import {mkdirSync,writeFileSync} from 'node:fs'; mkdirSync('generated',{recursive:true}); writeFileSync('generated/output.txt','build artifact');\n" });
  await apply(f, 'sum.mjs', 'export const sum=(a,b)=>a+b;\n');
  assert.equal((await f.candidate.check('test', signal())).status, 'passed');
  assert.deepEqual((await f.candidate.capture(signal())).changedPaths, ['sum.mjs']);
});

test('timeout and cancellation retain nonpassing evidence', async t => {
  const f = await fixture(t, { script: "setTimeout(()=>console.log('late'),5000);\n", timeout: 50 });
  const timeout = await f.candidate.check('test', signal()); assert.equal(timeout.status, 'failed'); assert.match(timeout.stderr, /timeout/);
  const controller = new AbortController(); const pending = f.candidate.check('test', controller.signal); const timer = setTimeout(() => controller.abort(), 200);
  try { const result = await pending; assert.notEqual(result.status, 'passed'); } catch (error) { assert.equal(controller.signal.aborted, true); } finally { clearTimeout(timer); }
  assert.ok(f.saved.checks.every(check => check.status !== 'passed'));
});

test('revoked grants and failed evidence persistence cannot produce successful completion', async t => {
  const f = await fixture(t); await apply(f, 'sum.mjs', 'export const sum=(a,b)=>a+b;\n');
  await f.candidate.check('test', signal()); f.failWrites();
  await assert.rejects(apply(f, 'sum.mjs', 'replacement'), /evidence could not be saved/);
  assert.equal(await readFile(join(f.worktree, 'sum.mjs'), 'utf8'), 'export const sum=(a,b)=>a+b;\n', 'failed pre-edit invalidation preserves existing disk content');
  await assert.rejects(f.candidate.capture(signal()), /evidence could not be saved/);
  const revoked = await fixture(t); revoked.revoke();
  await assert.rejects(revoked.candidate.check('test', signal()), /grants changed/);
  await assert.rejects(revoked.broker.call('werk_candidate_status', {}, signal()), /permissions changed/);
});

test('replaced worktree roots and changed Git bases are rejected before writes', async t => {
  const f = await fixture(t); await rename(f.worktree, f.worktree + '-retained'); await mkdir(f.worktree);
  await assert.rejects(f.candidate.capture(signal()), /worktree changed/);
  const other = await fixture(t); git(other.worktree, 'checkout', '-b', 'unexpected');
  await assert.rejects(other.candidate.capture(signal()), /base changed/);
});

for (const kind of ['assume-unchanged', 'skip-worktree']) test(`candidate capture refuses hidden index flags: ${kind}`, async t => {
  const f = await fixture(t); git(f.worktree, 'update-index', '--' + kind, 'test.mjs');
  await writeFile(join(f.worktree, 'test.mjs'), 'hidden test replacement');
  await assert.rejects(f.candidate.capture(signal()), /index flags|outside the approved/);
});

test('a zero-exit verification cannot hide an unapproved tracked test edit', async t => {
  const f = await fixture(t, { script: "import {writeFileSync} from 'node:fs'; writeFileSync('test.mjs', 'changed test');\n" });
  const receipt = await f.candidate.check('test', signal());
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.exitCode, 0); assert.match(receipt.stderr, /outside the approved paths/);
});

for (const interruption of ['revoke', 'cancel', 'storage']) test(`verification interrupted after process start never acknowledges success: ${interruption}`, async t => {
  const f = await fixture(t, { script: "import {mkdirSync,writeFileSync,existsSync} from 'node:fs'; mkdirSync('generated',{recursive:true}); writeFileSync('generated/started','yes'); const timer=setInterval(()=>{if(existsSync('generated/release')){clearInterval(timer); console.log('finished');}},10);\n" });
  const controller = new AbortController();
  const pending = f.candidate.check('test', controller.signal);
  let started = false;
  for (let i = 0; i < 500; i++) {
    started = await readFile(join(f.worktree, 'generated/started')).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; });
    if (started) break; await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(started, true, 'The real verification process reached its marker');
  if (interruption === 'revoke') f.revoke();
  else if (interruption === 'cancel') controller.abort();
  else f.failWrites();
  if (interruption !== 'cancel') await writeFile(join(f.worktree, 'generated/release'), 'finish');
  if (interruption === 'storage') await assert.rejects(pending, /evidence could not be saved/);
  else assert.notEqual((await pending).status, 'passed');
  assert.ok(f.saved.checks.every(check => check.status !== 'passed'));
});

test('a later failed check replaces an earlier pass for the same unchanged candidate', async t => {
  const f = await fixture(t, { script: "import {existsSync} from 'node:fs'; process.exitCode=existsSync('generated/fail') ? 1 : 0;\n" });
  await apply(f, 'sum.mjs', 'export const sum=(a,b)=>a+b;\n');
  assert.equal((await f.candidate.check('test', signal())).status, 'passed');
  const before = await f.candidate.capture(signal()); assert.equal(developmentVerified(f.scope, before, f.saved), true);
  await mkdir(join(f.worktree, 'generated')); await writeFile(join(f.worktree, 'generated/fail'), 'fail');
  assert.equal((await f.candidate.check('test', signal())).status, 'failed');
  const after = await f.candidate.capture(signal()); assert.equal(after.digest, before.digest);
  assert.equal(f.saved.checks.length, 1); assert.equal(developmentVerified(f.scope, after, f.saved), false);
});

for (const content of ['-----BEGIN PRIVATE KEY-----', 'sk-' + 'a'.repeat(24), 'ghp_' + 'a'.repeat(24)]) test('candidate review retains existing sensitive-material refusal: ' + content.slice(0, 8), async t => {
  const f = await fixture(t); await writeFile(join(f.worktree, 'sum.mjs'), content);
  await assert.rejects(f.candidate.capture(signal()), /sensitive material/);
  assert.ok(!f.saved?.checks.some(check => check.status === 'passed'));
});

test('required checks invoked through the generic command tool replace the same candidate receipt', async t => {
  const f = await fixture(t, { script: "import {existsSync} from 'node:fs'; process.exitCode=existsSync('generated/fail') ? 1 : 0;\n" });
  await apply(f, 'sum.mjs', 'export const sum=(a,b)=>a+b;\n');
  assert.equal((await f.candidate.check('test', signal())).status, 'passed');
  const before = await f.candidate.capture(signal()); assert.equal(developmentVerified(f.scope, before, f.saved), true);
  await mkdir(join(f.worktree, 'generated')); await writeFile(join(f.worktree, 'generated/fail'), 'fail');
  const failed = await f.broker.call('werk_command_run', { preset: 'test' }, signal());
  assert.equal(failed.isError, true); assert.equal(unpack(failed).exitCode, 1); assert.equal(unpack(failed).preset, 'test');
  assert.equal(f.saved.checks.length, 1); assert.equal(f.saved.checks[0].status, 'failed');
  const after = await f.candidate.capture(signal()); assert.equal(after.digest, before.digest);
  assert.equal(developmentVerified(f.scope, after, f.saved), false, 'Generic required-check failure cannot leave an earlier successful receipt');
  await unlink(join(f.worktree, 'generated/fail'));
  const passed = await f.broker.call('werk_command_run', { preset: 'test' }, signal());
  assert.equal(passed.isError, undefined); assert.equal(unpack(passed).status, 'passed');
  assert.equal(f.saved.checks.length, 1); assert.equal(developmentVerified(f.scope, await f.candidate.capture(signal()), f.saved), true);
});
