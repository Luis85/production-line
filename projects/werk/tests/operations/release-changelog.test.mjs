import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReleaseChangelog, readReleaseChangelog, changelogCommand } from '../../scripts/release/changelog.mjs';

const entry = (version = '1.2.3', body = '### Added\n\n- Portable worker setup preserves project configuration.') => `## [${version}] - 2026-10-16\n\n${body}\n`;
const changelog = (body = entry()) => `# Changelog\n\n## [Unreleased]\n\n${body}`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'werk changelog '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '1.2.3' }));
  await writeFile(join(root, 'CHANGELOG.md'), changelog());
  return root;
}

test('extracts only the current entry, preserves literal Markdown and normalizes newlines', () => {
  const current = entry('1.2.3', '### Fixed\n\n- Preserve `$HOME`, `$(touch sentinel)` and Unicode Grüße literally.\n\n```md\n## [9.9.9] - 2000-01-01\n```');
  const source = changelog(current + '\n' + entry('1.2.2'));
  assert.deepEqual(parseReleaseChangelog(source.replaceAll('\n', '\r\n'), '1.2.3'), { version: '1.2.3', date: '2026-10-16', notes: current });
  assert.equal(parseReleaseChangelog(changelog(entry('1.2.3-rc.1')), '1.2.3-rc.1').version, '1.2.3-rc.1');
});

for (const [name, source, pattern] of [
  ['unclosed hidden draft', changelog('<!-- Draft entry\n' + entry()), /unclosed HTML comment/],
  ['missing release', changelog(''), /Missing changelog entry/],
  ['wrong release', changelog(entry('1.2.4')), /Missing changelog entry/],
  ['duplicate release', changelog(entry() + '\n' + entry()), /Duplicate changelog version/],
  ['empty release', changelog(entry('1.2.3', '')), /descriptive list items/],
  ['empty category', changelog(entry('1.2.3', '### Added')), /descriptive list items/],
  ['placeholder only', changelog(entry('1.2.3', '### Added\n\n- TODO: describe changes')), /placeholder/],
  ['task-list placeholder', changelog(entry('1.2.3', '### Added\n\n- [ ] TBD')), /placeholder/],
  ['link placeholder', changelog(entry('1.2.3', '### Added\n\n- [TODO](https://example.com)')), /placeholder/],
  ['commented changes only', changelog(entry('1.2.3', '### Added\n\n<!-- - Not a published change. -->')), /descriptive list items/],
  ['uncategorized changes', changelog(entry('1.2.3', '- Portable setup supports projects.')), /category/],
  ['unknown category', changelog(entry('1.2.3', '### Misc\n\n- Portable setup supports projects.')), /category/],
  ['duplicate category', changelog(entry('1.2.3', '### Added\n\n- Portable setup supports projects.\n\n### Added\n\n- Another improvement.')), /category/],
  ['missing Unreleased', entry(), /leading Unreleased/],
  ['duplicate Unreleased', changelog('## [Unreleased]\n\n' + entry()), /leading Unreleased/],
  ['current release below another version', changelog(entry('1.2.4') + '\n' + entry()), /first release/],
  ['invalid calendar date', changelog().replace('2026-10-16', '2026-02-30'), /Invalid changelog release date/],
  ['undated release', changelog().replace(' - 2026-10-16', ''), /release headings/],
]) test(`rejects ${name}`, () => assert.throws(() => parseReleaseChangelog(source, '1.2.3'), pattern));

for (const version of ['01.2.3', '1.2', '1.2.3-01', '1.2.3-rc..1', '../1.2.3']) {
  test(`rejects invalid release version ${version}`, () => assert.throws(() => parseReleaseChangelog(changelog(entry(version)), version), /safe release version/));
}

