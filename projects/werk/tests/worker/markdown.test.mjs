import test from 'node:test';
import assert from 'node:assert/strict';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { frontend } from '../ui/helpers/frontend-loader.mjs';
const { markdownTokens, markdownNodes, safeMarkdownLink } = await frontend('src/worker/webview/markdown.ts');
const render = text => renderToString(createSSRApp({ render: () => h('div', markdownNodes(markdownTokens(text))) }));

test('Markdown replies render semantic headings, nested lists, emphasis, quotations and readable entities', async () => {
  const html = await render('# Release ready\n\n**Bold** and _emphasis_ with ~~old~~ and `literal &amp;`. A &amp; B.\n\n3. Review\n   - Nested item\n4. Release\n\n> Saved evidence\n\n- [x] Completed\n- [ ] Waiting');
  assert.match(html, /<h3>Release ready<\/h3>/);
  assert.match(html, /<strong>Bold<\/strong> and <em>emphasis<\/em> with <del>old<\/del>/);
  assert.match(html, /<code>literal &amp;amp;<\/code>/);
  assert.match(html, /A &amp; B\./);
  assert.match(html, /<ol start="3">[\s\S]*<ul><li(?:\s[^>]*)?>/);
  assert.match(html, /<blockquote><p>Saved evidence<\/p><\/blockquote>/);
  assert.match(html, /aria-label="Completed checklist item"/); assert.match(html, /aria-label="Incomplete checklist item"/);
  assert.doesNotMatch(html, /<h1|<h2/);
});
test('tables retain semantic headers, alignment and a keyboard-accessible scrolling region', async () => {
  const html = await render('| Check | Result |\n| :--- | ---: |\n| **CI** | Passed |');
  assert.match(html, /class="markdown-table-scroll" tabindex="0" role="region" aria-label="Response table"/);
  assert.match(html, /<table><thead><tr><th scope="col" style="text-align:left;">Check<\/th>/);
  assert.match(html, /<th scope="col" style="text-align:right;">Result<\/th>/);
  assert.match(html, /<tbody><tr><td style="text-align:left;"><strong>CI<\/strong>/);
});
test('links decode entities before allowlisting and reject active, local and obfuscated destinations', async () => {
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java&#x73;cript:alert(1)', 'java\tscript:alert(1)', 'javascript&colon;alert(1)', 'data:text/html,x', 'vbscript:msgbox(1)', 'file:///etc/passwd', '//host/path', '/api/access', '#local', 'https://name:password@example.com', 'https://exam\nple.com']) assert.equal(safeMarkdownLink(url), null, url);
  assert.equal(safeMarkdownLink('HTTPS://example.com?q=one&amp;v=two'), 'https://example.com/?q=one&v=two');
  const html = await render('[Documentation](https://example.com/docs "Read docs") and [email](mailto:team@example.com) and [unsafe](java&#x73;cript:alert(1)).');
  assert.match(html, /href="https:\/\/example.com\/docs" target="_blank" rel="noopener noreferrer" title="Read docs"/);
  assert.match(html, /href="mailto:team@example.com"/);
  assert.doesNotMatch(html, /href="(?:javascript|java&|data|file):/i);
});
test('raw HTML and image syntax never create executable elements or automatic image requests', async () => {
  const html = await render('<img src=x onerror="globalThis.unsafe=1">\n\n<script>alert(1)</script>\n\n<svg onload="alert(1)"></svg>\n\n![Diagram](https://example.com/image.png)\n\n&lt;iframe&gt;');
  assert.doesNotMatch(html, /<(?:img|script|svg|iframe|style)\b/);
  assert.match(html, /&lt;img src=x onerror=/);
  assert.match(html, /Image: Diagram/); assert.match(html, /&lt;iframe&gt;/);
  assert.match(html, /href="https:\/\/example.com\/image.png"/);
});
test('fenced, incomplete and indented code retain literal entities and exact renderer copy payloads', async () => {
  const code = 'const sample = "&amp; <b>literal</b>";\n  keepIndent();';
  const received = [];
  const tokens = markdownTokens('```js\n' + code + '\n```\n\n```text\npartial &lt;tag&gt;');
  const html = await renderToString(createSSRApp({ render: () => h('div', markdownNodes(tokens, (text, language, index) => { received.push({ text, language, index }); return h('pre', h('code', text)); })) }));
  assert.deepEqual(received, [{ text: code, language: 'js', index: 0 }, { text: 'partial &lt;tag&gt;', language: 'text', index: 1 }]);
  assert.match(html, /&amp;amp; &lt;b&gt;literal&lt;\/b&gt;/);
  assert.match(await render('    indented &amp;'), /tabindex="0" role="region" aria-label="Code block"/);
});
test('long and deeply nested replies fall back safely without dropping retained text', async () => {
  const long = '# ' + 'x'.repeat(32768);
  const tokens = markdownTokens(long); assert.equal(tokens.length, 1); assert.equal(tokens[0].text, long);
  const html = await render(long); assert.match(html, /class="markdown-literal"/); assert.ok(html.includes('x'.repeat(32768)));
  const deep = '> '.repeat(1500) + '<img src=x onerror=alert(1)>';
  const result = await render(deep); assert.doesNotMatch(result, /<img\b/); assert.ok(result.length > 0);
  assert.ok((result.match(/<blockquote>/g) ?? []).length <= 9);
  const nestedList = await render('- First\n  - Second\n    - Third');
  assert.equal((nestedList.match(/<ul>/g) ?? []).length, 3);
});
