import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sourceDigest } from '../storybook/source.mjs';

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

export async function readQualifiedStorybook(projectRoot) {
  const info = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(info.version)) throw Error('Package version is not a safe release version');
  const entries = await collect(join(projectRoot, 'storybook-static'));
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  for (const path of ['index.html', 'index.json', 'storymap/index.html', 'storymap/manifest.json', 'handbook/index.html', 'handbook/catalog.json', qualificationPath]) {
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
  const documents = JSON.parse(byPath.get('handbook/catalog.json').content.toString('utf8'));
  const documentation = qualification.documentation;
  if (documents.commit !== commit || documents.sourceDigest !== qualification.sourceDigest || documents.version !== info.version) throw Error('Documentation identity differs from qualified Storybook');
  if (!Array.isArray(documents.pages) || !documents.pages.length || !documentation || documentation.passed !== true || documentation.pages !== documents.pages.length || !Array.isArray(documentation.results)
    || documentation.results.length !== 2 || new Set(documentation.results.map(result => result.viewport)).size !== 2
    || documentation.results.some(result => !['desktop', 'mobile'].includes(result.viewport) || result.passed !== true || result.pages !== documents.pages.length)) throw Error('Documentation browser qualification is incomplete');
  const documentPaths = new Set();
  for (const page of documents.pages) {
    if (!safePath(page.path) || !/^handbook\/[a-zA-Z0-9_-]+\.html$/.test(page.path) || documentPaths.has(page.path) || !byPath.has(page.path)) throw Error('Documentation page inventory is incomplete');
    documentPaths.add(page.path);
  }
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
  return { version: info.version, commit, sourceDigest: qualification.sourceDigest, entries, qualification };
}
