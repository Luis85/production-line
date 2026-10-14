import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, mkdir, writeFile, readFile, readdir, lstat, symlink, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { planProjectIntegrations, syncProjectIntegrations, seedProjectIntegrations } from '../../src/worker/dist/worker/infrastructure/project-integrations.js';

const paths = ['.claude/skills/werk-worker/SKILL.md', '.agents/skills/werk-worker/SKILL.md', '.codex/werk-worker.md'];
const manifest = '.werk/agent-integrations.json';
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk integration project ')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(root, path, content) {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), content);
}
async function snapshot(root, prefix = '') {
  const result = {};
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? prefix + '/' + name : name;
    const info = await lstat(join(root, path), { bigint: true });
    result[path] = info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : { bytes: (await readFile(join(root, path))).toString('base64'), modified: String(info.mtimeNs) };
    if (info.isDirectory()) Object.assign(result, await snapshot(root, path));
  }
  return result;
}
async function install(root) {
  const plan = await planProjectIntegrations(root);
  assert.equal(plan.canApply, true);
  return syncProjectIntegrations(root, plan.planId);
}
const rejectsConflict = error => error?.code === 'conflict';

test('integration plans are read-only and install actual project discovery files without changing custom configuration', async t => {
  const root = await fixture(t);
  const owned = { '.claude/settings.json': '{"custom":"preserved-private-fixture"}\n', '.codex/config.toml': 'developer_instructions = "Keep my project policy"\n', 'AGENTS.md': '# Existing project instructions\n' };
  for (const [path, content] of Object.entries(owned)) await put(root, path, content);
  const before = await snapshot(root), plan = await planProjectIntegrations(root);
  assert.deepEqual(await snapshot(root), before);
  assert.deepEqual(plan.files.map(file => file.path).sort(), [...paths].sort());
  assert.ok(plan.files.every(file => file.action === 'create'));
  const result = await syncProjectIntegrations(root, plan.planId);
  assert.deepEqual([...result.written].sort(), [...paths].sort());
  for (const path of paths) {
    const info = await lstat(join(root, path));
    assert.equal(info.isFile(), true); assert.equal(info.isSymbolicLink(), false);
    assert.equal(await readFile(join(root, path), 'utf8'), plan.files.find(file => file.path === path).content);
  }
  for (const [path, content] of Object.entries(owned)) assert.equal(await readFile(join(root, path), 'utf8'), content);
  assert.doesNotMatch(JSON.stringify(plan) + JSON.stringify(result), /preserved-private-fixture/);
});

test('repeated integration sync is a byte- and timestamp-preserving no-op; missing managed files repair', async t => {
  const root = await fixture(t); await install(root);
  const before = await snapshot(root), current = await planProjectIntegrations(root);
  assert.ok(current.files.every(file => file.state === 'current' && file.action === 'none'));
  const second = await syncProjectIntegrations(root, current.planId);
  assert.deepEqual(second.written, []); assert.deepEqual(await snapshot(root), before);
  await unlink(join(root, paths[0]));
  const repair = await planProjectIntegrations(root);
  assert.equal(repair.files.find(file => file.path === paths[0]).action, 'create');
  await syncProjectIntegrations(root, repair.planId);
  assert.equal(await readFile(join(root, paths[0]), 'utf8'), repair.files.find(file => file.path === paths[0]).content);
  for (const path of paths.slice(1)) assert.deepEqual((await snapshot(root))[path], before[path]);
});

test('a recorded previous template can update, but identical unmanaged content is never adopted', async t => {
  const root = await fixture(t); await install(root);
  const previous = '# Previous generated template\n';
  await writeFile(join(root, paths[0]), previous);
  const record = JSON.parse(await readFile(join(root, manifest), 'utf8'));
  record.files[paths[0]].sha256 = createHash('sha256').update(previous).digest('hex');
  await writeFile(join(root, manifest), JSON.stringify(record));
  const plan = await planProjectIntegrations(root);
  assert.equal(plan.canApply, true);
  assert.equal(plan.files.find(file => file.path === paths[0]).state, 'update');
  await syncProjectIntegrations(root, plan.planId);
  assert.equal(await readFile(join(root, paths[0]), 'utf8'), plan.files.find(file => file.path === paths[0]).content);
  const unmanaged = await fixture(t);
  await put(unmanaged, paths[0], plan.files.find(file => file.path === paths[0]).content);
  const unowned = await planProjectIntegrations(unmanaged);
  assert.equal(unowned.files.find(file => file.path === paths[0]).state, 'conflict');
  assert.equal(unowned.files.find(file => file.path === paths[0]).managedSha256, null);
});

test('customized managed files conflict and are never overwritten, including by seed', async t => {
  const root = await fixture(t); await install(root);
  await writeFile(join(root, paths[0]), '# Operator customized instructions\n');
  const before = await snapshot(root), plan = await planProjectIntegrations(root);
  assert.equal(plan.canApply, false);
  assert.equal(plan.files.find(file => file.path === paths[0]).state, 'conflict');
  await assert.rejects(syncProjectIntegrations(root, plan.planId), rejectsConflict);
  assert.deepEqual(await snapshot(root), before);
  const seeded = await seedProjectIntegrations(root);
  assert.ok(seeded.skipped.includes(paths[0]));
  assert.deepEqual(await snapshot(root), before);
});

