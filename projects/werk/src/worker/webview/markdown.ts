import { h, type VNodeChild } from 'vue';
import { Lexer, type MarkedToken, type Token, type Tokens } from 'marked';
import { decodeHTML } from 'entities';

export type CodeRenderer = (text: string, language: string, index: number) => VNodeChild;

/** Only explicit web/email destinations become links; model paths never address worker APIs. */
export function safeMarkdownLink(value: string): string | null {
  const decoded = decodeHTML(value).trim();
  if (/[\u0000-\u0020\u007f-\u009f]/.test(decoded) || !/^(?:https?:\/\/|mailto:)/i.test(decoded)) return null;
  try {
    const url = new URL(decoded);
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

/** Use a private standard lexer. Untrusted HTML remains text; no generated HTML is interpreted. */
export function markdownTokens(text: string): Token[] {
  if (text.length > 32768) return [{ type: 'html', raw: text, text, block: true }];
  try { return new Lexer({ gfm: true, breaks: false }).lex(text); }
  catch { return [{ type: 'html', raw: text, text, block: true }]; }
}

export function markdownNodes(tokens: Token[], code?: CodeRenderer): VNodeChild[] {
  let codeIndex = 0;
  const children = (items: Token[], depth = 0): VNodeChild[] => items.map(original => {
    const token = original as MarkedToken;
    // Bound indentation as well as recursion so deeply nested replies stay readable on mobile.
    if (depth > 8) return token.raw;
    const inline = (items: Token[]) => children(items, depth + 1);
    switch (token.type) {
      case 'space': case 'def': return null;
      case 'text': return token.tokens ? inline(token.tokens) : decodeHTML(token.text);
      case 'escape': return token.text;
      case 'paragraph': return h('p', inline(token.tokens));
      case 'heading': return h(`h${Math.min(6, Math.max(3, token.depth + 2))}`, inline(token.tokens));
      case 'strong': return h('strong', inline(token.tokens));
      case 'em': return h('em', inline(token.tokens));
      case 'del': return h('del', inline(token.tokens));
      case 'codespan': return h('code', token.text);
      case 'br': return h('br');
      case 'hr': return h('hr');
      case 'blockquote': return h('blockquote', inline(token.tokens));
      case 'list': return h(token.ordered ? 'ol' : 'ul', token.ordered && typeof token.start === 'number' ? { start: token.start } : {}, token.items.map(item => h('li', { class: { 'markdown-task-item': item.task } }, inline(item.tokens))));
      case 'list_item': return h('li', inline(token.tokens));
      case 'checkbox': return h('span', { class: 'markdown-task-marker', role: 'img', 'aria-label': token.checked ? 'Completed checklist item' : 'Incomplete checklist item' }, token.checked ? '✓' : '○');
      case 'code': {
        const language = (token.lang ?? '').split(/\s+/)[0].slice(0, 40);
        const index = codeIndex++;
        return code ? code(token.text, language, index) : h('pre', { tabindex: 0, role: 'region', 'aria-label': language ? `Code block · ${language}` : 'Code block' }, h('code', token.text));
      }
      case 'link': case 'image': {
        const href = safeMarkdownLink(token.href);
        const content = token.type === 'image' ? [`Image: ${decodeHTML(token.text || 'View image')}`] : inline(token.tokens);
        return href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer', ...(token.title ? { title: decodeHTML(token.title) } : {}) }, content) : h('span', content);
      }
      case 'table': {
        const cell = (item: Tokens.TableCell, header: boolean) => h(header ? 'th' : 'td', { ...(header ? { scope: 'col' } : {}), ...(item.align ? { style: { textAlign: item.align } } : {}) }, inline(item.tokens));
        return h('div', { class: 'markdown-table-scroll', tabindex: 0, role: 'region', 'aria-label': 'Response table' }, h('table', [h('thead', h('tr', token.header.map(item => cell(item, true)))), h('tbody', token.rows.map(row => h('tr', row.map(item => cell(item, false)))))]));
      }
      case 'html': return token.block ? h('p', { class: 'markdown-literal' }, token.text) : token.text;
      default: return (original as Token).raw;
    }
  });
  return children(tokens);
}
