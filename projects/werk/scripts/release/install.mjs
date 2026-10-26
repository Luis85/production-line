#!/usr/bin/env node
// Standalone release asset: packaging pins the version, repository and archive hash.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const release = /* RELEASE_CONFIG */ null;
const limit = 256 * 1024 * 1024;
const listingTimeoutMs = 120_000, extractionFloorMs = 300_000, extractionMsPerEntry = 200;
// Extraction time grows with the entry count (about 134-178 s for 2,982 entries on Windows).
export const extractionTimeoutMs = entries => Math.max(extractionFloorMs, entries * extractionMsPerEntry);

function tar(exec, action, archive, args, options) {
  try { return exec('tar', args, options); }
  catch (error) {
    if (error?.code !== 'ETIMEDOUT') throw error;
    throw Error(`${action} exceeded ${Math.ceil(options.timeout / 1000)} s. Extract ${archive} yourself and run update apply --from <extracted folder> (add --stop/--in-place as needed).`, { cause: error });
  }
}

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

/**
 * @param {any} config
 * @param {any} options
 * @param {{ fetcher?: typeof fetch, log?: (message: string) => void, exec?: (file: string, args: string[], options: object) => any }} [seams] `exec` runs tar (tests inject failures).
 */
export async function install(config, options, { fetcher = fetch, log = console.log, exec = execFileSync } = {}) {
  if (process.versions.node.split('.')[0] !== '24') throw Error('Werk requires Node.js 24.x. Install Node 24 and retry.');
  if (!config || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(config.version) || !/^[\w.-]+\/[\w.-]+$/.test(config.repository) || !/^[a-f0-9]{64}$/.test(config.sha256)) throw Error('Use install.mjs from a published GitHub release, not the source template.');
  const name = `werk-${config.version}`, archive = `${name}.tar.gz`;
  const home = config.layout === 'werk-home-v1';
  if (home && (options.file || options.stateDir)) throw Error('--file and --state-dir are legacy system installer options. Home selects its own state; use worker.mjs migration plan for retained standalone state.');
  const destination = home ? resolve(options.directory) : join(resolve(options.directory), name), parent = home ? resolve(destination, '..') : resolve(options.directory);
  async function fresh() {
    try {
      const info = await lstat(destination);
      if (home && !info.isSymbolicLink() && info.isDirectory() && (await readdir(destination)).length === 0) return true;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    throw Error('Destination already exists and is not empty. Existing projects, state and files were preserved. Use the Home update command or choose a new empty Home.');
  }
  await fresh();
  try { exec('tar', ['--version'], { stdio: 'ignore', timeout: 10000, windowsHide: true }); }
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
    const listing = tar(exec, 'Listing the release archive', archive, ['-tzf', archive], { cwd: staging, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: listingTimeoutMs, windowsHide: true });
    const paths = listing.trimEnd().split(/\r?\n/);
    const roots = new Set(['runtime', 'docs', 'worker.mjs', 'werk.mjs', 'werk-docker.sh', 'werk-docker.ps1', 'README.md', 'AGENTS.md', 'LICENSE', 'CHANGELOG.md', 'release-manifest.json']);
    if (paths.length > 11000 || paths.some(path => /[:\\\x00-\x1f\x7f]/.test(path) || (home ? !roots.has(path.split('/')[0]) : !path.startsWith(`${name}/`)) || path.replace(/\/$/, '').split('/').some(part => !part || part === '.' || part === '..'))) throw Error('Unsafe release archive paths');
    const types = tar(exec, 'Inspecting release archive entry types', archive, ['-tvzf', archive], { cwd: staging, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: listingTimeoutMs, windowsHide: true });
    if (types.trimEnd().split(/\r?\n/).some(line => !/^[-d][rwxSsTt-]{9}/.test(line))) throw Error('Release archive links and special files are forbidden.');
    tar(exec, `Extracting the release archive (${paths.length} entries)`, archive, ['-xzf', archive], { cwd: staging, stdio: 'pipe', timeout: extractionTimeoutMs(paths.length), windowsHide: true });
    const extracted = home ? staging : join(staging, name);
    if (home) await rm(archivePath);
    const manifest = JSON.parse(await readFile(join(extracted, 'release-manifest.json'), 'utf8'));
    if (manifest.version !== config.version) throw Error('Release manifest version mismatch');
    if (home && manifest.layout !== 'werk-home-v1') throw Error('This archive uses a legacy layout; choose an explicit legacy recovery or a new Werk Home release.');
    const { verifyRelease } = await import(pathToFileURL(join(extracted, ...(home ? ['runtime'] : []), 'scripts/release/verify.mjs')).href);
    await verifyRelease(extracted);
    if (await fresh()) await rmdir(destination);
    await rename(extracted, destination);
    log(`Installed Werk ${config.version} in ${destination}`);
    return destination;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function start(root, options) {
  const manifest = JSON.parse(await readFile(join(root, 'release-manifest.json'), 'utf8'));
  if (manifest.layout === 'werk-home-v1') {
    const { workerHome } = await import(pathToFileURL(join(root, 'runtime/bin/apps/worker/scripts/runtime/portable/home.mjs')).href);
    await workerHome(['start', ...(options.noOpen ? ['--no-open'] : [])], { homeRoot: root });
    return process.exitCode ?? 0;
  }
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
  if (release?.layout === 'werk-home-v1' && (options.file || options.stateDir)) throw Error('Home restart does not accept legacy system state overrides.');
  const args = [quote(join(root, release?.layout === 'werk-home-v1' ? 'worker.mjs' : 'werk.mjs')), ...(release?.layout === 'werk-home-v1' ? [] : ['up'])];
  if (options.file) args.push('--file', quote(options.file));
  if (options.stateDir) args.push('--state-dir', quote(options.stateDir));
  if (options.noOpen) args.push('--no-open');
  return `node ${args.join(' ')}`;
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    console.log('node install.mjs --directory EMPTY_HOME [--no-start] [--no-open]\nRequires Node 24 and tar. Downloads and verifies this installer\'s exact release, then starts the central worker in the selected empty Home. Existing projects, state and installations are never overwritten.');
    return;
  }
  const root = await install(release, options);
  console.log(`Restart later (${process.platform === 'win32' ? 'PowerShell' : 'Bash'}): ${restartCommand(root, options)}`);
  if (options.start) process.exitCode = await start(root, options);
}
let isMain = false;
try { isMain = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* Imported module. */ }
if (isMain) main().catch(error => { console.error(error.message); process.exitCode = 1; });