test('unmanaged target content is not adopted and seed installs only absent safe destinations', async t => {
  const root = await fixture(t);
  await put(root, paths[0], '# Existing unmanaged skill\n');
  const plan = await planProjectIntegrations(root);
  assert.equal(plan.canApply, false);
  await assert.rejects(syncProjectIntegrations(root, plan.planId), rejectsConflict);
  assert.deepEqual((await readdir(root)).sort(), ['.claude']);
  const result = await seedProjectIntegrations(root);
  assert.ok(result.skipped.includes(paths[0]));
  assert.deepEqual([...result.written].sort(), paths.slice(1).sort());
  assert.equal(await readFile(join(root, paths[0]), 'utf8'), '# Existing unmanaged skill\n');
  const recorded = JSON.parse(await readFile(join(root, manifest), 'utf8'));
  assert.equal(recorded.files[paths[0]], undefined);
});

test('a reviewed integration plan is bound to its canonical project directory', async t => {
  const first = await fixture(t), second = await fixture(t);
  const plan = await planProjectIntegrations(first), other = await planProjectIntegrations(second);
  assert.notEqual(plan.planId, other.planId);
  await assert.rejects(syncProjectIntegrations(second, plan.planId), rejectsConflict);
  assert.deepEqual(await snapshot(first), {}); assert.deepEqual(await snapshot(second), {});
});

test('a stale reviewed plan cannot overwrite a new target or partially install other files', async t => {
  const root = await fixture(t), plan = await planProjectIntegrations(root);
  await put(root, paths[1], '# Changed after review\n');
  const before = await snapshot(root);
  await assert.rejects(syncProjectIntegrations(root, plan.planId), rejectsConflict);
  assert.deepEqual(await snapshot(root), before);
});

test('malformed and unrecognized manifests fail closed without revealing existing private bytes', async t => {
  for (const contents of ['{broken-private-fixture', JSON.stringify({ schemaVersion: 99, private: 'private-manifest-fixture' }), JSON.stringify({ schemaVersion: 1, templateVersion: 1, files: { '../escape': { sha256: 'a'.repeat(64) } } })]) {
    const root = await fixture(t); await put(root, manifest, contents);
    const before = await snapshot(root), plan = await planProjectIntegrations(root);
    assert.equal(plan.canApply, false);
    assert.doesNotMatch(JSON.stringify(plan), /broken-private-fixture|private-manifest-fixture/);
    await assert.rejects(syncProjectIntegrations(root, plan.planId), rejectsConflict);
    assert.deepEqual(await snapshot(root), before);
  }
});

test('integration refuses symlink ancestors, targets and ownership files without writing through them', { skip: process.platform === 'win32' }, async t => {
  for (const path of ['.claude', '.claude/skills', paths[0], '.codex', '.agents', '.werk', manifest]) {
    const root = await fixture(t), outside = await fixture(t);
    const file = path.endsWith('.md') || path.endsWith('.json');
    if (file) await put(outside, 'target', 'outside-private-fixture');
    await mkdir(join(root, path, '..'), { recursive: true });
    await symlink(file ? join(outside, 'target') : outside, join(root, path));
    const before = await snapshot(root), outsideBefore = await snapshot(outside);
    const plan = await planProjectIntegrations(root);
    assert.equal(plan.canApply, false, path);
    assert.ok(plan.conflicts.length > 0, path);
    await assert.rejects(syncProjectIntegrations(root, plan.planId), rejectsConflict);
    assert.deepEqual(await snapshot(root), before, path);
    assert.deepEqual(await snapshot(outside), outsideBefore, path);
    assert.doesNotMatch(JSON.stringify(plan), /outside-private-fixture/);
  }
});

test('a hardlinked managed destination is refused and its outside alias remains unchanged', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t), outside = await fixture(t); await install(root);
  await link(join(root, paths[0]), join(outside, 'linked-skill'));
  const before = await snapshot(root), outsideBefore = await snapshot(outside), plan = await planProjectIntegrations(root);
  assert.equal(plan.canApply, false);
  assert.equal(plan.files.find(file => file.path === paths[0]).state, 'blocked');
  await assert.rejects(syncProjectIntegrations(root, plan.planId), rejectsConflict);
  assert.deepEqual(await snapshot(root), before); assert.deepEqual(await snapshot(outside), outsideBefore);
});

test('built CLI dry-run returns the reviewed plan without installing or creating state', async t => {
  const root = await fixture(t), entry = resolve('bin/apps/worker/cli.mjs');
  await put(root, '.codex/config.toml', 'developer_instructions = "Existing operator policy"\n');
  const before = await snapshot(root), run = promisify(execFile);
  const planResult = await run(process.execPath, [entry, 'integrations', 'plan', '--project-dir', root, '--json'], { cwd: root, timeout: 15000 });
  const plan = JSON.parse(planResult.stdout);
  const preview = await run(process.execPath, [entry, 'integrations', 'sync', '--if-match', plan.planId, '--dry-run', '--project-dir', root, '--json'], { cwd: root, timeout: 15000 });
  const observed = JSON.parse(preview.stdout);
  assert.equal(observed.planId, plan.planId);
  assert.ok(observed.files.every(file => file.action === 'create'));
  assert.deepEqual(await snapshot(root), before);
});

test('generated agent guidance uses guarded worker operations and never grants tools or embeds provider secrets', async t => {
  const root = await fixture(t), plan = await planProjectIntegrations(root);
  const content = plan.files.map(file => file.content).join('\n');
  for (const pattern of [/schema/, /capabilities/, /feature folder get/, /interaction get/, /interaction events/, /nextAfter/, /operationId|--key/, /expectedRevision|--if-match/, /pendingId|pending\.id|--question-id/, /cumulative/i, /unknown/i, /estimate/i]) assert.match(content, pattern);
  assert.match(content, /accepted[\s\S]*immutable|do not edit[\s\S]*accepted|never edit[\s\S]*accepted/i);
  assert.doesNotMatch(content, /allowed-tools:|dangerously-skip-permissions|approval_policy\s*=|ANTHROPIC_API_KEY\s*=|OPENAI_API_KEY\s*=/);
});
