import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installBrowser } from '../../scripts/quality/install-browser.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const sources = ['/etc/apt/sources.list', '/etc/apt/sources.list.d/ubuntu.sources', '/etc/apt/apt-mirrors.txt', '/etc/apt/apt-mirrors-security.txt'];
function capture(existing = sources, status = 0) {
  const calls = [];
  const ports = { platform: 'linux', actions: 'true', exists: path => existing.includes(path), spawn: (command, args, options) => { calls.push({ command, args, options }); return { status }; } };
  return { calls, ports };
}

for (const source of sources) test('browser setup supports apt source layout ' + source, () => {
  const { calls, ports } = capture([source]);
  installBrowser(ports);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, 'sudo');
  assert.deepEqual(calls[0].args.slice(0, 2), ['sed', '-i']);
  assert.equal(calls[0].args.at(-1), source);
  assert.equal(calls[1].command, process.execPath);
  assert.deepEqual(calls[1].args, [fileURLToPath(new URL('../../node_modules/playwright/cli.js', import.meta.url)), 'install', '--with-deps', 'chromium']);
  for (const call of calls) assert.deepEqual(call.options, { cwd: project, stdio: 'inherit' });
});

test('browser setup changes only the slow mirror and preserves suites and signing keys', { skip: process.platform === 'win32' }, () => {
  const { calls, ports } = capture(); installBrowser(ports);
  const input = 'URIs: http://azure.archive.ubuntu.com/ubuntu/\nSuites: noble noble-updates\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\nhttps://security.ubuntu.com/ubuntu/\n';
  for (const call of calls.filter(call => call.command === 'sudo')) {
    const actual = spawnSync('sed', [call.args[2]], { input, encoding: 'utf8' });
    assert.equal(actual.status, 0, actual.stderr);
    assert.equal(actual.stdout, input.replace('azure.archive.ubuntu.com', 'archive.ubuntu.com'));
  }
});

test('browser setup refuses non-CI and non-Linux callers before system changes', () => {
  for (const override of [{ actions: 'false' }, { actions: '' }, { platform: 'win32' }, { platform: 'darwin' }]) {
    const { calls, ports } = capture();
    assert.throws(() => installBrowser({ ...ports, ...override }), /restricted to Linux GitHub Actions/);
    assert.equal(calls.length, 0);
  }
});

test('failed apt setup stops before browser installation and reports failure', () => {
  const { calls, ports } = capture(sources, 7);
  assert.throws(() => installBrowser(ports), /exit status 7/);
  assert.equal(calls.length, 1);
});

test('missing source files are skipped and browser failures are propagated', () => {
  const { calls, ports } = capture([], 9);
  assert.throws(() => installBrowser(ports), /exit status 9/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.throws(() => installBrowser({ ...ports, spawn: () => ({ status: null, error: Error('could not launch') }) }), /could not launch/);
});
