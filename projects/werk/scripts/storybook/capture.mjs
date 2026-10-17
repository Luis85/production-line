import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir, lstat, rm } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderStorymap } from './render-storymap.mjs';
import { verifyDocumentation } from './verify-documentation.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const VIEWPORTS = Object.freeze([
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
]);
const FIXED_DATE = '2026-10-15T09:30:00.000Z';

/** Coverage represents components that Vue actually mounted, never mere imports. */
export function calculateCoverage(components, records) {
  const observed = new Set(records.flatMap((record) => record.mounted ?? []));
  const paths = [...new Set(components.map((component) => component.path))].sort();
  const missing = paths.filter((path) => !observed.has(path));
  return { total: paths.length, covered: paths.length - missing.length, missing };
}

export function validateCaptureRecords(entries, records) {
  const issues = [];
  const expected = new Set(entries.flatMap((entry) => VIEWPORTS.map((viewport) => `${entry.id}/${viewport.name}`)));
  const seen = new Set();
  for (const record of records) {
    const key = `${record.id}/${record.viewport}`;
    if (!expected.has(key)) issues.push(`Unexpected screenshot record: ${key}`);
    if (seen.has(key)) issues.push(`Duplicate screenshot record: ${key}`);
    seen.add(key);
  }
  for (const key of expected) if (!seen.has(key)) issues.push(`Missing screenshot record: ${key}`);
  return issues;
}

export function validateStoryEvidence({ id, metadata, mounted, errors = [], meaningful, horizontalOverflow = false, document: renderedDocument }, components, documents = []) {
  const issues = errors.map((message) => `${id}: ${message}`);
  const known = new Set(components.map((component) => component.path));
  if (!meaningful) issues.push(`${id}: the story did not render a visible, meaningful interface`);
  if (horizontalOverflow) issues.push(`${id}: the interface overflows its viewport horizontally`);
  if (!metadata || typeof metadata !== 'object') return [...issues, `${id}: missing storymap metadata`];
  if (typeof metadata.app !== 'string' || !metadata.app.trim()) issues.push(`${id}: missing application`);
  if (typeof metadata.summary !== 'string' || !metadata.summary.trim()) issues.push(`${id}: missing summary`);
  if (metadata.kind === 'documentation') {
    if (metadata.app !== 'Documentation' || !documents.some(page => page.id === metadata.document) || renderedDocument !== metadata.document) issues.push(`${id}: documentation must render an indexed page`);
    if (!Array.isArray(metadata.covers) || metadata.covers.length || mounted.length) issues.push(`${id}: documentation cannot claim component coverage`);
    return issues;
  }
  if (!Array.isArray(metadata.covers) || !metadata.covers.length) {
    issues.push(`${id}: covers must name at least one source component`);
  } else {
    for (const path of metadata.covers) {
      if (!known.has(path)) issues.push(`${id}: unknown component ${path}`);
      else if (!mounted.includes(path)) issues.push(`${id}: declared component was not mounted: ${path}`);
    }
  }
  for (const path of mounted) if (!known.has(path)) issues.push(`${id}: mounted source is absent from the inventory: ${path}`);
  if (!mounted.length) issues.push(`${id}: no source components were mounted`);
  return issues;
}

