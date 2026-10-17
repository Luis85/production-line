import { cleanup } from './fixture-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { WorkerSessions, LocalTaskboard } from './application-fixtures.mjs';

const git = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = process.platform === 'win32' ? 120000 : 10000) { const end = Date.now() + timeout; while (Date.now() < end) { const result = await predicate(); if (result) return result; await delay(25); } throw Error('Condition timed out'); }
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-unicode-')); cleanup(t, () => rm(directory, { recursive: true, force: true }));
  const settings = new WorkerSettings(directory); await settings.init();
  const sessions = new WorkerSessions(directory, settings); await sessions.init(); cleanup(t, () => sessions.close());
  const repo = join(directory, 'repo'); await mkdir(repo);
  await git('git', ['init', repo]);
  for (const [key, value] of [['core.autocrlf', 'false'], ['core.eol', 'lf'], ['user.name', 'Werk Test'], ['user.email', 'werk@example.invalid']]) await git('git', ['config', key, value], { cwd: repo });
  return { directory, settings, sessions, repo };
}
const folder = 'docs/requirements/requirements-functional-areas/FA-9_Material-Logistics';
const existing = `${folder}/LACF-REQ-033 Warenein- und -ausgang einschließlich Zoll abwickeln.md`;
const created = "docs/backlog/Kunden's Änderungen (Größe) & Fristen – Prüfung → Freigabe.md";

test('a file task with umlaut and punctuation paths produces a patch git apply accepts', async t => {
  const { directory, settings, sessions, repo } = await fixture(t);
  await mkdir(join(repo, folder), { recursive: true }); await writeFile(join(repo, existing), '# Wareneingang\n');
  await git('git', ['add', '-A'], { cwd: repo }); await git('git', ['commit', '-m', 'Vault'], { cwd: repo });
  // Requests and model replies may use a decomposed spelling; the worker keeps the NFC approved path.
  const decomposed = created.normalize('NFD');
  assert.notEqual(decomposed, created);
  const reply = 'Prepared changes:\n' + JSON.stringify({ summary: 'Updated the requirement; tests not run', files: [
    { path: existing, content: '# Wareneingang\n\nZollabwicklung ergänzt.\n' },
    { path: decomposed, content: '# Prüfung\n' },
  ] }) + '\nReady for inspection.';
  let calls = 0;
  const board = new LocalTaskboard(directory, settings, sessions, () => ({ async reply() { calls++; return reply; } })); await board.init(); cleanup(t, () => board.close());
  await board.create({ title: 'Zoll', instruction: 'Ergänze die Zollabwicklung', repository: repo, paths: [existing, decomposed] });
  const id = board.view().tasks[0].id;
  assert.deepEqual(board.detail(id).files.map(file => file.path), [existing, created]);
  await until(async () => { await board.tick(); return board.detail(id).status === 'review' && !sessions.executor.busy; });
  const sessionId = board.detail(id).sessionId, turnId = sessions.interactions.view(sessionId).latestTurn.id;
  const transcript = sessions.detail(sessionId).chat.messages.at(-1).text;
  assert.ok(transcript.includes(created));
  assert.ok(!transcript.includes(decomposed));
  assert.match(transcript, /1 line added, 0 removed/);
  assert.equal(sessions.interactions.turn(sessionId, turnId).result.text, reply);
  await board.close();
  const restored = new LocalTaskboard(directory, settings, sessions, () => ({ async reply() { calls++; throw Error('Recovery must not replay'); } }));
  await restored.init(); cleanup(t, () => restored.close());
  assert.equal(restored.detail(id).status, 'review');
  assert.equal(calls, 1);
  const patch = join(directory, 'change.patch'); await writeFile(patch, board.detail(id).patch);
  await git('git', ['apply', '--check', patch], { cwd: repo });
  await git('git', ['apply', '--index', patch], { cwd: repo });
  assert.equal(await readFile(join(repo, existing), 'utf8'), '# Wareneingang\n\nZollabwicklung ergänzt.\n');
  assert.equal(await readFile(join(repo, created), 'utf8'), '# Prüfung\n');
  const { stdout } = await git('git', ['diff', '--cached', '--name-only', '-z'], { cwd: repo });
  assert.deepEqual(stdout.split('\0').filter(Boolean).sort(), [created, existing].sort());
});

test('a file task refuses a decomposed on-disk name instead of creating a second file', { skip: process.platform === 'darwin' && 'APFS resolves both normalization forms to the same file' }, async t => {
  const { directory, settings, sessions, repo } = await fixture(t);
  const name = 'docs/Übersicht.md';
  await mkdir(join(repo, 'docs')); await writeFile(join(repo, name.normalize('NFD')), '# Übersicht\n');
  const board = new LocalTaskboard(directory, settings, sessions, () => ({ async reply() { throw Error('should not execute'); } })); await board.init(); cleanup(t, () => board.close());
  await assert.rejects(board.create({ title: 'Übersicht', instruction: 'Aktualisieren', repository: repo, paths: [name] }), /Unicode normalization/);
  await assert.rejects(board.create({ title: 'Geräte', instruction: 'Anlegen', repository: repo, paths: ['docs/CON.md'] }), /safe relative/);
});

test('file task admission rejects a differently cased existing parent folder', async t => {
  const { directory, settings, sessions, repo } = await fixture(t);
  await mkdir(join(repo, 'Änderungen'));
  await writeFile(join(repo, 'Änderungen', 'existing.md'), 'keep\n');
  const board = new LocalTaskboard(directory, settings, sessions, () => ({ async reply() { throw Error('should not execute'); } }));
  await board.init(); cleanup(t, () => board.close());
  await assert.rejects(board.create({ title: 'Case alias', instruction: 'Create note', repository: repo, paths: ['änderungen/new.md'] }), /case or Unicode normalization/);
});

test('file task admission refuses coexisting NFC and NFD directory entries', async t => {
  const { directory, settings, sessions, repo } = await fixture(t), name = 'Übersicht.md';
  await writeFile(join(repo, name), 'composed\n');
  await writeFile(join(repo, name.normalize('NFD')), 'decomposed\n');
  const aliases = (await readdir(repo)).filter(entry => entry.normalize('NFC') === name);
  if (aliases.length < 2) { t.skip('The filesystem resolves both normalization forms to one directory entry'); return; }
  const board = new LocalTaskboard(directory, settings, sessions, () => ({ async reply() { throw Error('should not execute'); } }));
  await board.init(); cleanup(t, () => board.close());
  await assert.rejects(board.create({ title: 'Ambiguous name', instruction: 'Update note', repository: repo, paths: [name] }), /Unicode normalization/);
  assert.equal(await readFile(join(repo, name), 'utf8'), 'composed\n');
  assert.equal(await readFile(join(repo, name.normalize('NFD')), 'utf8'), 'decomposed\n');
});
