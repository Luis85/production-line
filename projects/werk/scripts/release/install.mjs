#!/usr/bin/env node
// Standalone release asset: packaging pins the version, repository and archive hash.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const release = /* RELEASE_CONFIG */ null;
const limit = 256 * 1024 * 1024;

export function parse(args) {
  const options = { directory: process.cwd(), start: true, noOpen: false };
  const seen = new Set();
  while (args.length) {
    const flag = args.shift();
    if (seen.has(flag)) throw Error(`Repeated option: ${flag}`);
    seen.add(flag);
    if (flag === '--help') options.help = true;
    else if (flag === '--no-start') options.start = false;
    else if (flag === '--no-open') options.noOpen = true;
    else if (['--directory', '--file', '--state-dir'].includes(flag)) {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw Error(`${flag} requires a path`);
      options[{ '--directory': 'directory', '--file': 'file', '--state-dir': 'stateDir' }[flag]] = resolve(value);
    } else throw Error(`Unknown option: ${flag}. Use --help.`);
  }
  return options;
}

async function download(url, fetcher) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw Error(`Release download failed (HTTP ${response.status}). Check the published release and your network access.`);
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) throw Error('Release download exceeds 256 MiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function absent(path) {
  try { await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw Error(`Destination already exists: ${path}. Existing files were preserved. Start that installation with node werk.mjs up, or choose another --directory.`);
}

export async function install(config, options, { fetcher = fetch, log = console.log } = {}) {
  if (process.versions.node.split('.')[0] !== '24') throw Error('Werk requires Node.js 24.x. Install Node 24 and retry.');
  if (!config || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(config.version) || !/^[\w.-]+\/[\w.-]+$/.test(config.repository) || !/^[a-f0-9]{64}$/.test(config.sha256)) throw Error('Use install.mjs from a published GitHub release, not the source template.');
  const name = `werk-${config.version}`, archive = `${name}.tar.gz`;
  const parent = resolve(options.directory), destination = join(parent, name);
  await absent(destination);
  try { execFileSync('tar', ['--version'], { stdio: 'ignore', timeout: 10000, windowsHide: true }); }
  catch { throw Error('tar is required on PATH (included in current Windows, macOS and most Linux systems).'); }
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, '.werk-install-'));
  try {
    log(`Downloading Werk ${config.version} from ${config.repository}...`);
    const bytes = await download(`https://github.com/${config.repository}/releases/download/v${config.version}/${archive}`, fetcher);
    if (createHash('sha256').update(bytes).digest('hex') !== config.sha256) throw Error('Release checksum mismatch. Nothing was installed or started.');
    const archivePath = join(staging, archive);
    await writeFile(archivePath, bytes, { flag: 'wx' });
    // Use a relative archive name from its directory: GNU tar treats a Windows
    // drive colon in an absolute filename as remote-host syntax.
    // Reject paths outside the expected root before invoking the system extractor.
    const listing = execFileSync('tar', ['-tzf', archive], { cwd: staging, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 30000, windowsHide: true });
    const paths = listing.trimEnd().split(/\r?\n/);
    if (paths.length > 11000 || paths.some(path => /[:\\\x00-\x1f\x7f]/.test(path) || !path.startsWith(`${name}/`) || path.replace(/\/$/, '').split('/').some(part => !part || part === '.' || part === '..'))) throw Error('Unsafe release archive paths');
    execFileSync('tar', ['-xzf', archive], { cwd: staging, stdio: 'pipe', timeout: 60000, windowsHide: true });
    const extracted = join(staging, name);
    const manifest = JSON.parse(await readFile(join(extracted, 'release-manifest.json'), 'utf8'));
    if (manifest.version !== config.version) throw Error('Release manifest version mismatch');
    const { verifyRelease } = await import(pathToFileURL(join(extracted, 'scripts/release/verify.mjs')).href);
    await verifyRelease(extracted);
    await absent(destination);
    await rename(extracted, destination);
    log(`Installed Werk ${config.version} in ${destination}`);
    return destination;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function start(root, options) {
  const { runNative } = await import(pathToFileURL(join(root, 'scripts/runtime/update/launcher.mjs')).href);
  const args = ['up', '--no-update', '--file', options.file ?? join(root, 'examples/system.yaml')];
  if (options.stateDir) args.push('--state-dir', options.stateDir);
  if (options.noOpen) args.push('--no-open');
  return runNative(root, args);
}

export function restartCommand(root, options, platform = process.platform) {
  // Single-quoted literals prevent expansion of $(), backticks and shell operators.
  // PowerShell escapes a quote by doubling it; Bash closes/escapes/reopens it.
  const quote = value => "'" + value.replaceAll("'", platform === 'win32' ? "''" : "'\\''") + "'";
  const args = [quote(join(root, 'werk.mjs')), 'up'];
  if (options.file) args.push('--file', quote(options.file));
  if (options.stateDir) args.push('--state-dir', quote(options.stateDir));
  if (options.noOpen) args.push('--no-open');
  return `node ${args.join(' ')}`;
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    console.log('node install.mjs [--directory PATH] [--no-start] [--no-open] [--file PATH] [--state-dir PATH]\nRequires Node 24 and tar. Downloads and verifies this installer\'s exact release, then starts the default Factory system. Existing installations are never overwritten.');
    return;
  }
  const root = await install(release, options);
  console.log(`Restart later (${process.platform === 'win32' ? 'PowerShell' : 'Bash'}): ${restartCommand(root, options)}`);
  if (options.start) process.exitCode = await start(root, options);
}
let isMain = false;
try { isMain = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* Imported module. */ }
if (isMain) main().catch(error => { console.error(error.message); process.exitCode = 1; });