export async function assetManifest(directory) {
  const files = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(current, entry.name);
      const path = relative(directory, absolute).split(sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`Storybook artifacts cannot contain symlinks: ${path}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && path !== 'storymap/qualification.json') {
        files.push({ path, sha256: createHash('sha256').update(await readFile(absolute)).digest('hex') });
      }
    }
  }
  await visit(directory);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

async function serve(directory) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const path = resolve(directory, `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`);
      if (!path.startsWith(`${directory}${sep}`)) throw new Error('Outside static root');
      if (!(await lstat(path)).isFile()) throw new Error('Not a file');
      const body = await readFile(path);
      response.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('Not found');
    }
  });
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/** Runs inside the story iframe; dialogs may teleport outside #storybook-root. */
export function readStoryEvidence() {
  function visible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }
  const errorSelector = '.sb-errordisplay, .sb-error, #error-message';
  const surfaces = [...document.querySelectorAll('#storybook-root, [role="dialog"], [role="alertdialog"]')];
  const meaningful = surfaces.some((surface) => !surface.closest(`${errorSelector}, [aria-hidden="true"], [hidden]`) &&
    visible(surface) && ((surface.innerText?.trim().length ?? 0) > 0 || surface.querySelector('svg, img, canvas')));
  const visibleErrors = [...document.querySelectorAll(errorSelector)].filter(visible).map((element) => element.textContent);
  return {
    metadata: window.__WERK_STORYMAP__,
    document: document.querySelector?.('.werk-docs[data-document]')?.getAttribute('data-document'),
    mounted: [...(window.__WERK_MOUNTED_SOURCES__ ?? [])].sort(),
    errors: [...(window.__WERK_STORY_ERRORS__ ?? []), ...visibleErrors],
    meaningful,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
}

/** Qualify the generated catalog itself in addition to its source stories. */
export async function verifyStorymap(browser, origin, inventory, manifest) {
  const results = [];
  const total = inventory.components.length + manifest.stories.filter((story) => story.viewport === 'desktop').length;
  const query = inventory.components[0].path;
  const matches = 1 + manifest.stories.filter((story) => story.viewport === 'desktop' && story.mounted.includes(query)).length;
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', (response) => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
    page.on('requestfailed', (request) => errors.push(`Request failed: ${request.url()}`));
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (['data:', 'blob:'].includes(url.protocol)) return route.continue();
      if (url.origin !== origin || /^\/(?:api|v1|status|monitoring|health)(?:\/|$)/.test(url.pathname)) {
        errors.push(`Unmocked catalog request: ${url.origin}${url.pathname}`);
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    await context.routeWebSocket('**/*', (socket) => { errors.push(`Unmocked catalog WebSocket: ${socket.url()}`); socket.close(); });
    try {
      await page.goto(`${origin}/storymap/`, { waitUntil: 'load' });
      async function check(expected, empty, phase) {
        const actual = await page.evaluate(() => ({
          visible: document.querySelectorAll('.searchable:not([hidden])').length,
          empty: !document.querySelector('#no-results').hidden,
          overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        }));
        if (actual.visible !== expected || actual.empty !== empty) throw new Error(`Catalog ${phase} produced ${actual.visible} visible entries; expected ${expected}, empty=${empty}`);
        if (actual.overflow) throw new Error(`Catalog ${phase} overflows horizontally`);
      }
      await page.locator('h1').waitFor({ state: 'visible' });
      await check(total, false, 'initial view');
      await page.locator('#search').fill(query);
      await check(matches, false, 'source search');
      await page.locator('#search').fill('__werk_storymap_no_matching_entry__');
      await check(0, true, 'empty search');
      await page.locator('#search').fill('');
      await check(total, false, 'cleared search');
      if (errors.length) throw new Error(errors.join('\n'));
      results.push({ viewport: viewport.name, passed: true, checks: ['render', 'overflow', 'source-search', 'empty-search', 'cleared-search'] });
    } catch (error) {
      throw new Error(`Generated storymap (${viewport.name}): ${[error.message, ...errors].join('\n')}`, { cause: error });
    } finally {
      await context.close();
    }
  }
  return results;
}

async function inspectStory(browser, origin, entry, viewport, inventory, output) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`Console error: ${message.text()}`); });
  page.on('response', (response) => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
  page.on('requestfailed', (request) => errors.push(`Request failed: ${request.url()} (${request.failure()?.errorText})`));
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
    if (url.origin !== origin || /^\/(?:api|v1|status|monitoring|health)(?:\/|$)/.test(url.pathname)) {
      errors.push(`Unmocked network request: ${url.origin}${url.pathname}`);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  await context.routeWebSocket('**/*', (socket) => {
    errors.push(`Unmocked WebSocket connection: ${socket.url()}`);
    socket.close();
  });
  try {
    await page.clock.setFixedTime(new Date(FIXED_DATE));
    await page.goto(`${origin}/iframe.html?id=${encodeURIComponent(entry.id)}&viewMode=story`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__WERK_STORY_READY__ === true, null, { timeout: 30_000 });
    const metadata = await page.evaluate(() => window.__WERK_STORYMAP__);
    if (metadata?.ready) await page.locator(metadata.ready).first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const evidence = await page.evaluate(readStoryEvidence);
    const issues = validateStoryEvidence({ id: entry.id, ...evidence, errors: [...errors, ...evidence.errors] }, inventory.components, inventory.documents);
    if (issues.length) throw new Error(issues.join('\n'));
    const screenshot = `screenshots/${entry.id}-${viewport.name}.png`;
    await page.screenshot({ path: join(output, screenshot), fullPage: true, animations: 'disabled', caret: 'hide' });
    if (errors.length) throw new Error(errors.join('\n'));
    return { id: entry.id, title: entry.title, name: entry.name, metadata: evidence.metadata, mounted: evidence.mounted,
      viewport: viewport.name, width: viewport.width, height: viewport.height, horizontalOverflow: evidence.horizontalOverflow, screenshot };
  } catch (error) {
    throw new Error(`${entry.id} (${viewport.name}): ${[error.message, ...errors].join('\n')}`, { cause: error });
  } finally {
    await context.close();
  }
}

export async function capture({ root = PROJECT_ROOT, staticRoot = join(root, 'storybook-static') } = {}) {
  const output = join(staticRoot, 'storymap');
  let browser;
  let server;
  let inventory;
  let records = [];
  await mkdir(output, { recursive: true });
  // Invalidate any previous passing qualification before inspecting the new build.
  await rm(join(output, 'qualification.json'), { force: true });
  try {
    inventory = JSON.parse(await readFile(join(output, 'source.json'), 'utf8'));
    if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.components) || !inventory.components.length) throw new Error('Invalid or empty generated source inventory; run storybook:build');
    const { sourceDigest, sourceCommit } = await import('./source.mjs');
    if (inventory.sourceDigest !== await sourceDigest(root)) throw new Error('Storybook is stale: source files changed after generation. Run storybook:build again.');
    if (inventory.commit !== sourceCommit(root)) throw new Error('Storybook is stale: the current commit differs from the generated source inventory. Run storybook:build again.');
    const index = JSON.parse(await readFile(join(staticRoot, 'index.json'), 'utf8'));
    const entries = Object.values(index.entries ?? {}).filter((entry) => entry.type === 'story').sort((a, b) => a.id.localeCompare(b.id));
    if (!entries.length) throw new Error('Built Storybook has no stories');
    for (const entry of entries) if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(entry.id)) throw new Error(`Unsafe story id: ${entry.id}`);
    await rm(join(output, 'screenshots'), { recursive: true, force: true });
    await mkdir(join(output, 'screenshots'), { recursive: true });
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true, ...(process.env.WERK_CHROMIUM ? { executablePath: process.env.WERK_CHROMIUM } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const serving = await serve(resolve(staticRoot));
    server = serving.server;
    for (const entry of entries) {
      for (const viewport of VIEWPORTS) {
        records.push(await inspectStory(browser, serving.origin, entry, viewport, inventory, output));
      }
      process.stdout.write(`Captured ${entry.id} (${records.length}/${entries.length * VIEWPORTS.length})\n`);
    }
    const recordIssues = validateCaptureRecords(entries, records);
    if (recordIssues.length) throw new Error(recordIssues.join('\n'));
    const coverage = calculateCoverage(inventory.components, records);
    if (coverage.missing.length) throw new Error(`Source components without rendered evidence:\n${coverage.missing.join('\n')}`);
    if (inventory.sourceDigest !== await sourceDigest(root)) throw new Error('Source files changed during screenshot capture; rebuild and capture again.');
    if (inventory.commit !== sourceCommit(root)) throw new Error('The commit changed during screenshot capture; rebuild and capture again.');
    const manifest = { schemaVersion: 1, version: inventory.version, commit: inventory.commit, sourceDigest: inventory.sourceDigest,
      capturedAt: new Date().toISOString(), fixtureTime: FIXED_DATE, viewports: VIEWPORTS, coverage, stories: records };
    await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(output, 'index.html'), renderStorymap(inventory, manifest));
    const catalog = await verifyStorymap(browser, serving.origin, inventory, manifest);
    const documentation = await verifyDocumentation(browser, serving.origin, inventory, staticRoot, VIEWPORTS);
    if (inventory.sourceDigest !== await sourceDigest(root) || inventory.commit !== sourceCommit(root)) throw new Error('Source identity changed during catalog qualification; rebuild and capture again.');
    const qualification = { schemaVersion: 1, version: inventory.version, commit: inventory.commit, sourceDigest: inventory.sourceDigest,
      passed: true, coverage, stories: entries.length, screenshots: records.length, catalog, documentation, errors: [], files: await assetManifest(staticRoot) };
    await writeFile(join(output, 'qualification.json'), `${JSON.stringify(qualification, null, 2)}\n`);
    process.stdout.write(`Storymap qualified: ${coverage.covered}/${coverage.total} components, ${entries.length} stories, ${records.length} screenshots.\n`);
    return qualification;
  } catch (error) {
    const report = { schemaVersion: 1, version: inventory?.version ?? null, commit: inventory?.commit ?? null,
      sourceDigest: inventory?.sourceDigest ?? null, passed: false, coverage: calculateCoverage(inventory?.components ?? [], records),
      stories: new Set(records.map((record) => record.id)).size, screenshots: records.length, errors: [error.message], files: [] };
    await writeFile(join(output, 'qualification.json'), `${JSON.stringify(report, null, 2)}\n`);
    throw error;
  } finally {
    await Promise.allSettled([
      browser?.close(),
      server ? new Promise((done) => server.close(done)) : Promise.resolve(),
    ]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  capture().catch((error) => { console.error(`Storymap capture failed: ${error.message}`); process.exitCode = 1; });
}
