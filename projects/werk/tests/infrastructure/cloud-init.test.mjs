import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepare, render, validateArtifacts, serviceUnit } from '../../scripts/infrastructure/cloud-init.mjs';
import { main, parse } from '../../scripts/infrastructure/cli.mjs';

const root = new URL('../../', import.meta.url);
const options = { file: fileURLToPath(new URL('examples/system.yaml', root)), 'release-version': '0.1.0', 'release-url': 'https://releases.example.test/v0.1.0/werk-0.1.0.tar.gz', 'release-sha256': 'A'.repeat(64), 'node-url': 'https://nodejs.org/dist/v24.4.1/node-v24.4.1-linux-x64.tar.xz', 'node-sha256': 'b'.repeat(64), architecture: 'x86_64' };
const args = command => [command, ...Object.entries(options).flatMap(([key, value]) => ['--' + key, value])];
const yaml = createRequire(new URL('src/orchestrator/dist/package.json', root))('./node_modules/yaml');

test('render produces data-only cloud-init with private state, no build, and bounded systemd service', async () => {
  const prepared = await prepare(options), result = await render(prepared);
  assert.equal(result.plan.profile, 'ubuntu-24.04');
  assert.equal(result.plan.access.bind, '127.0.0.1');
  assert.equal(prepared.artifacts.release.sha256, 'a'.repeat(64));
  assert.deepEqual(await render(prepared), result, 'deterministic output without random credentials');
  const config = yaml.parse(result.cloudConfig);
  assert.deepEqual(config.runcmd, [['python3', '/etc/werk/provision.py']]);
  assert.deepEqual(config.packages, ['ca-certificates', 'curl', 'git', 'python3', 'xz-utils']);
  assert.deepEqual(config.groups, ['werk']);
  assert.ok(config.write_files.every(file => file.defer === true));
  assert.equal(config.users[1].name, 'werk'); assert.equal(config.users[1].lock_passwd, true);
  const files = new Map(config.write_files.map(file => [file.path, file]));
  assert.deepEqual(JSON.parse(files.get('/etc/werk/system.yaml').content), prepared.definition);
  assert.equal(files.get('/etc/werk/system.yaml').owner, 'root:werk');
  assert.equal(files.get('/etc/werk/system.yaml').permissions, '0640');
  assert.equal(files.get('/etc/werk/artifacts.json').permissions, '0600');
  assert.equal(files.get('/etc/werk/runtime.env').content, 'WERK_STATE_DIR=/var/lib/werk\nWERK_SYSTEM_FILE=/etc/werk/system.yaml\nWERK_LOG_OUTPUT=stream\n');
  const unit = files.get('/etc/systemd/system/werk-system.service').content;
  for (const expected of ['RequiresMountsFor=/var/lib/werk', 'User=werk', 'Group=werk', 'KillMode=mixed', 'TimeoutStopSec=180', 'StartLimitBurst=3', 'ProtectSystem=strict', 'ReadWritePaths=/var/lib/werk', 'Restart=on-failure', 'system start --no-open --json']) assert.ok(unit.includes(expected), expected);
  assert.doesNotMatch(unit, /npm|setup|curl|build|ExecStartPre/);
  assert.equal(files.get('/etc/werk/verify-release.mjs').content, await readFile(new URL('scripts/release/verify.mjs', root), 'utf8'));
});

test('both architectures require matching exact official Node 24 URLs', () => {
  const arm = { ...options, architecture: 'arm64', 'node-url': 'https://nodejs.org/dist/v24.4.1/node-v24.4.1-linux-arm64.tar.xz' };
  assert.equal(validateArtifacts(arm).node.architecture, 'arm64');
  for (const change of [{ architecture: 'aarch64' }, { architecture: 'arm64' }, { 'node-url': 'https://nodejs.org/dist/latest-v24.x/node-linux-x64.tar.xz' }, { 'node-url': 'https://nodejs.org/dist/v22.4.1/node-v22.4.1-linux-x64.tar.xz' }, { 'node-url': 'https://mirror.example.test/dist/v24.4.1/node-v24.4.1-linux-x64.tar.xz' }]) assert.throws(() => validateArtifacts({ ...options, ...change }));
});

