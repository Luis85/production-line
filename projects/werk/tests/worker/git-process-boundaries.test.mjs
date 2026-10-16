import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { gitEnvironment } from '../../src/worker/dist/shared/git/environment.js';
import { gitLaunchMode } from '../../src/worker/dist/shared/git/launch-mode.js';
import { repositoryGit, repositoryRoot } from '../../src/worker/dist/worker/infrastructure/repositories-git.js';
import { FeatureGitIo } from '../../src/worker/dist/worker/infrastructure/features/git-io.js';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Boundary Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-git-process-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, 'repository'); await mkdir(repository);
  git(repository, 'init', '--initial-branch=main'); await writeFile(join(repository, 'selected.txt'), 'selected\n');
  git(repository, 'add', 'selected.txt'); git(repository, 'commit', '-m', 'Fixture');
  return { directory, repository, io: new FeatureGitIo({ repository, remote: 'origin', stateDirectory: join(directory, 'state') }) };
}
async function withEnvironment(values, action) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await action(); } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
const alive = async pid => {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'; }
    return true;
  } catch { return false; }
};
async function until(predicate, signal, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!await predicate()) { signal?.throwIfAborted(); assert.ok(Date.now() < end, 'fixture process condition timed out'); await delay(25); }
}

test('Git environment profiles preserve host authentication without ambient repository or config injection', () => {
  const source = { HOME: '/host-home', PATH: '/bin', SSH_AUTH_SOCK: '/host-agent', GIT_SSH_COMMAND: 'operator-ssh', GIT_CONFIG_GLOBAL: '/operator-config', GIT_SSL_CAINFO: '/operator-ca', GIT_DIR: '/other', git_work_tree: '/other', GIT_INDEX_FILE: '/other-index', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: '/other', GIT_CONFIG_PARAMETERS: "'core.bare=true'", GIT_TRACE: '/private-diagnostics', GIT_TERMINAL_PROMPT: '1' };
  const host = gitEnvironment('host', source), immutable = gitEnvironment('immutable', source);
  for (const key of ['HOME', 'PATH', 'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND', 'GIT_CONFIG_GLOBAL', 'GIT_SSL_CAINFO']) assert.equal(host[key], source[key]);
  for (const key of ['GIT_DIR', 'git_work_tree', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_PARAMETERS', 'GIT_TRACE']) assert.equal(host[key], undefined);
  assert.equal(host.GIT_TERMINAL_PROMPT, '0'); assert.equal(host.GCM_INTERACTIVE, 'Never');
  assert.equal(immutable.GIT_SSH_COMMAND, undefined); assert.equal(immutable.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(immutable.GIT_NO_REPLACE_OBJECTS, '1'); assert.equal(immutable.GIT_NO_LAZY_FETCH, '1'); assert.equal(immutable.GIT_ALLOW_PROTOCOL, '');
  assert.equal(source.GIT_DIR, '/other', 'normalization must not mutate the operator environment');
});

test('both Git adapters ignore inherited repository/index/config redirects and retain host credential configuration', async t => {
  const f = await fixture(t), other = join(f.directory, 'other'), globalConfig = join(f.directory, 'host.gitconfig');
  git(f.directory, 'clone', '--', f.repository, other);
  await writeFile(join(other, 'selected.txt'), 'other checkout must remain unchanged\n');
  await writeFile(globalConfig, '[credential]\n\thelper = fixture-host-auth\n');
  const otherIndex = await readFile(join(other, '.git', 'index'));
  const source = { GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other, GIT_COMMON_DIR: join(other, '.git'), GIT_INDEX_FILE: join(other, '.git', 'index'), GIT_OBJECT_DIRECTORY: join(other, '.git', 'objects'), GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true' };
  await withEnvironment(source, async () => {
    assert.equal((await repositoryRoot(f.repository, t.signal)).path, f.repository);
    for (const run of [args => repositoryGit(f.repository, args, t.signal), args => f.io.output(f.repository, args, t.signal)]) {
      assert.equal((await run(['rev-parse', '--show-toplevel'])).trim().replaceAll('\\', '/'), f.repository.replaceAll('\\', '/'));
      assert.equal(await run(['status', '--porcelain=v1']), '');
      assert.equal((await run(['config', '--get', 'credential.helper'])).trim(), 'fixture-host-auth');
    }
  });
  assert.deepEqual(await readFile(join(other, '.git', 'index')), otherIndex);
  assert.equal(await readFile(join(other, 'selected.txt'), 'utf8'), 'other checkout must remain unchanged\n');
});

for (const adapter of ['repository', 'feature']) test(`${adapter} Git cancellation owns remote-helper descendants and keeps diagnostics private`, { timeout: 40000 }, async t => {
  const f = await fixture(t), helper = join(f.directory, 'ssh-helper.cjs'), marker = join(f.directory, 'helper.json');
  await writeFile(helper, `const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({parent:process.pid,child:child.pid}));process.stderr.write('PRIVATE_GIT_HELPER_DIAGNOSTIC');setInterval(()=>{},1000);`);
  const quote = value => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
  git(f.repository, 'config', 'core.sshCommand', quote(process.execPath) + ' ' + quote(helper));
  git(f.repository, 'config', 'ssh.variant', 'ssh');
  git(f.repository, 'remote', 'add', 'origin', 'ssh://fixture.invalid/repository.git');
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, t.signal]);
  let pids;
  t.after(async () => { controller.abort(); for (const pid of Object.values(pids ?? {})) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  const pending = adapter === 'repository' ? repositoryGit(f.repository, ['fetch', 'origin'], signal) : f.io.output(f.repository, ['fetch', 'origin'], signal);
  const checked = assert.rejects(pending, error => { assert.match(error.message, /cancelled|Shared feature Git operation failed/); assert.doesNotMatch(error.message, /PRIVATE_GIT_HELPER|fixture\.invalid/); return true; });
  let failed = false; pending.catch(() => { failed = true; });
  await until(async () => { try { pids = JSON.parse(await readFile(marker, 'utf8')); return true; } catch { assert.equal(failed, false, 'Git helper must start before cancellation'); return false; } }, t.signal, 20000);
  controller.abort();
  await checked;
  await until(async () => !await alive(pids.parent) && !await alive(pids.child), t.signal);
});

test('Git status cancellation also owns configured clean-filter descendants', { timeout: 40000 }, async t => {
  const f = await fixture(t), helper = join(f.directory, 'clean-filter.cjs'), marker = join(f.directory, 'filter.json');
  await writeFile(helper, `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);`);
  const quote = value => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
  git(f.repository, 'config', 'filter.boundary.clean', quote(process.execPath) + ' ' + quote(helper));
  await writeFile(join(f.repository, '.gitattributes'), 'selected.txt filter=boundary\n');
  // Equal byte length forces Git to compare content through the clean filter instead of stopping at a size mismatch.
  await writeFile(join(f.repository, 'selected.txt'), 'replaced\n');
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, t.signal]); let pids;
  t.after(() => { controller.abort(); for (const pid of Object.values(pids ?? {})) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  const pending = repositoryGit(f.repository, ['status', '--porcelain=v1'], signal);
  const checked = assert.rejects(pending, /cancelled/); checked.catch(() => {});
  let failed = false; pending.then(() => { failed = true; }, () => { failed = true; });
  await until(async () => { try { pids = JSON.parse(await readFile(marker, 'utf8')); return true; } catch { assert.equal(failed, false, 'Git filter must start before cancellation'); return false; } }, t.signal, 20000);
  controller.abort(); await checked;
  await until(async () => !await alive(pids.parent) && !await alive(pids.child), t.signal);
});

for (const adapter of ['repository', 'feature']) test(`${adapter} metadata reads never start a promisor lazy-fetch transport`, { timeout: 30000 }, async t => {
  const f = await fixture(t), helper = join(f.directory, 'promisor-ssh.cjs'), marker = join(f.directory, 'promisor-started');
  await writeFile(helper, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');process.exit(1);`);
  const quote = value => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
  git(f.repository, 'config', 'core.sshCommand', quote(process.execPath) + ' ' + quote(helper));
  git(f.repository, 'config', 'ssh.variant', 'ssh');
  git(f.repository, 'remote', 'add', 'origin', 'ssh://fixture.invalid/promisor.git');
  git(f.repository, 'config', 'remote.origin.promisor', 'true');
  git(f.repository, 'config', 'remote.origin.partialclonefilter', 'blob:none');
  git(f.repository, 'config', 'extensions.partialClone', 'origin');
  const args = ['cat-file', '-s', 'a'.repeat(40)];
  await withEnvironment({ GIT_NO_LAZY_FETCH: '0' }, async () => {
    // Prove this actual Git fixture would invoke its local helper without the metadata boundary.
    assert.throws(() => git(f.repository, ...args));
    assert.equal(await readFile(marker, 'utf8'), 'started');
    await rm(marker);
    if (adapter === 'repository') await assert.rejects(repositoryGit(f.repository, args, t.signal), /Git operation failed/);
    else await assert.rejects(f.io.output(f.repository, args, t.signal), /Shared feature Git operation failed/);
    await assert.rejects(readFile(marker), error => error.code === 'ENOENT');
  });
});

test('cat-file filter and textconv variants require descendant containment', () => {
  assert.equal(gitLaunchMode(['cat-file', '-s', 'a'.repeat(40)]), 'plain');
  assert.equal(gitLaunchMode(['cat-file', '--filters', 'HEAD:selected.txt']), 'contained');
  assert.equal(gitLaunchMode(['cat-file', '--textconv', 'HEAD:selected.txt']), 'contained');
  assert.equal(gitLaunchMode(['cat-file', '--batch', '--filters']), 'contained');
});

for (const adapter of ['repository', 'feature']) test(`${adapter} machine log reads disable configured signature verifier processes`, { timeout: 30000 }, async t => {
  const f = await fixture(t), helper = join(f.directory, 'signature-verifier.cjs'), executable = join(f.directory, 'signature-verifier.sh'), marker = join(f.directory, 'verifier-started');
  await writeFile(helper, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');process.exit(1);`);
  const quote = value => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
  // Git for Windows also interprets executable shebang scripts using its bundled shell.
  await writeFile(executable, '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(helper) + ' "$@"\n', { mode: 0o700 });
  git(f.repository, 'config', 'gpg.program', executable.replaceAll('\\', '/'));
  git(f.repository, 'config', 'log.showSignature', 'true');
  const tree = git(f.repository, 'rev-parse', 'HEAD^{tree}');
  const content = `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1720000000 +0000\ncommitter Fixture <fixture@example.invalid> 1720000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n ZmFrZQ==\n -----END PGP SIGNATURE-----\n\nSignature fixture\n`;
  const commit = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: f.repository, input: content, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const args = ['log', '--max-count=128', '--format=%H%x00%B%x00', commit];
  assert.ok(git(f.repository, ...args).includes(commit));
  assert.equal(await readFile(marker, 'utf8'), 'started', 'fixture must prove signature display starts a verifier');
  await rm(marker);
  const output = adapter === 'repository' ? await repositoryGit(f.repository, args, t.signal) : await f.io.output(f.repository, args, t.signal);
  assert.ok(output.includes(commit));
  assert.ok(output.includes('Signature fixture'));
  await assert.rejects(readFile(marker), error => error.code === 'ENOENT');
});
