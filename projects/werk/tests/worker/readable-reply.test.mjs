import test from 'node:test';
import assert from 'node:assert/strict';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { frontend } from '../ui/helpers/frontend-loader.mjs';
import { codeSpan, lineChangeStats, patchReplyMessage, readableMarkdown, readableReply } from '../../src/worker/dist/worker/application/readable-reply.js';
const { markdownTokens, markdownNodes } = await frontend('src/worker/webview/markdown.ts');
const render = text => renderToString(createSSRApp({ render: () => h('div', markdownNodes(markdownTokens(text))) }));

// The reply observed in a live Claude Code CLI file task (shortened file body).
const observed = JSON.stringify({
  summary: 'Changed (only languages.ts): src/frontend/src/app/i18n/languages.ts now exports toLanguage(value: unknown): Language.\n\n[OPEN] The unit spec belongs in src/frontend/tests/unit/app/i18n/languages.spec.ts. angular.json only finds tests under ../tests/unit/**/*.spec.ts, and tsconfig.app.json excludes src/**/*.spec.ts.\n\n[OPEN] Unit tests, build and e2e could not run here.',
  files: [{ path: 'src/frontend/src/app/i18n/languages.ts', content: "export const LANGUAGES = ['de', 'en'] as const;\nexport function toLanguage(value: unknown): Language {\n  return isLanguage(value) ? value : DEFAULT_LANGUAGE;\n}\n" }],
});

test('raw file-task change sets render as a readable summary with globs intact and no file contents', async () => {
  const reply = readableReply(observed);
  assert.equal(reply.kind, 'patch'); assert.equal(reply.raw, observed);
  assert.doesNotMatch(reply.text, /\\n|"files"|export const LANGUAGES|isLanguage\(value\) \?/);
  assert.match(reply.text, /`\.\.\/tests\/unit\/\*\*\/\*\.spec\.ts`/);
  assert.match(reply.text, /`src\/\*\*\/\*\.spec\.ts`/);
  assert.match(reply.text, /\*\*Changed files \(1\)\*\*\n\n- `src\/frontend\/src\/app\/i18n\/languages\.ts` · 4 lines of proposed content/);
  const html = await render(reply.text);
  assert.equal((html.match(/<p>/g) ?? []).length >= 3, true, 'summary paragraphs stay separate');
  assert.match(html, /<code>\.\.\/tests\/unit\/\*\*\/\*\.spec\.ts<\/code>/);
  assert.match(html, /<code>src\/\*\*\/\*\.spec\.ts<\/code>/);
  assert.doesNotMatch(html, /<strong>\/\*\.spec|<em>/);
  assert.match(html, /<strong>Changed files \(1\)<\/strong>/);
});

test('a fenced or truncated legacy change set still renders its summary and file paths', () => {
  assert.equal(readableReply('```json\n' + observed + '\n```').kind, 'patch');
  const truncated = observed.slice(0, observed.indexOf('LANGUAGES') + 4);
  const reply = readableReply(truncated);
  assert.equal(reply.kind, 'patch');
  assert.match(reply.text, /^Changed \(only languages\.ts\): `src\/frontend\/src\/app\/i18n\/languages\.ts` now exports/);
  assert.match(reply.text, /- `src\/frontend\/src\/app\/i18n\/languages\.ts` · proposed change/);
  assert.match(reply.text, /shortened, so the file list may be incomplete/);
});

test('multi-line summaries keep their line breaks, lists, tables and code blocks', async () => {
  const text = readableMarkdown('Changed:\nlanguages.ts\nlanguage.service.ts\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst glob = "src/**/*.ts";\nnext line\n```');
  const html = await render(text);
  assert.match(html, /<p>Changed:<br>languages\.ts<br>language\.service\.ts<\/p>/);
  assert.match(html.replace(/<!--[^>]*-->| class=""/g, ''), /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<table>/);
  assert.match(text, /```ts\nconst glob = "src\/\*\*\/\*\.ts";\nnext line\n```/, 'fenced code is untouched');
});

test('path protection leaves prose, emphasis, links and existing code spans alone', () => {
  assert.equal(readableMarkdown('**Important** and/or _maybe_ on 16/10/2026, see https://example.com/a/b.md and `src/**/*.ts`.'), '**Important** and/or _maybe_ on 16/10/2026, see https://example.com/a/b.md and `src/**/*.ts`.');
  assert.equal(readableMarkdown('Edit **src/app/main.ts**, *.spec.ts and __init__.py.'), 'Edit **`src/app/main.ts`**, `*.spec.ts` and `__init__.py`.');
  assert.equal(codeSpan('a`b'), '``a`b``'); assert.equal(codeSpan('`x'), '`` `x ``');
});

test('protocol checkpoints and other JSON records never show as raw protocol text', async () => {
  const stored = JSON.stringify({ werkInteraction: { schemaVersion: 1, kind: 'question', message: 'Which spec path: src/**/*.spec.ts?', choices: [{ id: 'unit', label: 'tests/unit' }], reason: 'Specs outside tests/unit are not run.' } });
  const question = readableReply(stored);
  assert.equal(question.kind, 'question'); assert.equal(question.raw, stored);
  assert.match(question.text, /^\*\*Question for the operator\*\*\n\nWhich spec path: `src\/\*\*\/\*\.spec\.ts`\?/);
  assert.match(question.text, /- tests\/unit \(`unit`\)/); assert.match(question.text, /\*\*Reason:\*\* Specs outside/);
  assert.match(readableReply(JSON.stringify({ werkInteraction: { kind: 'escalation', message: 'Needs approval.' } })).text, /Decision needed outside/);
  const record = readableReply(JSON.stringify({ execution: { outcome: 'simulated' }, quality: { gate: 'not_evaluated' } }, null, 2));
  assert.equal(record.kind, 'record'); assert.equal(record.raw, undefined);
  assert.match(await render(record.text), /<pre[^>]*><code>\{\n {2}&quot;execution&quot;/);
  for (const plain of ['Plain reply with **bold**.', '{ not json', '[1, 2]', '"string"']) assert.deepEqual(readableReply(plain), { kind: 'text', text: plain });
});

test('line statistics count real line changes and new files', () => {
  assert.deepEqual(lineChangeStats('a\nb\nc\n', 'a\nB\nc\nd\n'), { added: 2, removed: 1 });
  assert.deepEqual(lineChangeStats('', 'one\ntwo'), { added: 2, removed: 0 });
  assert.deepEqual(lineChangeStats('same\n', 'same\n'), { added: 0, removed: 0 });
  assert.match(patchReplyMessage('', [{ path: 'a.txt', added: 0, removed: 0 }, { path: 'b.txt', added: 1, removed: 3 }]), /^No summary was returned\.[\s\S]*- `a\.txt` · no line changes\n- `b\.txt` · 1 line added, 3 removed/);
});
