import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install, parse, restartCommand } from '../../scripts/release/install.mjs';
import { createArchives } from '../../scripts/release/archives.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk download test '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payloads = [
    { path: 'werk.mjs', content: Buffer.from('console.log("fixture")\n'), mode: 0o755 },
    { path: 'scripts/release/verify.mjs', content: await readFile(new URL('../../scripts/release/verify.mjs', import.meta.url)), mode: 0o644 },
  ];
  const hash = content => createHash('sha256').update(content).digest('hex');
  const manifest = { schemaVersion: 1, name: 'werk', version: '0.1.0', files: payloads.map(({ path, content }) => ({ path, bytes: content.length, sha256: hash(content) })) };
  payloads.push({ path: 'release-manifest.json', content: Buffer.from(JSON.stringify(manifest)), mode: 0o644 });
  const { tarGzip } = await createArchives(payloads.map(entry => ({ ...entry, path: `werk-0.1.0/${entry.path}` })));
  const config = { version: '0.1.0', repository: 'example/werk', sha256: hash(tarGzip) };
  const transport = { fetcher: async url => {
    assert.equal(url, 'https://github.com/example/werk/releases/download/v0.1.0/werk-0.1.0.tar.gz');
    return new Response(tarGzip);
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
  const command = restartCommand(root, options, platform);
  const output = platform === 'win32'
    ? execFileSync(powerShell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', cwd: directory })
    : execFileSync('bash', ['--noprofile', '--norc', '-c', command], { encoding: 'utf8', cwd: directory });
  assert.deepEqual(JSON.parse(output), ['up', '--file', options.file, '--state-dir', options.stateDir, '--no-open']);
  assert.match(restartCommand(root, {}, platform), / up$/);
});
