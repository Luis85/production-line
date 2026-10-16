import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainScript } from './verify.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
const categories = new Set(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']);
const usage = 'Usage: node scripts/release/changelog.mjs check|notes [--version VERSION] [--out PATH (notes only)]';

// Heading-like examples and commented drafts must not become release entries.
function visibleLines(markdown) {
  let fence;
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, comment => comment.replace(/[^\n]/g, ' ')).split('\n');
  const visible = lines.map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return '';
    }
    if (marker) { fence = marker[1]; return ''; }
    return line;
  });
  if (fence) throw Error('CHANGELOG.md contains an unclosed code fence');
  if (visible.some(line => line.includes('<!--'))) throw Error('CHANGELOG.md contains an unclosed HTML comment');
  return visible;
}

function meaningfulEntry(lines, version) {
  let category;
  const counts = new Map();
  for (const line of lines) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      category = heading[1];
      if (!categories.has(category) || counts.has(category)) throw Error(`Invalid or duplicate changelog category for ${version}: ${category}`);
      counts.set(category, 0);
      continue;
    }
    const item = /^[-*+]\s+(.+)$/.exec(line)?.[1]?.trim();
    if (item === undefined) continue;
    if (!category) throw Error(`Changelog ${version} list items need a Keep a Changelog category`);
    const plain = item.replace(/^\[[ xX]\]\s*/, '').replace(/\[([^\]]+)\](?:\([^)]*\))?/g, '$1').replace(/[`*_]/g, '').trim();
    if (!/\p{L}{2}/u.test(plain) || /^(?:todo|tbd|n\/?a|none|placeholder|coming soon|no changes(?: yet)?)(?:\b|[.!])/i.test(plain)) {
      throw Error(`Changelog ${version} contains a placeholder instead of a descriptive change`);
    }
    counts.set(category, counts.get(category) + 1);
  }
  if (!counts.size || [...counts.values()].some(count => !count)) throw Error(`Changelog ${version} must contain descriptive list items in every category`);
}

export function parseReleaseChangelog(markdown, version) {
  if (typeof version !== 'string' || !versionPattern.test(version)) throw Error('Package version is not a safe release version');
  if (typeof markdown !== 'string' || Buffer.byteLength(markdown) > 1024 * 1024) throw Error('CHANGELOG.md must be text within 1 MiB');
  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n'), visible = visibleLines(normalized);
  const entries = [], versions = new Set();
  for (let line = 0; line < visible.length; line++) {
    if (!/^##\s/.test(visible[line])) continue;
    if (visible[line].trim() === '## [Unreleased]') {
      if (entries.length) throw Error('CHANGELOG.md must have exactly one leading Unreleased section');
      entries.push({ version: 'Unreleased', line });
      continue;
    }
    const match = /^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})\s*$/.exec(visible[line]);
    if (!match || !versionPattern.test(match[1])) throw Error('Changelog release headings must use ## [VERSION] - YYYY-MM-DD');
    const date = new Date(`${match[2]}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[2]) throw Error(`Invalid changelog release date: ${match[2]}`);
    if (versions.has(match[1])) throw Error(`Duplicate changelog version: ${match[1]}`);
    versions.add(match[1]);
    entries.push({ version: match[1], date: match[2], line });
  }
  if (entries[0]?.version !== 'Unreleased') throw Error('CHANGELOG.md must have exactly one leading Unreleased section');
  const index = entries.findIndex(entry => entry.version === version);
  if (index < 0) throw Error(`Missing changelog entry for package version ${version}`);
  if (index !== 1) throw Error(`Changelog entry for package version ${version} must be the first release after Unreleased`);
  const entry = entries[index], end = entries[index + 1]?.line ?? lines.length;
  meaningfulEntry(visible.slice(entry.line + 1, end), version);
  return { version, date: entry.date, notes: lines.slice(entry.line, end).join('\n').trimEnd() + '\n' };
}

export async function readReleaseChangelog(projectRoot = root, { version, env = process.env } = {}) {
  const info = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  if (version !== undefined && version !== info.version) throw Error('Requested release version must match package.json version');
  const tag = env.GITHUB_REF_TYPE === 'tag' ? env.GITHUB_REF_NAME : env.GITHUB_REF?.startsWith('refs/tags/') ? env.GITHUB_REF.slice(10) : undefined;
  if (tag !== undefined && tag !== `v${info.version}`) throw Error('Release tag must match package.json version');
  const path = join(projectRoot, 'CHANGELOG.md'), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error('CHANGELOG.md must be a regular file within 1 MiB');
  const markdown = await readFile(path, 'utf8');
  return { ...parseReleaseChangelog(markdown, info.version), markdown };
}

export async function changelogCommand(args, projectRoot = root, env = process.env) {
  const [command, ...flags] = args;
  if (!['check', 'notes'].includes(command)) throw Error(usage);
  const options = {};
  for (let index = 0; index < flags.length; index += 2) {
    const key = flags[index];
    if (!['--version', '--out'].includes(key) || !flags[index + 1] || flags[index + 1].startsWith('--') || Object.hasOwn(options, key)) throw Error(usage);
    options[key] = flags[index + 1];
  }
  if (command === 'check' && options['--out']) throw Error(usage);
  const result = await readReleaseChangelog(projectRoot, { version: options['--version'], env });
  if (command === 'check') return JSON.stringify({ version: result.version, date: result.date, valid: true }) + '\n';
  if (options['--out']) {
    const output = resolve(projectRoot, options['--out']);
    const existing = await lstat(output).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw Error('Notes output must be a regular file, not a symbolic link');
    await mkdir(dirname(output), { recursive: true });
    const canonical = existing ? await realpath(output) : join(await realpath(dirname(output)), basename(output));
    const sources = await Promise.all(['CHANGELOG.md', 'package.json'].map(path => realpath(join(projectRoot, path))));
    if (sources.includes(canonical)) throw Error('Notes output must not replace a release source file');
    const staging = await mkdtemp(join(dirname(output), '.werk-changelog-'));
    try {
      await writeFile(join(staging, 'notes.md'), result.notes);
      await rename(join(staging, 'notes.md'), output);
    } finally { await rm(staging, { recursive: true, force: true }); }
    return '';
  }
  return result.notes;
}

if (isMainScript(import.meta.url)) {
  try { process.stdout.write(await changelogCommand(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