test('artifact validation refuses moving paths, inline credentials, injection and unknown fields', () => {
  for (const change of [
    { 'release-version': '../../tmp' }, { 'release-version': '0.1.0\n' }, { 'release-version': '0.1.0;id' },
    { 'release-url': 'http://releases.example.test/v0.1.0/werk-0.1.0.tar.gz' },
    { 'release-url': 'https://releases.example.test/latest/werk-0.1.0.tar.gz' },
    { 'release-url': 'https://name:secret@releases.example.test/v0.1.0/werk-0.1.0.tar.gz' },
    { 'release-url': options['release-url'] + '?token=secret' },
    { 'release-url': options['release-url'] + '#secret' },
    { 'release-url': 'https://releases.example.test/%2e%2e/v0.1.0/werk-0.1.0.tar.gz' },
    { 'release-url': 'https://releases.example.test/a/../v0.1.0/werk-0.1.0.tar.gz' },
    { 'release-url': options['release-url'] + '\n' }, { 'release-sha256': 'a'.repeat(64) + '\n' },
    { 'release-sha256': 'wrong' }, { 'node-sha256': '$(id)' }, { token: 'secret' }, { 'state-dir': '/tmp' },
  ]) assert.throws(() => validateArtifacts({ ...options, ...change }), JSON.stringify(change));
  assert.throws(() => parse([...args('render'), '--release-sha256', 'a'.repeat(64)]));
  assert.throws(() => parse([...args('render'), '--secret', 'value']));
});

test('definition payload stays literal data and incompatible environments/privileged ports fail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werk infrastructure '));
  try {
    const prepared = await prepare(options), file = join(directory, 'system.yaml');
    const definition = prepared.definition;
    definition.factory.name = "$(touch /tmp/unsafe); '#cloud-config'";
    await writeFile(file, JSON.stringify(definition));
    const rendered = await render(await prepare({ ...options, file }));
    const config = yaml.parse(rendered.cloudConfig);
    assert.equal(JSON.parse(config.write_files.find(item => item.path === '/etc/werk/system.yaml').content).factory.name, definition.factory.name);
    definition.environment = 'docker'; await writeFile(file, JSON.stringify(definition));
    await assert.rejects(prepare({ ...options, file }), /native/);
    definition.environment = 'native'; definition.factory.port = 80; await writeFile(file, JSON.stringify(definition));
    await assert.rejects(prepare({ ...options, file }), /1024/);
    assert.deepEqual(await readdir(directory), ['system.yaml']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI validates and renders with predictable stdout and sanitized error output', async () => {
  const output = [], errors = [], io = { stdout: value => output.push(value), stderr: value => errors.push(value) };
  assert.equal(await main(args('validate'), io), 0);
  assert.equal(JSON.parse(output.pop()).ok, true);
  assert.equal(await main([...args('render'), '--json'], io), 0);
  assert.match(JSON.parse(output.pop()).cloudConfig, /^#cloud-config/);
  assert.equal(await main(args('render'), io), 0);
  assert.match(output.pop(), /^#cloud-config/);
  assert.equal(await main(['render', '--token', 'do-not-print', '--json'], io), 2);
  const failure = output.pop(); assert.equal(JSON.parse(failure).ok, false); assert.doesNotMatch(failure, /do-not-print/);
  assert.deepEqual(errors, []);
});

test('Python archive safety regressions run independently of Node tar libraries', { skip: process.platform === 'win32' ? 'Python3 is a VM-profile maintainer check on Linux/macOS.' : false }, () => {
  const result = spawnSync('python3', ['-B', fileURLToPath(new URL('./provision.test.py', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('systemd parses generated service hardening and lifecycle directives', { skip: process.platform !== 'linux' }, async t => {
  const available = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' });
  if (available.error?.code === 'ENOENT') return t.skip('systemd-analyze is not installed');
  const directory = await mkdtemp(join(tmpdir(), 'werk-systemd-'));
  try {
    // The actual versioned executable is installed only on a VM; replace solely
    // that path for a local syntax/unit check, not a boot or shutdown claim.
    const unit = serviceUnit(validateArtifacts(options)).replace(/^ExecStart=.*$/m, 'ExecStart=/usr/bin/true');
    const file = join(directory, 'werk-system.service'); await writeFile(file, unit);
    const checked = spawnSync('systemd-analyze', ['verify', file], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
