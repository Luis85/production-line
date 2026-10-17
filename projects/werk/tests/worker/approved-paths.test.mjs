import test from 'node:test';
import assert from 'node:assert/strict';
import { validateApprovedPaths, safeApprovedPath } from '../../src/worker/dist/worker/application/approved-paths.js';
import { safeApprovedPath as liveSafeApprovedPath, normalizeExecution } from '../../scripts/runtime/execution.mjs';

// Real Obsidian vault names: umlauts, ß, commas, parentheses, ampersand, en dash, arrows and apostrophes.
export const vaultPaths = [
  'docs/requirements/requirements-functional-areas/FA-9_Material-Logistics/LACF-REQ-033 Warenein- und -ausgang einschließlich Zoll abwickeln.md',
  'docs/requirements/FA-2_Vertrieb/LACF-REQ-101 Angebote prüfen, freigeben & versenden.md',
  'docs/requirements/Übersicht (Stand Q3).md',
  'docs/Ärger – Eskalation → Lösung.md',
  "docs/Kunden's Änderungswünsche — Größe.md",
  'docs/Öffnungszeiten’ Planung + Pflege.md',
  'src/with+plus.ts',
  'notes/日本語のメモ.md',
  'notes/café.md',
];
const accepted = ['AGENTS.md', 'CLAUDE.md', 'src/new-feature.ts', 'docs/new feature.md', 'src/secretary.ts', 'docs/console.md', 'docs/Konsole.md', 'docs/com10.md', 'docs/auxiliary.md', ...vaultPaths];
const rejected = [
  '', '/abs.md', '../outside.md', 'docs/../x.md', 'docs/./x.md', 'a//b.md', 'docs/', '.env', 'src/.cache/output.ts', '-option.ts',
  'a\\b.md', 'docs/a<b.md', 'docs/a>b.md', 'docs/a:b.md', 'docs/a"b.md', 'docs/a|b.md', 'docs/a?.md', 'docs/a*.md', 'docs/stream.md:secret',
  'docs/tab\there.md', 'docs/new\nline.md', 'docs/nul\0.md', 'docs/bell\x07.md', 'docs/del\x7f.md', 'docs/bidi‮.md', 'docs/zero​width.md', 'docs/line sep.md',
  'docs/trailing.', 'docs/trailing ', 'docs/folder./x.md', 'docs/folder /x.md',
  'CON', 'docs/con.md', 'docs/PRN.txt', 'aux.tar.gz', 'docs/Nul', 'docs/COM1.md', 'docs/lpt9.log', 'docs/COM¹.md', 'docs/con .md', 'docs/ｃｏｎ.md',
  'credentials.txt', 'config/secrets.json', 'id_rsa', 'keys/id_ed25519.pub', 'config/client.pem', 'config/client.key', 'config/client.p12', 'config/client.pfx',
  'config/ｓｅｃｒｅｔｓ.json', 'config/ſecrets.json', 'config/Secrets/ä.md', 'config/client.ＰＥＭ',
  'PROGRA~1/x.md', 'docs/$HOME.md', 'docs/`id`.md', 'docs/[link].md', 'docs/#tag.md', 'docs/fullwidth／slash.md', 'docs/division∕slash.md',
  'x'.repeat(241), 'docs/' + 'ä'.repeat(128) + '.md',
];

test('approved paths accept real vault names in any script and keep them NFC', () => {
  for (const path of accepted) assert.deepEqual(validateApprovedPaths([path]), [path.normalize('NFC')], path);
  assert.deepEqual(validateApprovedPaths(vaultPaths), vaultPaths);
  const decomposed = vaultPaths[1].normalize('NFD');
  assert.notEqual(decomposed, vaultPaths[1]);
  assert.deepEqual(validateApprovedPaths([decomposed]), [vaultPaths[1]]);
  assert.equal(validateApprovedPaths(['x'.repeat(240)])[0].length, 240);
});

test('approved paths reject unsafe, Windows-reserved, overlong and secret names', () => {
  for (const path of rejected) {
    assert.throws(() => validateApprovedPaths([path]), /safe relative non-secret/, JSON.stringify(path));
    assert.equal(safeApprovedPath(path.normalize('NFC')), false, JSON.stringify(path));
  }
  for (const value of [undefined, 'docs/a.md', [], [1], Array.from({ length: 33 }, (_, i) => `docs/ä${i}.md`)]) assert.throws(() => validateApprovedPaths(value));
});

test('approved paths deduplicate on the NFC form', () => {
  const composed = 'docs/Übersicht.md', decomposed = composed.normalize('NFD');
  assert.throws(() => validateApprovedPaths([composed, decomposed]), /unique/);
  assert.throws(() => validateApprovedPaths(['docs/a.md', 'docs/a.md']), /unique/);
});

test('live Codex configuration applies the same approved-path rule', () => {
  for (const path of [...accepted, ...rejected]) assert.equal(liveSafeApprovedPath(path.normalize('NFC')), safeApprovedPath(path.normalize('NFC')), JSON.stringify(path));
  const value = { mode: 'cli', codex: { executable: '/opt/codex/bin/codex', repository: '/srv/project', allowedPaths: [vaultPaths[1].normalize('NFD')] } };
  assert.deepEqual(normalizeExecution(value).codex.allowedPaths, [vaultPaths[1]]);
  value.codex.allowedPaths = [vaultPaths[1], vaultPaths[1].normalize('NFD')];
  assert.throws(() => normalizeExecution(value), error => error instanceof Error && 'exitCode' in error && error.exitCode === 2);
});

test('approved file and parent names cannot alias across checkout platforms', () => {
  for (const paths of [
    ['docs/Ä.md', 'docs/ä.md'],
    ['Foo/a.md', 'foo/b.md'],
    ['notes/Ä/a.md', 'notes/ä/b.md'],
    ['src/file.ts', 'src/file.ts/child.md'],
  ]) {
    assert.throws(() => validateApprovedPaths(paths), /unique/, JSON.stringify(paths));
    assert.throws(() => normalizeExecution({ mode: 'cli', codex: { executable: '/opt/codex', allowedPaths: paths } }), error => error instanceof Error && 'exitCode' in error && error.exitCode === 2);
  }
  const paths = ['docs/Ä/a.md', 'docs/Ä/b.md'];
  assert.deepEqual(validateApprovedPaths(paths), paths);
  assert.deepEqual(normalizeExecution({ mode: 'cli', codex: { executable: '/opt/codex', allowedPaths: paths } }).codex.allowedPaths, paths);
});
