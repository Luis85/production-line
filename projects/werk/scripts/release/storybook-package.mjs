import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArchives } from './archives.mjs';
import { isMainScript } from './verify.mjs';
import { sourceDigest } from '../storybook/source.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const qualificationPath = 'storymap/qualification.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const safePath = path => typeof path === 'string' && path.length > 0 && !/[:\\\x00-\x1f\x7f]/.test(path) && !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..');
const integer = value => Number.isSafeInteger(value) && value > 0;

async function collect(directory) {
  const entries = [];
  let totalBytes = 0;
  async function visit(path) {
    const info = await lstat(join(directory, path));
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw Error(`Storybook inputs must be regular files or directories: ${path || '.'}`);
    if (info.isDirectory()) {
      for (const child of (await readdir(join(directory, path))).sort()) await visit(path ? `${path}/${child}` : child);
      return;
    }
    if (!safePath(path)) throw Error(`Unsafe Storybook path: ${path}`);
    if (info.size > 32 * 1024 * 1024) throw Error(`Storybook file exceeds 32 MiB: ${path}`);
    totalBytes += info.size;
    if (totalBytes > 256 * 1024 * 1024 || entries.length >= 10000) throw Error('Storybook exceeds packaging limits (256 MiB / 10,000 files)');
    entries.push({ path, content: await readFile(join(directory, path)), mode: 0o644 });
  }
  await visit('');
  return entries;
}

export async function packageStorybook(projectRoot = root, output = join(projectRoot, 'release')) {
  const info = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(info.version)) throw Error('Package version is not a safe release version');
  const entries = await collect(join(projectRoot, 'storybook-static'));
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  for (const path of ['index.html', 'index.json', 'storymap/index.html', 'storymap/manifest.json', qualificationPath]) {
    if (!byPath.has(path)) throw Error(`Missing Storybook output: ${path}; run npm run storybook:ci first`);
  }
  const qualification = JSON.parse(byPath.get(qualificationPath).content.toString('utf8'));
  if (qualification.schemaVersion !== 1 || qualification.passed !== true || !Array.isArray(qualification.errors) || qualification.errors.length) throw Error('Storybook qualification did not pass');
  if (qualification.version !== info.version) throw Error('Storybook qualification version is stale');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (!/^[a-f0-9]{40,64}$/.test(commit) || qualification.commit !== commit) throw Error('Storybook qualification commit is stale');
  if (qualification.sourceDigest !== await sourceDigest(projectRoot)) throw Error('Storybook qualification source digest is stale');
  const coverage = qualification.coverage;
  if (!coverage || !integer(coverage.total) || coverage.covered !== coverage.total || !Array.isArray(coverage.missing) || coverage.missing.length) throw Error('Storybook component coverage is incomplete');
  const screenshots = entries.filter(entry => /^storymap\/screenshots\/[^/]+\.png$/.test(entry.path));
  if (!integer(qualification.stories) || !integer(qualification.screenshots) || qualification.screenshots !== screenshots.length || qualification.screenshots < qualification.stories) throw Error('Storybook screenshot coverage is incomplete');
  if (!Array.isArray(qualification.files) || qualification.files.length !== entries.length - 1) throw Error('Storybook qualified inventory differs from generated files');
  const seen = new Set();
  for (const file of qualification.files) {
    if (!file || !safePath(file.path) || file.path === qualificationPath || seen.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw Error('Invalid Storybook qualified inventory');
    seen.add(file.path);
    const entry = byPath.get(file.path);
    if (!entry || sha256(entry.content) !== file.sha256) throw Error(`Storybook file integrity mismatch: ${file.path}`);
  }
  const prefix = `werk-storybook-${info.version}`;
  const archive = await createArchives(entries.map(entry => ({ ...entry, path: `${prefix}/${entry.path}` })));
  const name = `${prefix}.zip`;
  const checksum = sha256(archive.zip);
  const staging = join(dirname(output), `.${basename(output)}-storybook-${process.pid}-${Date.now()}`);
  await mkdir(staging, { recursive: true });
  try {
    await writeFile(join(staging, name), archive.zip);
    await writeFile(join(staging, 'STORYBOOK-SHA256SUMS'), `${checksum}  ${name}\n`);
    await mkdir(output, { recursive: true });
    for (const asset of [name, 'STORYBOOK-SHA256SUMS']) await rename(join(staging, asset), join(output, asset));
  } finally { await rm(staging, { recursive: true, force: true }); }
  return { version: info.version, commit, output, files: entries.length, stories: qualification.stories, screenshots: qualification.screenshots, artifact: { name, bytes: archive.zip.length, sha256: checksum } };
}

if (isMainScript(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw Error('Usage: node scripts/release/storybook-package.mjs');
    console.log(JSON.stringify(await packageStorybook(), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