test('requires package, requested version and tag to agree before generating notes', async t => {
  const root = await fixture(t);
  await assert.rejects(readReleaseChangelog(root, { version: '1.2.4', env: {} }), /Requested release version must match/);
  for (const env of [{ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.4' }, { GITHUB_REF: 'refs/tags/v1.2.4' }]) {
    await assert.rejects(readReleaseChangelog(root, { env }), /Release tag must match/);
  }
  assert.equal((await readReleaseChangelog(root, { env: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.3' } })).version, '1.2.3');
  await rm(join(root, 'CHANGELOG.md'));
  await assert.rejects(readReleaseChangelog(root, { env: {} }), { code: 'ENOENT' });
});

test('notes output is deterministic and invalid input leaves existing output intact', async t => {
  const root = await fixture(t);
  assert.deepEqual(JSON.parse(await changelogCommand(['check'], root, {})), { version: '1.2.3', date: '2026-10-16', valid: true });
  assert.equal(await changelogCommand(['notes'], root, {}), entry());
  assert.equal(await changelogCommand(['notes', '--out', 'candidate/notes.md'], root, {}), '');
  assert.equal(await readFile(join(root, 'candidate/notes.md'), 'utf8'), entry());
  await writeFile(join(root, 'CHANGELOG.md'), changelog(''));
  await assert.rejects(changelogCommand(['notes', '--out', 'candidate/notes.md'], root, {}), /Missing changelog entry/);
  assert.equal(await readFile(join(root, 'candidate/notes.md'), 'utf8'), entry());
  await assert.rejects(changelogCommand(['notes', '--out', 'uncreated/notes.md'], root, {}), /Missing changelog entry/);
  await assert.rejects(stat(join(root, 'uncreated')), { code: 'ENOENT' });
});

test('CLI works without npm dependencies and fails closed with no notes on invalid input', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'scripts/release'), { recursive: true });
  for (const name of ['changelog.mjs', 'verify.mjs']) await writeFile(join(root, 'scripts/release', name), await readFile(new URL(`../../scripts/release/${name}`, import.meta.url)));
  const env = { ...process.env, GITHUB_REF_TYPE: 'branch', GITHUB_REF: 'refs/heads/main' };
  const cli = join(root, 'scripts/release/changelog.mjs');
  const valid = spawnSync(process.execPath, [cli, 'notes'], { encoding: 'utf8', env, timeout: 15000 });
  assert.equal(valid.status, 0, valid.stderr); assert.equal(valid.stdout, entry());
  const invalid = spawnSync(process.execPath, [cli, 'notes', '--version', '9.9.9'], { encoding: 'utf8', env, timeout: 15000 });
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ''); assert.match(invalid.stderr, /must match package.json/);
  for (const args of [[], ['unexpected'], ['check', '--out', 'notes.md'], ['notes', '--out'], ['notes', '--version', '1.2.3', '--version', '1.2.3']]) {
    await assert.rejects(changelogCommand(args, root, {}), /Usage:/);
  }
  if (process.platform !== 'win32') {
    const alias = join(root, 'alias'); await symlink(join(root, 'scripts'), alias, 'dir');
    const aliased = spawnSync(process.execPath, [join(alias, 'release/changelog.mjs'), 'notes'], { encoding: 'utf8', env, timeout: 15000 });
    assert.equal(aliased.status, 0, aliased.stderr); assert.equal(aliased.stdout, entry());
  }
});


test('notes never overwrite changelog sources through direct or symbolic-link destinations', async t => {
  const root = await fixture(t);
  const before = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  for (const path of ['CHANGELOG.md', 'package.json']) await assert.rejects(changelogCommand(['notes', '--out', path], root, {}), /must not replace/);
  try { await symlink(join(root, 'CHANGELOG.md'), join(root, 'notes.md')); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows symlink privilege unavailable'); throw error; }
  await assert.rejects(changelogCommand(['notes', '--out', 'notes.md'], root, {}), /symbolic link/);
  await symlink(root, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(changelogCommand(['notes', '--out', 'alias/CHANGELOG.md'], root, {}), /must not replace/);
  assert.equal(await readFile(join(root, 'CHANGELOG.md'), 'utf8'), before);
});
