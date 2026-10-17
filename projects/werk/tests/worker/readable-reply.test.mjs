import test from 'node:test';
import assert from 'node:assert/strict';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { frontend } from '../ui/helpers/frontend-loader.mjs';
import { codeSpan, lineChangeStats, patchReplyMessage, readableMarkdown, readableReply } from '../../src/worker/dist/worker/application/readable-reply.js';
const proposal = { fileTask: 'proposal' };
const { markdownTokens, markdownNodes } = await frontend('src/worker/webview/markdown.ts');
const render = text => renderToString(createSSRApp({ render: () => h('div', markdownNodes(markdownTokens(text))) }));

// The reply observed in a live Claude Code CLI file task (shortened file body).
const observed = JSON.stringify({
  summary: 'Changed (only languages.ts): src/frontend/src/app/i18n/languages.ts now exports toLanguage(value: unknown): Language.\n\n[OPEN] The unit spec belongs in src/frontend/tests/unit/app/i18n/languages.spec.ts. angular.json only finds tests under ../tests/unit/**/*.spec.ts, and tsconfig.app.json excludes src/**/*.spec.ts.\n\n[OPEN] Unit tests, build and e2e could not run here.',
  files: [{ path: 'src/frontend/src/app/i18n/languages.ts', content: "export const LANGUAGES = ['de', 'en'] as const;\nexport function toLanguage(value: unknown): Language {\n  return isLanguage(value) ? value : DEFAULT_LANGUAGE;\n}\n" }],
});

