import { readFile, readdir, lstat, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { Marked } from 'marked';
import { escapeHtml } from './render-storymap.mjs';
import { mountDocumentation } from './documentation-client.mjs';

const DOCUMENTATION_DIRECTORIES = ['docs/tutorials', 'docs/how-to', 'docs/reference', 'docs/explanation'];
const DOCUMENTATION_CHAPTERS = ['Start here', 'Set up your workspace', 'Work with requests', 'Operate the system', 'Frontend reference', 'Architecture and contracts'];
const entrypoints = [
  ['start', 'Start here', 'docs/handbook.md', 0],
  ['execution-modes', 'Choose an execution mode', 'docs/explanation/modes.md', 0],
  ['install-worker', 'Install a local worker', 'docs/how-to/project-worker.md', 1],
  ['first-feature', 'Run your first feature request', 'docs/tutorials/worker-feature-lifecycle.md', 1],
  ['system-setup', 'Set up a complete system', 'docs/tutorials/system-from-yaml.md', 1],
  ['docker-setup', 'Start with Docker', 'docs/tutorials/docker-first-task.md', 1],
  ['worker-workspace', 'Use the worker workspace', 'docs/how-to/use-worker-webview.md', 2],
  ['implement-feature', 'Implement and review a feature', 'docs/how-to/implement-feature.md', 2],
  ['team-requests', 'Create requests with your team', 'docs/how-to/team-feature-authoring.md', 2],
  ['shared-intake', 'Connect the shared Git queue', 'docs/how-to/shared-feature-intake.md', 2],
  ['tool-access', 'Manage tools and MCP connections', 'docs/how-to/manage-model-tools.md', 2],
  ['consumption', 'Set capacity and consumption limits', 'docs/how-to/worker-consumption-limits.md', 3],
  ['run-metrics', 'Understand run metrics', 'docs/reference/worker-run-metrics.md', 3],
  ['monitor-worker', 'Monitor and recover a worker', 'docs/how-to/monitor-long-running-worker.md', 3],
  ['backup-upgrade', 'Back up and upgrade', 'docs/how-to/upgrade-backup.md', 3],
  ['access-control', 'Manage access and credentials', 'docs/how-to/manage-access.md', 3],
  ['frontend', 'Frontend architecture and state', 'docs/reference/webview-architecture.md', 4],
  ['storybook', 'Develop components and stories', 'docs/how-to/generate-storybook.md', 4],
  ['development', 'Develop and test from source', 'docs/how-to/development.md', 4],
  ['code-quality', 'Code quality and architecture checks', 'docs/reference/code-quality.md', 4],
  ['mutation-testing', 'Mutation testing and warnings', 'docs/how-to/mutation-testing.md', 4],
  ['architecture', 'System architecture', 'docs/explanation/architecture.md', 5],
  ['api', 'CLI and HTTP API', 'docs/reference/api.md', 5],
  ['configuration', 'Environment and configuration', 'docs/reference/configuration.md', 5],
  ['releases', 'Release contents and qualification', 'docs/reference/releases.md', 5],
];
const slug = path => path === 'docs/index.md' ? 'documentation-index' : path === 'README.md' ? 'project-overview' : path.replace(/^docs\//, '').replace(/\.md$/, '').replaceAll('/', '-');
function headingSlug(text) {
  return text.toLowerCase().replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-');
}
export async function documentationFiles(root) {
  const files = [];
  for (const directory of DOCUMENTATION_DIRECTORIES) {
    try {
      if ((await lstat(resolve(root, directory))).isSymbolicLink()) throw Error(`Documentation input must not be a symlink: ${directory}`);
      for (const name of (await readdir(resolve(root, directory))).sort()) if (name.endsWith('.md')) files.push(`${directory}/${name}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const path of ['docs/handbook.md', 'docs/index.md', 'README.md']) {
    try { await lstat(resolve(root, path)); files.push(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return [...new Set(files)].sort();
}
export async function documentationCatalog(root) {
  const files = await documentationFiles(root);
  const pages = [];
  for (const path of files) {
    const markdown = await readFile(resolve(root, path), 'utf8');
    const preferred = entrypoints.find(entry => entry[2] === path);
    pages.push({ id: preferred?.[0] ?? slug(path), title: preferred?.[1] ?? markdown.match(/^#\s+(.+)$/m)?.[1] ?? path,
      source: path, chapter: DOCUMENTATION_CHAPTERS[preferred?.[3] ?? (path.includes('/how-to/') ? 3 : 5)], markdown });
  }
  const priority = page => { const index = entrypoints.findIndex(entry => entry[0] === page.id); return index < 0 ? 1000 : index; };
  return pages.sort((a, b) => DOCUMENTATION_CHAPTERS.indexOf(a.chapter) - DOCUMENTATION_CHAPTERS.indexOf(b.chapter) || priority(a) - priority(b) || a.title.localeCompare(b.title));
}

/** Resolve maintained Markdown locally; source-only evidence stays pinned to this commit. */
export function documentationLink(href, source, pages, commit) {
  if (/^(?:https?:|mailto:)/i.test(href)) return href;
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//') || href.includes('\\')) throw Error(`Unsupported documentation URL in ${source}: ${href}`);
  if (href.startsWith('#')) return href;
  const [pathname, fragment] = href.split('#');
  let decoded; try { decoded = decodeURIComponent(pathname); } catch { throw Error(`Invalid documentation URL in ${source}: ${href}`); }
  const target = posix.normalize(posix.join(posix.dirname(source), decoded));
  if (target.startsWith('../') || target.startsWith('/')) throw Error(`Documentation link leaves the project: ${source}: ${href}`);
  const page = pages.find(page => page.source === target);
  if (page) return `${page.id}.html${fragment ? `#${fragment}` : ''}`;
  return `https://github.com/Luis85/production-line/blob/${commit}/projects/werk/${target.split('/').map(encodeURIComponent).join('/')}${fragment ? `#${fragment}` : ''}`;
}
export function renderDocumentationMarkdown(page, pages, commit) {
  const headings = [], seen = new Map();
  const markdown = new Marked({ gfm: true, breaks: false, renderer: {
    html({ text }) { return escapeHtml(text); },
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const base = headingSlug(text), count = seen.get(base) ?? 0; seen.set(base, count + 1);
      const id = `${base}${count ? `-${count}` : ''}`;
      if (depth > 1 && depth < 4) headings.push({ id, depth, title: text.replace(/<[^>]*>/g, '') });
      return `<h${depth} id="${escapeHtml(id)}">${text}</h${depth}>\n`;
    },
    link({ href, title, tokens }) {
      const destination = documentationLink(href, page.source, pages, commit);
      return `<a href="${escapeHtml(destination)}"${title ? ` title="${escapeHtml(title)}"` : ''}${/^https?:/.test(destination) ? ' rel="noreferrer"' : ''}>${this.parser.parseInline(tokens)}</a>`;
    },
    image({ href, text }) {
      // Documentation is self-contained and never loads third-party images or trackers.
      return `<a href="${escapeHtml(documentationLink(href, page.source, pages, commit))}">View image: ${escapeHtml(text)}</a>`;
    },
    table(token) { return `<div class="docs-table" role="region" aria-label="Reference table" tabindex="0">${renderTable.call(this, token)}</div>`; },
  } });
  function renderTable(token) {
    const row = (cells, tag) => `<tr>${cells.map(cell => `<${tag}${tag === 'th' ? ' scope="col"' : ''}>${this.parser.parseInline(cell.tokens)}</${tag}>`).join('')}</tr>`;
    return `<table><thead>${row(token.header, 'th')}</thead><tbody>${token.rows.map(cells => row(cells, 'td')).join('')}</tbody></table>`;
  }
  return { html: markdown.parse(page.markdown), headings };
}
function navigation(page, pages) {
  return DOCUMENTATION_CHAPTERS.map(chapter => `<section class="docs-nav-group"><h2>${escapeHtml(chapter)}</h2><ul>${pages.filter(candidate => candidate.chapter === chapter).map(candidate => `<li data-doc-entry data-doc-search="${escapeHtml(`${candidate.title} ${candidate.source} ${candidate.markdown.match(/^#{1,4} .+$/gm)?.join(' ') ?? ''}`.toLowerCase())}"><a href="${candidate.id}.html"${page.id === candidate.id ? ' aria-current="page"' : ''}>${escapeHtml(candidate.title)}</a></li>`).join('')}</ul></section>`).join('');
}
export function renderDocumentationPage(page, pages, identity) {
  const { html, headings } = renderDocumentationMarkdown(page, pages, identity.commit);
  const index = pages.indexOf(page);
  const adjacent = (candidate, label) => candidate ? `<a href="${candidate.id}.html"><span>${label}</span>${escapeHtml(candidate.title)}</a>` : '<span></span>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><link rel="icon" href="data:,"><link rel="stylesheet" href="documentation.css"><title>${escapeHtml(page.title)} · Werk ${escapeHtml(identity.version)}</title><meta name="description" content="${escapeHtml(page.title)} — setup, operation and frontend documentation for Werk."></head><body>
<div class="werk-docs" data-document="${page.id}"><a class="docs-skip" href="#docs-main">Skip to documentation</a><header class="docs-header"><a class="docs-brand" href="start.html">werk<span>Documentation</span></a><nav aria-label="Documentation resources"><a href="../storymap/#components">Component API</a><a href="../?path=/story/documentation-start-here--welcome">Storybook</a><a href="https://github.com/Luis85/production-line/releases/tag/v${escapeHtml(identity.version)}">v${escapeHtml(identity.version)}</a></nav></header>
<div class="docs-layout"><aside class="docs-sidebar"><details class="docs-menu" open><summary>Browse documentation</summary><div class="docs-search"><label for="docs-search">Search documentation</label><input type="search" id="docs-search" placeholder="Setup, tools, metrics…" autocomplete="off"><output id="docs-search-status" aria-live="polite"></output></div><nav aria-label="Documentation chapters">${navigation(page, pages)}</nav></details></aside>
<main id="docs-main" tabindex="-1"><p class="docs-eyebrow">${escapeHtml(page.chapter)}</p>${headings.length ? `<details class="docs-contents"><summary>On this page</summary><nav aria-label="On this page"><ul>${headings.map(heading => `<li><a href="#${escapeHtml(heading.id)}">${heading.title}</a></li>`).join('')}</ul></nav></details>` : ''}<article class="docs-prose">${html}</article><nav class="docs-adjacent" aria-label="Continue reading">${adjacent(pages[index - 1], 'Previous')}${adjacent(pages[index + 1], 'Next')}</nav><footer class="docs-footer"><a href="https://github.com/Luis85/production-line/blob/${identity.commit}/projects/werk/${page.source}">View this page’s source</a><span>Werk ${escapeHtml(identity.version)} · ${escapeHtml(identity.commit.slice(0, 12))}</span><p>Documentation describes the shipped contracts. Interactive examples use isolated fixtures; they do not contact providers or execute software work.</p></footer></main></div></div><script src="documentation-client.js" defer></script></body></html>\n`;
}
export async function generateDocumentation(root, output, identity) {
  const pages = await documentationCatalog(root);
  if (!pages.some(page => page.id === 'start')) throw Error('Documentation requires docs/handbook.md');
  await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
  for (const page of pages) await writeFile(resolve(output, `${page.id}.html`), renderDocumentationPage(page, pages, identity));
  await writeFile(resolve(output, 'index.html'), renderDocumentationPage(pages.find(page => page.id === 'start'), pages, identity));
  await copyFile(resolve(root, 'storybook/documentation.css'), resolve(output, 'documentation.css'));
  // A classic script keeps search and navigation working when the extracted handbook is opened from disk.
  await writeFile(resolve(output, 'documentation-client.js'), `(${mountDocumentation.toString()})(document);\n`);
  const documents = pages.map(({ markdown, ...page }) => ({ ...page, path: `handbook/${page.id}.html` }));
  await writeFile(resolve(output, 'catalog.json'), JSON.stringify({ ...identity, chapters: DOCUMENTATION_CHAPTERS, pages: documents }, null, 2) + '\n');
  return documents;
}
