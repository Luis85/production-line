import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Every maintained page is checked, not just documentation entrypoint stories. */
export async function verifyDocumentation(browser, origin, inventory, staticRoot, viewports) {
  const documents = inventory.documents ?? [];
  if (!documents.length) throw Error('No documentation pages were indexed');
  const index = JSON.parse(await readFile(resolve(staticRoot, 'index.json'), 'utf8'));
  const results = [], destinations = new Map(), links = [];
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, serviceWorkers: 'block' });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      errors.push(`Unexpected documentation request: ${url.href}`); return route.abort();
    });
    try {
      for (const document of documents) {
        await page.goto(`${origin}/${document.path}`, { waitUntil: 'load' });
        const evidence = await page.evaluate(() => ({
          id: document.querySelector('.werk-docs')?.getAttribute('data-document'),
          headings: document.querySelectorAll('main h1').length,
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          ids: [...document.querySelectorAll('[id]')].map(element => element.id),
          links: [...document.querySelectorAll('a[href]')].map(link => link.href),
          current: document.querySelector('nav[aria-label="Documentation chapters"] [aria-current="page"]')?.getAttribute('href'),
        }));
        if (evidence.id !== document.id || evidence.headings !== 1 || !evidence.current) throw Error(`Incomplete documentation page: ${document.path}`);
        if (evidence.overflow) throw Error(`Documentation overflows ${viewport.name}: ${document.path}`);
        if (viewport.name === 'desktop') { destinations.set(`/${document.path}`, new Set(evidence.ids)); links.push(...evidence.links.map(href => ({ href, from: document.path }))); }
      }
      await page.goto(`${origin}/handbook/start.html`);
      const menu = page.locator('.docs-menu');
      if (viewport.width < 960) await menu.locator('summary').click();
      await page.locator('#docs-search').fill('MCP');
      if (!await page.locator('[data-doc-entry]:not([hidden])').count()) throw Error('Documentation topic search returned no MCP pages');
      await page.locator('#docs-search').fill('__no_matching_documentation__');
      if (await page.locator('[data-doc-entry]:not([hidden])').count()) throw Error('Documentation empty search retained pages');
      if (!await page.locator('#docs-search-status').innerText().then(text => text.includes('0 matching'))) throw Error('Documentation search does not announce empty results');
      await page.locator('#docs-search').fill('');
      if (await page.locator('[data-doc-entry]:not([hidden])').count() !== documents.length) throw Error('Documentation search did not restore all pages');
      await page.locator('.docs-skip').focus(); await page.keyboard.press('Enter');
      if (!await page.locator('#docs-main').evaluate(element => element === document.activeElement)) throw Error('Documentation skip link did not focus main content');
      if (errors.length) throw Error(errors.join('\n'));
      results.push({ viewport: viewport.name, passed: true, pages: documents.length, checks: ['all-pages', 'headings', 'current-navigation', 'overflow', 'topic-search', 'empty-search', 'clear-search', 'keyboard-skip'] });
    } finally { await context.close(); }
  }
  for (const { href, from } of links) {
    const url = new URL(href); if (url.origin !== origin) continue;
    if (destinations.has(url.pathname)) {
      if (url.hash && !destinations.get(url.pathname).has(decodeURIComponent(url.hash.slice(1)))) throw Error(`Broken documentation anchor in ${from}: ${href}`);
      continue;
    }
    if (url.pathname === '/' && url.searchParams.get('path')?.startsWith('/story/')) {
      if (!index.entries[url.searchParams.get('path').slice('/story/'.length)]) throw Error(`Broken Storybook link in ${from}: ${href}`);
      continue;
    }
    if (url.pathname === '/storymap/' && ['#components', '#routes', '#screens'].includes(url.hash)) continue;
    throw Error(`Broken documentation route in ${from}: ${href}`);
  }
  return { pages: documents.length, links: links.length, passed: true, results };
}
