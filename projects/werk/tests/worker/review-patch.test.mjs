import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { reviewFilePatch } from '../../src/worker/dist/worker/application/review-patch.js';
import { PATCH_REPLY_LIMITS, PatchProtocolError, parsePatchReply, patchProtocolInstruction, validatePatchReply } from '../../src/worker/dist/worker/application/patch-protocol.js';

const run = promisify(execFile);
const lines = (count, label = 'line') => Array.from({ length: count }, (_, index) => `${label} ${index + 1}\n`).join('');

async function gitApply(t, files, patch) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-review-patch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => run('git', ['-c', 'core.autocrlf=false', '-c', 'core.quotePath=true', ...args], { cwd: directory, windowsHide: true });
  await git('init', '-q');
  for (const file of files.filter(item => item.existed)) {
    await mkdir(dirname(join(directory, file.path)), { recursive: true });
    await writeFile(join(directory, file.path), file.content);
  }
  const child = execFile('git', ['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', '-'], { cwd: directory, windowsHide: true });
  const exit = new Promise((resolve, reject) => child.on('close', code => code === 0 ? resolve() : reject(Error(`git apply exited ${code}`))));
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(patch);
  await exit.catch(error => { throw Error(`${error.message}: ${stderr}\n${patch}`); });
  return path => readFile(join(directory, path), 'utf8');
}

async function assertApplies(t, file, content) {
  const patch = reviewFilePatch(file, content);
  const read = await gitApply(t, [file], patch);
  assert.equal(await read(file.path), content);
  return patch;
}

test('a small addition to a long file produces one hunk with three context lines', async t => {
  const before = lines(120);
  const added = Array.from({ length: 7 }, (_, index) => `added ${index + 1}\n`).join('');
  const after = before.replace('line 60\n', 'line 60\n' + added);
  const patch = await assertApplies(t, { path: 'notes/plan.md', content: before, existed: true }, after);
  assert.equal(patch.match(/^@@/gm).length, 1);
  assert.match(patch, /^@@ -58,6 \+58,13 @@$/m);
  assert.equal(patch.match(/^-(?!--)/gm), null);
  assert.equal(patch.match(/^\+(?!\+\+)/gm).length, 7);
  assert.equal(patch.match(/^ /gm).length, 6);
  assert.ok(patch.length < 400, 'The review diff must not repeat the whole file.');
});

test('distant edits become separate hunks and nearby edits merge like git', async t => {
  const before = lines(80);
  const distant = before.replace('line 5\n', 'line five\n').replace('line 70\n', 'line seventy\n');
  const distantPatch = await assertApplies(t, { path: 'a.txt', content: before, existed: true }, distant);
  assert.deepEqual(distantPatch.match(/^@@.*@@$/gm), ['@@ -2,7 +2,7 @@', '@@ -67,7 +67,7 @@']);
  const nearby = before.replace('line 10\n', 'line ten\n').replace('line 16\n', 'line sixteen\n');
  const nearbyPatch = await assertApplies(t, { path: 'a.txt', content: before, existed: true }, nearby);
  assert.deepEqual(nearbyPatch.match(/^@@.*@@$/gm), ['@@ -7,13 +7,13 @@']);
});

test('new, emptied, deleted-line and edge-of-file changes apply exactly', async t => {
  await assertApplies(t, { path: 'new.txt', content: '', existed: false }, 'one\ntwo\n');
  await assertApplies(t, { path: 'empty.txt', content: '', existed: false }, '');
  await assertApplies(t, { path: 'clear.txt', content: 'one\ntwo\n', existed: true }, '');
  await assertApplies(t, { path: 'fill.txt', content: '', existed: true }, 'filled\n');
  await assertApplies(t, { path: 'first.txt', content: lines(10), existed: true }, 'line 0\n' + lines(10));
  await assertApplies(t, { path: 'last.txt', content: lines(10), existed: true }, lines(9));
  await assertApplies(t, { path: 'reorder.txt', content: 'a\nb\nc\nd\ne\n', existed: true }, 'e\nb\nd\nc\na\n');
  assert.match(reviewFilePatch({ path: 'new.txt', content: '', existed: false }, 'x\n'), /^new file mode 100644\n--- \/dev\/null\n\+\+\+ "b\/new\.txt"\n@@ -0,0 \+1 @@\n\+x\n$/m);
});

