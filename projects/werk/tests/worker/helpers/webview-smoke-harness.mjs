import { testListeningAddress } from '../../helpers/typed-boundaries.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

// Isolated real Worker transport and persistence; the executable below is a
// labelled protocol fixture. No provider login or live inference occurs.
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(predicate, label, attempts = 200) {
  for (let n = 0; n < attempts; n++) {
    if (await predicate().catch(() => false)) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = testListeningAddress(server).port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
export async function createHarness() {
  const cwd = fileURLToPath(new URL('../../../', import.meta.url));
  const evidence = process.env.WERK_BROWSER_EVIDENCE ? resolve(process.env.WERK_BROWSER_EVIDENCE) : await mkdtemp(join(tmpdir(), 'werk-browser-evidence-'));
  const state = await mkdtemp(join(tmpdir(), 'werk-board-browser-'));
  await mkdir(evidence, { recursive: true });
  const fixture = join(state, 'model-fixture'), repository = join(state, 'approved-repository');
  await mkdir(repository);
  await writeFile(join(repository, 'README.md'), '# Worker UI fixture\nOriginal instructions.\n');
  const patchText = JSON.stringify({ summary: 'Fixture patch for review; no checkout changes or tests were performed.', files: [{ path: 'README.md', content: '# Worker UI fixture\nUpdated task interaction guidance.\n' }] });
  const fixtureCode = `#!${process.execPath}
if(process.argv.slice(2).join(' ')==='login status'){console.log('Logged in using protocol fixture');process.exit(0)}
let input='';for await(const part of process.stdin)input+=part;
const messages=JSON.parse(input.split('Conversation JSON:\\n').at(-1));
const latest=messages.at(-1)?.content ?? '';
const question=latest.includes('[checkpoint]');
const slow=latest.includes('[slow]'), hold=latest.includes('[hold]'), patch=input.includes('Return the existing approved-file patch JSON format');
const text=patch?${JSON.stringify(patchText)}:question?JSON.stringify({werkInteraction:{schemaVersion:1,kind:'question',message:'Which package should the fixture prepare?',choices:[{id:'desktop',label:'Desktop app'},{id:'browser',label:'Browser app'}],reason:'The fixture needs an explicit package decision.'}}):'**Review complete — protocol fixture**\\n\\n- Saved task context retained.\\n- No live model request performed.\\n\\n'+String.fromCharCode(96).repeat(3)+'js\\nconst next = "Review the saved patch";\\n'+String.fromCharCode(96).repeat(3)+'\\n\\n<svg onload="window.unsafeMessage=true"> is plain text here.';
setTimeout(()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:120,output_tokens:24}}));},hold?60000:slow?10000:900);
`;
  await writeFile(fixture, fixtureCode, { mode: 0o700 });
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const log = await open(join(evidence, 'worker.log'), 'w');
  let worker, browser, token;
  const result = { checks: [], screenshots: [], pageErrors: [], liveProvider: false };
  async function start() {
    worker = spawn(process.execPath, ['werk.mjs', 'worker', 'run', '--state-dir', state, '--status-port', String(port)], { cwd, stdio: ['ignore', log.fd, log.fd] });
    await until(async () => (await fetch(url + '/healthz')).ok, 'isolated worker ready');
    token = (await readFile(join(state, 'webview-token'), 'utf8')).trim();
  }
  async function stop() {
    if (!worker || worker.exitCode !== null) return;
    worker.kill('SIGTERM');
    await Promise.race([new Promise(resolve => worker.once('exit', resolve)), delay(10000)]);
    if (worker.exitCode === null) worker.kill('SIGKILL');
  }
  async function api(path, body) {
    const response = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    assert.ok(response.ok, `${path}: ${value.error ?? response.status}`);
    return value;
  }
  async function close(error) {
    if (error) {
      result.error = error.message;
      await writeFile(join(evidence, 'failure.json'), JSON.stringify(result, null, 2));
    } else {
      assert.deepEqual(result.pageErrors, []);
      await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2));
      await rm(join(evidence, 'failure.json'), { force: true });
      await rm(join(evidence, 'failure-state.png'), { force: true });
    }
    await browser?.close();
    await stop();
    await log.close();
    await rm(state, { recursive: true, force: true });
  }
  try {
    await start();
    const { chromium } = await import(pathToFileURL(resolve(process.env.WERK_PLAYWRIGHT_MODULE ?? join(cwd, '../../bin/browser-runtime/playwright-core/index.mjs'))).href);
    browser = await chromium.launch({ executablePath: process.env.WERK_CHROMIUM ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    page.on('pageerror', error => result.pageErrors.push(error.message));
    async function screenshot(name) {
      await page.evaluate(() => scrollTo(0, 0));
      await delay(150);
      const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      assert.ok(layout.scrollWidth <= layout.width, `${name}: ${layout.scrollWidth}px overflow at ${layout.width}px`);
      await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true });
      result.screenshots.push(name);
    }
    async function unlock() {
      await page.getByLabel('Worker access token', { exact: true }).fill(token);
      await page.getByRole('button', { name: 'Unlock worker', exact: true }).click();
      await page.getByRole('button', { name: 'Lock', exact: true }).waitFor();
    }
    async function choose(label, option) {
      await page.getByLabel(label, { exact: true }).click();
      await page.getByRole('option', { name: option, exact: true }).click();
    }
    async function refresh() {
      await page.getByRole('button', { name: 'Refresh worker', exact: true }).click();
      await delay(200);
    }
    return { page, context, url, evidence, fixture, repository, api, screenshot, unlock, choose, refresh, start, stop, close, result };
  } catch (error) {
    await close(error);
    throw error;
  }
}