test('raw file-task change sets render as a readable summary with globs intact and no file contents', async () => {
  const reply = readableReply(observed, proposal);
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
  assert.equal(readableReply('```json\n' + observed + '\n```', proposal).kind, 'patch');
  const truncated = observed.slice(0, observed.indexOf('LANGUAGES') + 4);
  const reply = readableReply(truncated, proposal);
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
  const question = readableReply(stored, proposal);
  assert.equal(question.kind, 'question'); assert.equal(question.raw, stored);
  assert.match(question.text, /^\*\*Question for the operator\*\*\n\nWhich spec path: `src\/\*\*\/\*\.spec\.ts`\?/);
  assert.match(question.text, /- tests\/unit \(`unit`\)/); assert.match(question.text, /\*\*Reason:\*\* Specs outside/);
  assert.match(readableReply(JSON.stringify({ werkInteraction: { schemaVersion: 1, kind: 'escalation', message: 'Needs approval.' } }), proposal).text, /Decision needed outside/);
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


test('ordinary JSON examples and implementation replies never acquire proposal or checkpoint claims', () => {
  for (const text of [observed, '\x60\x60\x60json\n' + observed + '\n\x60\x60\x60', JSON.stringify({ summary: 'Example only', files: [] }), JSON.stringify({ werkInteraction: { schemaVersion: 1, kind: 'question', message: 'Example only' } })]) {
    for (const context of [{}, { fileTask: undefined }]) {
      const reply = readableReply(text, context);
      assert.equal(reply.kind, 'record'); assert.equal(reply.raw, undefined);
      assert.doesNotMatch(reply.text, /patch is saved|Changed files|Question for the operator/);
    }
  }
  assert.equal(readableReply(observed, { fileTask: 'implementation' }).kind, 'record');
  for (const value of [{ werkInteraction: { schemaVersion: 99, kind: 'question', message: 'Example' } }, { werkInteraction: { schemaVersion: 1, kind: 'approval', message: 'Example' } }, { summary: 'Example', files: [{ path: 'a.txt' }] }, { summary: 'Empty', files: [] }]) assert.equal(readableReply(JSON.stringify(value), proposal).kind, 'record');
  const legacy = readableReply(observed, proposal);
  assert.match(legacy.text, /proposed changes come from a saved reply/);
  assert.doesNotMatch(legacy.text, /full patch is saved/);
});

test('authored Markdown destinations and literal code remain unchanged while prose globs become readable', async () => {
  const authored = [
    '[guide](docs/guide.md) and ![diagram](../assets/**/*.svg)',
    '[glob](https://example.com/docs/**/*.md "Docs")',
    '[reference]: ../docs/guide.md',
    '\x60src/**/*.ts\x60 and \x60\x60a\x60b src/**/*.ts\x60\x60',
    '**Keep \x60src/**/*.ts\x60 literal** and _emphasis_',
    '    const glob = "src/**/*.ts";\n    const path = "../docs/file.md";',
    '\x60\x60\x60ts\nconst glob = "src/**/*.ts";\n\x60\x60\x60not-a-closing-fence\nsrc/**/*.ts\n\x60\x60\x60',
  ];
  for (const text of authored) assert.equal(readableMarkdown(text), text);
  const html = await render(readableMarkdown('[guide](docs/guide.md) and ![diagram](../assets/**/*.svg)'));
  assert.match(html, /<span>guide<\/span>/); assert.match(html, /Image: diagram/);
  assert.doesNotMatch(html, /href=|<img/);
  assert.match(await render(readableMarkdown('src/**/*.ts and tests/**/*.spec.ts')), /<code>src\/\*\*\/\*\.ts<\/code> and <code>tests\/\*\*\/\*\.spec\.ts<\/code>/);
});

test('formatted protocol summaries keep HTML and unsafe links inert', async () => {
  const malicious = JSON.stringify({ summary: '<script>alert(1)</script>\n\n[unsafe](java&#x73;cript:alert(1))\n\n![pixel](https://example.com/pixel)', files: [{ path: 'a\x60 <img src=x onerror=alert(1)>.ts', content: '<script>private()</script>' }] });
  const reply = readableReply(malicious, proposal), html = await render(reply.text);
  assert.doesNotMatch(html, /<(?:script|img|svg|iframe)\b|href="(?:javascript|data):/i);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(reply.text, /private\(\)/);
  const record = readableReply(JSON.stringify({ example: '\x60\x60\x60\n<script>alert(1)</script>' }));
  assert.doesNotMatch(await render(record.text), /<script\b/i);
});

test('large bounded line statistics disclose that counts are approximate', () => {
  const middle = Array(2000).fill('same').join('\n');
  const stats = lineChangeStats('old start\n' + middle + '\nold end', 'new start\n' + middle + '\nnew end');
  assert.equal(stats.approximate, true);
  assert.match(patchReplyMessage('Large proposal', [{ path: 'large.txt', ...stats }]), /approximately 2002 lines added, 2002 removed/);
});


test('ordinary and implementation prose render literal globs without changing stored protocol text', async () => {
  const source = 'Review src/**/*.spec.ts and tests/**/*.ts.\nKeep [the guide](docs/guide.md) and \x60\x60a\x60b src/**/*.ts\x60\x60 literal.';
  for (const context of [{}, { fileTask: 'implementation' }]) {
    const reply = readableReply(source, context);
    assert.equal(reply.kind, 'text'); assert.equal(reply.raw, undefined);
    assert.equal(readableReply(reply.text, context).text, reply.text, 'Already formatted saved prose must not gain repeated escaping or line breaks.');
    const html = await render(reply.text);
    assert.match(html, /<code>src\/\*\*\/\*\.spec\.ts<\/code>/);
    assert.match(html, /<code>tests\/\*\*\/\*\.ts<\/code>/);
    assert.match(html, /<span>the guide<\/span>/);
    assert.match(html, /<code>a\x60b src\/\*\*\/\*\.ts<\/code>/);
    assert.doesNotMatch(html, /Changed files|patch is saved/);
  }
});

test('nested quoted and list code blocks retain their authored Markdown exactly', () => {
  const authored = [
    '> ```ts\n> const glob = "src/**/*.ts";\n> nextLine();\n> ```',
    '> Outer quote\n>\n> > ~~~text\n> > src/**/*.ts\n> > ../docs/**/*.md\n> > ~~~',
    '- Example\n  ```ts\n  const glob = "src/**/*.ts";\n  nextLine();\n  ```\n- Done',
    '1. Example\n   > ```ts\n   > src/**/*.ts\n   > nextLine();\n   > ```',
    '- Example\n\n      const glob = "src/**/*.ts";\n      nextLine();\n',
    '> ```ts\n> src/**/*.ts\n> unfinished();',
  ];
  for (const text of authored) assert.equal(readableMarkdown(text), text);
});

test('multiline code spans preserve literal newlines while adjacent prose keeps readable breaks', async () => {
  const literal = '\x60\x60first\n\x60src/**/*.ts\nlast\x60\x60';
  const source = 'Before ' + literal + ' after.\nNext tests/**/*.ts.\n[guide](docs/guide.md)\nFinal line.';
  const formatted = 'Before ' + literal + ' after.  \nNext `tests/**/*.ts`.  \n[guide](docs/guide.md)  \nFinal line.';
  assert.equal(readableMarkdown(source), formatted);
  assert.equal(readableMarkdown(formatted), formatted, 'Formatting must be idempotent across token boundaries.');
  const html = await render(formatted);
  assert.match(html, /<code>first \x60src\/\*\*\/\*\.ts last<\/code>/);
  assert.match(html, /after\.<br>Next <code>tests\/\*\*\/\*\.ts<\/code>\.<br><span>guide<\/span><br>Final line\./);
});

test('reference links and their definitions resolve together without changing authored labels or destinations', async () => {
  const authored = [
    'Read [src/**/*.ts][guide].\n\n[guide]: ../docs/**/*.md "Docs"\n',
    '[src/**/*.ts][]\n\n[src/**/*.ts]: ../docs/**/*.md\n',
    'Use [src/**/*.ts].\n\n[src/**/*.ts]: ../docs/**/*.md\n',
    '![src/**/*.svg][diagram]\n\n[diagram]: ../assets/**/*.svg\n',
    '[guide]:\n  <../docs/**/*.md>\n  "Reference title"\n\n[the guide][guide]\n',
  ];
  for (const text of authored) assert.equal(readableMarkdown(text), text);
  const source = 'Read [src/**/*.ts][guide] and tests/**/*.ts.\n\n[guide]: https://example.com/docs/**/*.md "Docs"\n';
  const formatted = 'Read [src/**/*.ts][guide] and `tests/**/*.ts`.\n\n[guide]: https://example.com/docs/**/*.md "Docs"\n';
  assert.equal(readableMarkdown(source), formatted);
  assert.match(await render(formatted), /href="https:\/\/example.com\/docs\/\*\*\/\*\.md"[^>]*title="Docs">src\/\*\*\/\*\.ts<\/a>/);
});

test('heading syntax and authored hard breaks survive prose glob repair across emphasis tokens', () => {
  const source = '  ## Review src/**/*.ts and tests/**/*.spec.ts  ##\n\nFirst src/**/*.ts  \nSecond tests/**/*.ts\\\nThird src/**/*.tsx\nFourth line.\n';
  const formatted = '  ## Review `src/**/*.ts` and `tests/**/*.spec.ts`  ##\n\nFirst `src/**/*.ts`  \nSecond `tests/**/*.ts`\\\nThird `src/**/*.tsx`  \nFourth line.\n';
  assert.equal(readableMarkdown(source), formatted);
  assert.equal(readableMarkdown(formatted), formatted);
  assert.equal(readableMarkdown('Title src/**/*.ts\n===\n'), 'Title `src/**/*.ts`\n===\n');
});


test('long assistant replies retain the renderer’s bounded literal fallback', async () => {
  const source = ('Review src/**/*.ts and **literal** <script>example()</script>\r\n').repeat(700);
  assert.ok(source.length > 32768);
  assert.equal(readableMarkdown(source), source, 'Oversized text is returned unchanged before Markdown preprocessing.');
  for (const context of [{}, { fileTask: 'implementation' }]) {
    const reply = readableReply(source, context);
    assert.deepEqual(reply, { kind: 'text', text: source });
    const html = await render(reply.text);
    assert.match(html, /class="markdown-literal"/);
    assert.match(html, /&lt;script&gt;example\(\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<(?:code|strong|script)\b/);
  }
});

test('prose-wrapped legacy proposal formatting requires retained proposal context', () => {
  const text = 'Here is the patch:\n' + observed + '\nReady for inspection.';
  const formatted = readableReply(text, { fileTask: 'proposal' });
  assert.equal(formatted.kind, 'patch');
  assert.equal(formatted.raw, text);
  assert.match(formatted.text, /Changed files/);
  assert.doesNotMatch(formatted.text, /export const LANGUAGES/);
  assert.equal(readableReply(text).kind, 'text');
  assert.equal(readableReply(text, { fileTask: 'implementation' }).kind, 'text');
});