test('missing final newlines and CRLF line endings are preserved', async t => {
  const addNewline = await assertApplies(t, { path: 'eof.txt', content: 'a\nb', existed: true }, 'a\nb\n');
  assert.match(addNewline, /-b\n\\ No newline at end of file\n\+b\n/);
  const removeNewline = await assertApplies(t, { path: 'eof.txt', content: 'a\nb\n', existed: true }, 'a\nb');
  assert.match(removeNewline, /-b\n\+b\n\\ No newline at end of file\n/);
  const context = await assertApplies(t, { path: 'eof.txt', content: lines(6) + 'tail', existed: true }, lines(6).replace('line 5', 'line V') + 'tail');
  assert.match(context, / tail\n\\ No newline at end of file\n$/);
  await assertApplies(t, { path: 'crlf.txt', content: 'one\r\ntwo\r\nthree\r\n', existed: true }, 'one\r\n2\r\nthree\r\n');
});

test('non-ASCII and spaced paths stay quoted and apply', async t => {
  const file = { path: 'Projekte/Übersicht März.md', content: 'alt\n', existed: true };
  const patch = await assertApplies(t, file, 'neu\n');
  assert.match(patch, /^diff --git "a\/Projekte\/Übersicht März\.md" "b\/Projekte\/Übersicht März\.md"$/m);
  assert.equal(reviewFilePatch(file, 'alt\n'), '');
});

test('a full rewrite of a large file stays bounded and applies', async t => {
  const before = lines(3000, 'old'), after = lines(3000, 'new');
  const started = Date.now();
  await assertApplies(t, { path: 'big.txt', content: before, existed: true }, after);
  assert.ok(Date.now() - started < 15000);
});

test('randomized edits always apply to the original snapshot', async t => {
  let seed = 7; const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const base = lines(40).split('\n').slice(0, -1);
  for (let round = 0; round < 25; round++) {
    const next = [...base];
    for (let edit = 0; edit < 1 + Math.floor(random() * 6); edit++) {
      const at = Math.floor(random() * next.length), kind = random();
      if (kind < 0.33) next.splice(at, 1); else if (kind < 0.66) next.splice(at, 0, `inserted ${round}-${edit}`); else next[at] = `changed ${round}-${edit}`;
    }
    const ending = random() < 0.2 ? '' : '\n';
    await assertApplies(t, { path: `random-${round}.txt`, content: base.join('\n') + '\n', existed: true }, next.join('\n') + ending);
  }
});

const approved = [{ path: 'src/app.ts', content: 'export const a = 1;\n', existed: true }, { path: 'docs/neu.md', content: '', existed: false }];
const reply = value => JSON.stringify(value);
const valid = { summary: 'Raised a; tests not run.', files: [{ path: 'src/app.ts', content: 'export const a = 2;\n' }] };
const code = (fn, expected, message) => assert.throws(fn, error => error instanceof PatchProtocolError && error.code === expected && (!message || message.test(error.message)));

test('patch replies are read from bare, fenced and prose-wrapped objects', () => {
  for (const text of [reply(valid), '```json\n' + reply(valid) + '\n```', '```\n' + reply(valid) + '\n```', 'Here is the change:\n\n```json\n' + JSON.stringify(valid, null, 2) + '\n```\nLet me know if it {works}.', `I updated the file. ${reply(valid)} Done.`])
    assert.equal(validatePatchReply(approved, text).changedFileCount, 1);
  assert.deepEqual(parsePatchReply(`Same twice: ${reply(valid)} and ${reply(valid)}`), valid);
  const braces = { summary: 'Uses "{" and "}" in strings', files: [{ path: 'src/app.ts', content: 'const x = { a: "}" };\n' }] };
  assert.deepEqual(parsePatchReply(`Note {not json}: ${reply(braces)}`), braces);
});

