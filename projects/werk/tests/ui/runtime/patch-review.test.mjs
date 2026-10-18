import test from 'node:test';
import assert from 'node:assert/strict';
import { frontend } from '../helpers/frontend-loader.mjs';
const { parsePatchPreview } = await frontend('src/worker/webview/patch-review.ts');
const patchPreviewLimits = { characters: 512000, files: 80, lines: 2000, lineCharacters: 2000 };
const patch = (name = 'src/example.ts', hunk = '@@ -2,2 +2,3 @@\n context\n-old\n+new\n+next\n') => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n${hunk}`;

test('unified changes retain old/new positions, exact content, counts and per-file boundaries', () => {
  const value = parsePatchPreview(patch() + patch('README.md', '@@ -1 +1 @@\n-before\n+after\n\\ No newline at end of file\n'));
  assert.equal(value.files.length, 2); assert.equal(value.truncated, false); assert.equal(value.unrecognized, false);
  assert.deepEqual(value.files.map(file => [file.path, file.additions, file.deletions, file.malformed]), [['src/example.ts', 2, 1, false], ['README.md', 1, 1, false]]);
  assert.deepEqual(value.files[0].lines.filter(line => ['context', 'removed', 'added'].includes(line.kind)).map(line => [line.kind, line.text, line.oldLine, line.newLine]), [
    ['context', 'context', 2, 2], ['removed', 'old', 3, null], ['added', 'new', null, 3], ['added', 'next', null, 4],
  ]);
  assert.equal(value.files[1].lines.at(-1).text, '\\ No newline at end of file');
});
test('added and deleted files handle zero-count hunk sides without invented line positions', () => {
  const value = parsePatchPreview('diff --git a/new b/new\nnew file mode 100644\n--- /dev/null\n+++ b/new\n@@ -0,0 +1 @@\n+hello\n' +
    'diff --git a/old b/old\ndeleted file mode 100644\n--- a/old\n+++ /dev/null\n@@ -1 +0,0 @@\n-goodbye\n');
  assert.deepEqual(value.files.map(file => [file.path, file.change]), [['new', 'Added'], ['old', 'Deleted']]);
  assert.deepEqual(value.files.map(file => [file.lines.at(-1).oldLine, file.lines.at(-1).newLine]), [[null, 1], [1, null]]);
});
test('plain unified patches and removed text resembling file headers stay in the correct file', () => {
  const value = parsePatchPreview('--- a/one\t2026-01-01\n+++ b/one\t2026-01-01\n@@ -1 +1 @@\n--- header-like content\n+++ replacement content\n--- a/two\n+++ b/two\n@@ -0,0 +1 @@\n+second\n');
  assert.equal(value.files.length, 2); assert.equal(value.files[0].lines[3].text, '-- header-like content');
  assert.equal(value.files[0].lines[4].text, '++ replacement content'); assert.equal(value.files[1].path, 'two');
});
test('Git quoted UTF-8 paths, spaces, escaped quotes and tabs stay exact and inert', () => {
  const quoted = '"a/caf\\303\\251 \\"notes\\"\\t.md"';
  const after = '"b/caf\\303\\251 \\"notes\\"\\t.md"';
  const value = parsePatchPreview(`diff --git ${quoted} ${after}\n--- ${quoted}\n+++ ${after}\n@@ -1 +1 @@\n-old\n+<img src=x onerror=alert(1)>\n`);
  assert.equal(value.files[0].path, 'café "notes"\t.md');
  assert.equal(value.files[0].lines.at(-1).text, '<img src=x onerror=alert(1)>');
  assert.equal(value.files[0].malformed, false);
  assert.equal(parsePatchPreview(patch('folder with spaces/name.md')).files[0].path, 'folder with spaces/name.md');
});
test('rename, copy and binary metadata stay visible without claiming textual changes', () => {
  const value = parsePatchPreview('diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n' +
    'diff --git a/from b/to\ncopy from from\ncopy to to\n' + 'diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n');
  assert.deepEqual(value.files.map(file => [file.path, file.previousPath, file.change, file.additions, file.deletions]), [
    ['new', 'old', 'Renamed', 0, 0], ['to', 'from', 'Copied', 0, 0], ['image.png', null, 'Binary', 0, 0],
  ]);
});
test('malformed hunk sizes, invalid paths and unsupported combined diffs preserve inspectable saved text', () => {
  for (const input of [patch('file', '@@ -0 +1 @@\n-old\n+new\n'), patch('file', '@@ -1,3 +1 @@\n-old\n+new\n'), patch('file', '@@ -99999999999999999 +1 @@\n-old\n+new\n'), 'diff --cc file\n@@@ -1,1 -1,1 +1,1 @@@\n++merged\n', '--- "a/invalid\\q"\n+++ "b/invalid\\q"\n']) {
    const result = parsePatchPreview(input); assert.equal(result.files[0].malformed, true); assert.ok(result.files[0].lines.length);
  }
  const unknown = parsePatchPreview('<script>unexpected text</script>');
  assert.equal(unknown.unrecognized, true); assert.equal(unknown.files[0].lines[0].text, '<script>unexpected text</script>');
  assert.deepEqual(parsePatchPreview(' \n\t').files, []);
});
test('CRLF artifacts preserve content and multiple hunks reset line positions', () => {
  const value = parsePatchPreview(patch('file', '@@ -1 +1 @@\n-old\n+new\n@@ -20,0 +21 @@\n+later\n').replaceAll('\n', '\r\n'));
  assert.equal(value.files[0].malformed, false); assert.equal(value.files[0].lines.at(-1).newLine, 21);
  assert.equal(value.files[0].additions, 2); assert.equal(value.files[0].lines.at(-1).text, 'later');
});
test('oversized artifacts bound files, scanned text, lines and long line output while leaving the source intact', () => {
  const manyFiles = Array.from({ length: 100 }, (_, i) => patch('file-' + i)).join('');
  const files = parsePatchPreview(manyFiles); assert.equal(files.files.length, patchPreviewLimits.files); assert.equal(files.truncated, true);
  const manyLines = patch('large', '@@ -0,0 +1,10000 @@\n' + '+next\n'.repeat(10000));
  const lines = parsePatchPreview(manyLines); assert.equal(lines.truncated, true);
  assert.ok(lines.files.reduce((sum, file) => sum + file.lines.length, 0) <= patchPreviewLimits.lines);
  const long = patch('long', '@@ -0,0 +1 @@\n+' + 'x'.repeat(patchPreviewLimits.characters * 4));
  const originalLength = long.length, result = parsePatchPreview(long);
  assert.equal(long.length, originalLength); assert.equal(result.truncated, true);
  assert.ok(result.files.every(file => file.lines.every(line => line.text.length <= patchPreviewLimits.lineCharacters)));
  assert.ok(result.files[0].lines.at(-1).shortened); assert.equal(result.files[0].additions, 0, 'an incomplete scanned line does not claim a parsed change');
});

test('surplus hunk lines and incomplete file headers remain visibly malformed', () => {
  const extra = parsePatchPreview(patch('file', '@@ -1 +1 @@\n-old\n+new\n+extra\n'));
  assert.equal(extra.files[0].malformed, true); assert.equal(extra.files[0].additions, 1);
  assert.equal(extra.files[0].lines.at(-1).kind, 'meta'); assert.equal(extra.files[0].lines.at(-1).newLine, null);
  const missing = parsePatchPreview('diff --git a/one b/one\n--- a/one\n' + patch('two'));
  assert.equal(missing.files[0].malformed, true); assert.equal(missing.files[1].malformed, false);
});
test('mail preamble metadata does not invent a changed file before the first diff', () => {
  const result = parsePatchPreview('From abc123 Mon Sep 17 00:00:00 2001\nSubject: [PATCH] Example\n\n' + patch());
  assert.equal(result.files.length, 1); assert.equal(result.files[0].path, 'src/example.ts');
  assert.equal(result.files[0].lines[0].text, 'From abc123 Mon Sep 17 00:00:00 2001');
  assert.equal(result.files[0].malformed, false);
});
