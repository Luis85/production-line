import fs, { cp, mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createArchives } from '../../scripts/release/archives.mjs';
import { digest } from '../../scripts/runtime/update/remote.mjs';
import { ownWorkspace } from './workspace-processes.mjs';

// Portable self-update operates on copied app folders; every fixture lives in a
// temporary project with no source checkout, npm install or network access.
export const project = fileURLToPath(new URL('../../', import.meta.url));
const built = join(project, 'bin/apps/worker');
export const installed = JSON.parse(await readFile(join(built, 'package.json'), 'utf8')).version;

export function invoke(cwd, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(cwd, 'bin/apps/worker/cli.mjs'), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', part => stdout += part); child.stderr.on('data', part => stderr += part);
    child.once('error', reject);
    const timeout = setTimeout(() => { child.kill(); reject(Error('CLI deadline: ' + args.join(' '))); }, 90000);
    child.once('close', code => { clearTimeout(timeout); let data; try { data = JSON.parse(stdout); } catch {} resolve({ code, stdout, stderr, data }); });
  });
}
export async function files(root, path = '') {
  const found = [];
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    const child = path ? `${path}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await files(root, child)); else found.push(child);
  }
  return found;
}
export async function workspace(t, label) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), `werk ${label} `)));
  const cleanups = [];
  // Stop through the app first; leftover detached workers (for example a restart that
  // raced a timed-out test) are terminated before the workspace is removed.
  await ownWorkspace(t, directory, async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
  const cwd = join(directory, 'project'), app = join(cwd, 'bin/apps/worker');
  await mkdir(dirname(app), { recursive: true }); await writeFile(join(directory, 'package.json'), '{"type":"commonjs"}');
  await cp(built, app, { recursive: true });
  return { directory, cwd, app, cleanup: callback => cleanups.push(callback) };
}
/** A release payload containing the built worker app relabelled as `version`, plus its verifier. */
const memo = new Map();
const once = (key, create) => { if (!memo.has(key)) memo.set(key, create()); return memo.get(key); };
const releasePayload = (version, { stateFormat = 1, tamper = false } = {}) => once(JSON.stringify(['payload', version, stateFormat, tamper]), async () => {
  const payload = [];
  for (const path of await files(built)) {
    let content = await readFile(join(built, ...path.split('/')));
    if (path === 'package.json') content = Buffer.from(content.toString('utf8').replace(`"version": "${installed}"`, `"version": "${version}"`));
    payload.push({ path: `bin/apps/worker/${path}`, content, mode: 0o644 });
  }
  payload.push({ path: 'scripts/release/verify.mjs', content: await readFile(join(project, 'scripts/release/verify.mjs')), mode: 0o644 });
  const manifest = { schemaVersion: 1, name: 'werk', version, updateProtocol: 1, stateFormat, files: payload.map(file => ({ path: file.path, bytes: file.content.length, sha256: digest(file.content) })) };
  if (tamper) payload.find(file => file.path === 'bin/apps/worker/README.md').content = Buffer.from('changed after signing');
  return [...payload, { path: 'release-manifest.json', content: Buffer.from(JSON.stringify(manifest)), mode: 0o644 }];
});
export async function extracted(directory, version, options) {
  const root = join(directory, `werk-${version}`);
  for (const file of await releasePayload(version, options)) { await mkdir(dirname(join(root, file.path)), { recursive: true }); await writeFile(join(root, file.path), file.content); }
  return root;
}
export async function githubRelease(version, options) {
  const { tarGzip } = await once(JSON.stringify(['archive', version]), async () => createArchives((await releasePayload(version)).map(file => ({ ...file, path: `werk-${version}/${file.path}` }))));
  const sums = `${digest(tarGzip)}  werk-${version}.tar.gz\n${'a'.repeat(64)}  werk-${version}.zip\n${'b'.repeat(64)}  install.mjs\n`;
  const urls = [];
  const fetcher = async url => {
    urls.push(url);
    if (url.endsWith('/releases/latest/download/SHA256SUMS') || url.endsWith(`/download/v${version}/SHA256SUMS`)) return new Response(sums);
    if (url.endsWith(`/download/v${version}/werk-${version}.tar.gz`)) return new Response(options?.corrupt ? Buffer.from('corrupt') : tarGzip);
    return new Response('', { status: 404 });
  };
  return { fetcher, urls };
}
export const appVersion = async app => JSON.parse(await readFile(join(app, 'package.json'), 'utf8')).version;
export const leftovers = async app => (await readdir(join(dirname(app), '.worker-update'))).filter(name => name.startsWith('next-') || name === 'update.lock');

// Inject narrow filesystem faults into this process only. Worker subprocesses
// retain the real operations, so these checks exercise recovery against a live owner.
export function filesystemFault(t, name, intercept) {
  const original = fs[name];
  const mock = t.mock.method(fs, name, (...args) => intercept(original, ...args));
  syncBuiltinESMExports();
  const restore = () => { mock.mock.restore(); syncBuiltinESMExports(); };
  t.after(restore);
  return restore;
}