test('each patch protocol violation has a specific code and a content-free message', () => {
  code(() => validatePatchReply(approved, 'x'.repeat(PATCH_REPLY_LIMITS.replyChars + 1)), 'patch_reply_too_large', /64000/);
  code(() => validatePatchReply(approved, 'I could not finish the change.'), 'patch_reply_not_json');
  code(() => validatePatchReply(approved, `${reply(valid)}\n${reply({ ...valid, summary: 'Other' })}`), 'patch_reply_ambiguous', /2 different/);
  code(() => validatePatchReply(approved, reply({ ...valid, summary: 's'.repeat(2001) })), 'patch_summary_invalid', /2001 characters; the limit is 2000/);
  code(() => validatePatchReply(approved, reply({ summary: 'x', files: [] })), 'patch_files_invalid');
  code(() => validatePatchReply(approved, reply({ summary: 'x', files: [valid.files[0], valid.files[0], valid.files[0]] })), 'patch_files_invalid', /lists 3 files; this task approves 2/);
  code(() => validatePatchReply(approved, reply({ summary: 'x', files: [{ path: '../outside\u0007', content: 'secret body' }] })), 'patch_file_unapproved', /"\.\.\/outside\?", which is not an approved path/);
  code(() => validatePatchReply(approved, reply({ summary: 'x', files: [valid.files[0], valid.files[0]] })), 'patch_file_duplicate');
  code(() => validatePatchReply(approved, reply({ summary: 'x', files: [{ path: 'src/app.ts', content: 7 }] })), 'patch_file_content_invalid');
  code(() => validatePatchReply(approved, reply({ summary: 'x', files: [{ path: 'src/app.ts', content: 'a\0b' }] })), 'patch_file_content_invalid', /NUL/);
  code(() => validatePatchReply(approved, reply({ summary: 'x', files: [{ path: 'src/app.ts', content: approved[0].content }] })), 'patch_unchanged');
  code(() => validatePatchReply(approved, reply({ summary: 'x', files: [{ path: 'src/app.ts', content: 'token ghp_' + 'a'.repeat(30) + '\n' }] })), 'patch_sensitive_material');
  try { validatePatchReply(approved, reply({ summary: 'x', files: [{ path: 'nope', content: 'very private text' }] })); }
  catch (error) { assert.doesNotMatch(error.message, /very private text/); }
});

test('the prompt states the enforced limits', () => {
  const text = patchProtocolInstruction(3);
  for (const fragment of ['ONLY one JSON object', 'at most 2000 characters', '1-3 changed approved paths', 'at most 64000 characters', 'whole reply is at most 64000']) assert.ok(text.includes(fragment), fragment);
});

// A bounded parser must not silently ignore a second patch after its search limit.
test('patch extraction refuses an unexamined tail after the candidate bound', () => {
  code(() => parsePatchReply(reply(valid) + '{not json}'.repeat(255) + reply({ ...valid, summary: 'Different' })), 'patch_reply_ambiguous', /bounded patch-object search/);
});

test('unchanged entries are omitted from the patch and changed-file count', () => {
  const snapshots = [...approved, { path: 'unchanged.txt', content: 'same\n', existed: true }];
  const result = validatePatchReply(snapshots, reply({ ...valid, files: [...valid.files, { path: 'unchanged.txt', content: 'same\n' }] }));
  assert.equal(result.changedFileCount, 1);
  assert.doesNotMatch(result.patch, /unchanged/);
});

test('Unicode model paths match canonical approval and cannot duplicate it in another form', () => {
  const path = 'docs/Übersicht.md', decomposed = path.normalize('NFD');
  const snapshots = [{ path, content: 'before\n', existed: true }, { path: 'other.md', content: '', existed: false }];
  const changed = { path: decomposed, content: 'after\n' };
  const result = validatePatchReply(snapshots, reply({ summary: 'Updated', files: [changed] }));
  assert.ok(result.patch.includes(path));
  assert.ok(!result.patch.includes(decomposed));
  code(() => validatePatchReply(snapshots, reply({ summary: 'Duplicate', files: [changed, { ...changed, path }] })), 'patch_file_duplicate');
});
