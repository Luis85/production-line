import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractionTimeoutMs, install, parse, restartCommand } from '../../scripts/release/install.mjs';
import { create as createTar } from 'tar';
import { createArchives } from '../../scripts/release/archives.mjs';

async function fixture(t, home = false) {
  const directory = await mkdtemp(join(tmpdir(), 'werk download test '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payloads = [
    { path: 'werk.mjs', content: Buffer.from('console.log("fixture")\n'), mode: 0o755 },
    { path: home ? 'runtime/scripts/release/verify.mjs' : 'scripts/release/verify.mjs', content: await readFile(new URL('../../scripts/release/verify.mjs', import.meta.url)), mode: 0o644 },
  ];
  const hash = content => createHash('sha256').update(content).digest('hex');
  const manifest = { schemaVersion: 1, name: 'werk', version: '0.1.0', ...(home ? { layout: 'werk-home-v1', updateProtocol: 2, stateFormat: 1 } : {}), files: payloads.map(({ path, content }) => ({ path, bytes: content.length, sha256: hash(content) })) };
  payloads.push({ path: 'release-manifest.json', content: Buffer.from(JSON.stringify(manifest)), mode: 0o644 });
  const { tarGzip } = await createArchives(payloads.map(entry => ({ ...entry, path: home ? entry.path : `werk-0.1.0/${entry.path}` })));
  const config = { version: '0.1.0', repository: 'example/werk', sha256: hash(tarGzip), ...(home ? { layout: 'werk-home-v1' } : {}) };
  const transport = { fetcher: async url => {
    assert.equal(url, 'https://github.com/example/werk/releases/download/v0.1.0/werk-0.1.0.tar.gz');
    return new Response(new Uint8Array(tarGzip));
  }, log() {} };
  return { directory, config, transport };
}

test('standalone installer verifies, extracts into paths with spaces and preserves existing installations', async t => {
  const { directory, config, transport } = await fixture(t);
  const root = await install(config, { directory }, transport);
  assert.equal(root, join(directory, 'werk-0.1.0'));
  assert.match(await readFile(join(root, 'werk.mjs'), 'utf8'), /fixture/);
  await mkdir(join(root, '.werk-system'));
  await writeFile(join(root, '.werk-system/precious-state'), 'keep');
  await assert.rejects(install(config, { directory }, transport), /Destination already exists/);
  assert.equal(await readFile(join(root, '.werk-system/precious-state'), 'utf8'), 'keep');
  assert.deepEqual(await readdir(directory), ['werk-0.1.0']);
});

test('checksum mismatch and failed HTTP downloads leave no installation or temporary files', async t => {
  const { directory, config, transport } = await fixture(t);
  await assert.rejects(install({ ...config, sha256: '0'.repeat(64) }, { directory }, transport), /checksum mismatch/);
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(install(config, { directory }, { ...transport, fetcher: async () => new Response('Not found', { status: 404 }) }), /HTTP 404/);
  assert.deepEqual(await readdir(directory), []);
});

test('invalid metadata and arguments fail before download', async t => {
  const { directory, config } = await fixture(t);
  const unexpected = { fetcher() { assert.fail('must not download'); }, log() {} };
  for (const invalid of [null, { ...config, version: '../escape' }, { ...config, repository: 'bad/../../repo' }]) {
    await assert.rejects(install(invalid, { directory }, unexpected), /published GitHub release/);
  }
  assert.throws(() => parse(['--unknown']), /Unknown option/);
  assert.throws(() => parse(['--directory']), /requires a path/);
  assert.throws(() => parse(['--no-start', '--no-start']), /Repeated option/);
  const options = parse(['--no-start', '--no-open', '--directory', directory]);
  assert.equal(options.start, false);
  assert.equal(options.noOpen, true);
  assert.equal(options.directory, directory);
});

test('an archive rooted at another version fails before publishing the installation', async t => {
  const { directory, config, transport } = await fixture(t);
  // Same bytes and valid checksum, but archive paths belong to another version.
  const wrong = { ...config, version: '0.2.0' };
  await assert.rejects(install(wrong, { directory }, { ...transport, fetcher: () => transport.fetcher('https://github.com/example/werk/releases/download/v0.1.0/werk-0.1.0.tar.gz') }), /Unsafe release archive paths/);
  assert.deepEqual(await readdir(directory), []);
});

test('extraction timeout has a 300 s floor and grows 200 ms per archive entry', () => {
  assert.equal(extractionTimeoutMs(0), 300_000);
  assert.equal(extractionTimeoutMs(1500), 300_000);
  assert.equal(extractionTimeoutMs(2982), 596_400);
  assert.equal(extractionTimeoutMs(11000), 2_200_000);
});

test('a timed-out tar call names the operation, bound and the manual --from route, and leaves no files', async t => {
  const { directory, config, transport } = await fixture(t);
  const timeouts = [];
  const slow = operation => (command, args, options) => {
    if (args[0] !== operation) return execFileSync(command, args, options);
    timeouts.push(options.timeout);
    throw Object.assign(Error(`spawnSync ${command} ETIMEDOUT`), { code: 'ETIMEDOUT' });
  };
  await assert.rejects(install(config, { directory }, { ...transport, exec: slow('-tzf') }), /Listing the release archive exceeded 120 s\. Extract werk-0\.1\.0\.tar\.gz yourself and run update apply --from <extracted folder>/);
  await assert.rejects(install(config, { directory }, { ...transport, exec: slow('-xzf') }), /Extracting the release archive \(\d+ entries\) exceeded 300 s\. Extract werk-0\.1\.0\.tar\.gz yourself and run update apply --from <extracted folder> \(add --stop\/--in-place as needed\)\./);
  assert.deepEqual(timeouts, [120_000, 300_000]);
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(install(config, { directory }, { ...transport, exec: (command, args, options) => { if (args[0] === '-xzf') throw Object.assign(Error('boom'), { code: 'EIO' }); return execFileSync(command, args, options); } }), /boom/);
});

// GNU tar interprets a colon in an absolute archive filename as remote syntax.
// A colon-bearing parent reproduces Windows drive handling on Unix as well.
test('installer handles archive parents containing colon syntax', { skip: process.platform === 'win32' }, async t => {
  const { directory, config, transport } = await fixture(t);
  const parent = join(directory, 'D: release files');
  const root = await install(config, { directory: parent }, transport);
  assert.match(await readFile(join(root, 'werk.mjs'), 'utf8'), /fixture/);
});

const powerShell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const hasPowerShell = spawnSync(powerShell, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']).status === 0;
for (const platform of ['linux', 'win32']) test(`installer restart guidance preserves selected system and state in ${platform === 'win32' ? 'PowerShell' : 'Bash'}`, {
  skip: platform === 'win32' ? !hasPowerShell : process.platform === 'win32',
}, async t => {
  const { directory } = await fixture(t);
  const root = join(directory, "release ' $(printf unexpected) `printf unexpected` &");
  await mkdir(root);
  await writeFile(join(root, 'werk.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))');
  const options = { file: join(directory, "team's $system `definition`.yaml"), stateDir: join(directory, "state ' ; $(printf unexpected) &"), noOpen: true };
  assert.ok(platform === 'win32' || platform === 'linux' || platform === 'darwin');
  const command = restartCommand(root, options, platform);
  const output = platform === 'win32'
    ? execFileSync(powerShell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', cwd: directory })
    : execFileSync('bash', ['--noprofile', '--norc', '-c', command], { encoding: 'utf8', cwd: directory });
  assert.deepEqual(JSON.parse(output), ['up', '--file', options.file, '--state-dir', options.stateDir, '--no-open']);
  assert.match(restartCommand(root, {}, platform), / up$/);
});

test('Home installer extracts directly into the selected empty Home and never merges into populated mutable state', async t => {
  const { directory, config, transport } = await fixture(t, true);
  const installed = await install(config, { directory }, transport); assert.equal(installed, directory);
  assert.match(await readFile(join(installed, 'werk.mjs'), 'utf8'), /fixture/);
  await mkdir(join(directory, 'projects/company'), { recursive: true }); await writeFile(join(directory, 'projects/company/user.txt'), 'keep');
  await assert.rejects(install(config, { directory }, transport), /Destination already exists/);
  assert.equal(await readFile(join(directory, 'projects/company/user.txt'), 'utf8'), 'keep');
  assert.equal((await readdir(directory)).some(name => name.startsWith('werk-')), false);
});
test('Home installer rejects legacy system state overrides before any network call', async t => {
  const { directory, config } = await fixture(t, true);
  const transport = { fetcher() { assert.fail('must reject before download'); }, log() {} };
  for (const options of [{ directory, file: 'system.yaml' }, { directory, stateDir: 'legacy' }]) await assert.rejects(install(config, options, transport), /legacy system installer options/);
  assert.deepEqual(await readdir(directory), []);
});

test('installer rejects archive symlinks before invoking extraction', async t => {
  const { directory, config, transport } = await fixture(t);
  const seed = join(directory, 'seed'), root = join(seed, 'werk-0.1.0'); await mkdir(root, { recursive: true });
  try { await symlink('../../outside', join(root, 'link')); } catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows symlink privilege unavailable'); throw error; }
  const archive = join(directory, 'unsafe.tar.gz'); await createTar({ cwd: seed, file: archive, gzip: true }, ['werk-0.1.0']);
  const bytes = await readFile(archive), destination = join(directory, 'fresh'); let extracts = 0;
  await assert.rejects(install({ ...config, sha256: createHash('sha256').update(bytes).digest('hex') }, { directory: destination }, { ...transport, fetcher: async () => new Response(new Uint8Array(bytes)), exec: (file, args, options) => { if (args[0] === '-xzf') extracts++; return execFileSync(file, args, options); } }), /links and special files/);
  assert.equal(extracts, 0); await assert.rejects(readFile(join(directory, 'outside')), { code: 'ENOENT' });
});
