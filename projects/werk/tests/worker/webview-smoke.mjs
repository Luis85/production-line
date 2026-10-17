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
async function until(predicate, label, attempts = 200) {
  for (let n = 0; n < attempts; n++) {
    if (await predicate().catch(() => false)) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function createHarness() {
  const cwd = fileURLToPath(new URL('../../', import.meta.url));
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

const h = await createHarness();
const { page, api, screenshot, refresh, choose, result } = h;
const panel = () => page.locator('.task-interaction');
async function selectTask(title) {
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).first();
  await card.getByRole('button', { name: /^(Open task|Answer task)$/ }).click();
  await until(async () => (await page.locator('#chat-task-title').textContent()) === title, 'selected ' + title);
}
async function showNew() {
  await panel().getByRole('tab', { name: 'New request', exact: true }).click();
  await panel().locator('#new-task-instructions').waitFor();
}
async function createTask(title, message) {
  await showNew();
  const definition = panel().locator('.intake-definition:not(.repository-options)');
  if (!await definition.evaluate(element => element.open)) await definition.locator(':scope > summary').click();
  await panel().getByLabel('Request name · optional', { exact: true }).fill(title);
  await panel().locator('#new-task-instructions').fill(message);
  const admission = page.waitForResponse(response => response.url().endsWith('/api/tasks') && response.request().method() === 'POST' && response.request().postDataJSON().action === 'create');
  await panel().getByRole('button', { name: 'Create request', exact: true }).click();
  const response = await admission, receipt = await response.json();
  assert.ok(response.ok(), receipt.error ?? 'Request admission failed');
  const command = response.request().postDataJSON();
  if (receipt.preparation) {
    assert.equal(response.status(), 202, 'background preparation is not durable acceptance');
    assert.equal(command.background, true);
    assert.ok(command.files);
    assert.equal(receipt.preparation.id, command.id, 'preparation retains the submitted operation identity');
    assert.equal(receipt.preparation.state, 'preparing');
  }
  await until(async () => (await page.locator('#chat-task-title').textContent()) === title, 'created ' + title);
  const accepted = receipt.preparation ? await api('/api/tasks', { action: 'get', id: 'local-' + command.id }) : receipt;
  assert.ok(accepted.session && accepted.chat, 'saved session and conversation exist after preparation');
  if (receipt.preparation) assert.equal(accepted.session.id, 'local-' + command.id);
  assert.equal((await api('/api/sessions')).selected, accepted.session.id, 'opens exact admitted session');
  return accepted.session.id;
}
async function setQueue(paused) {
  const before = await api('/api/settings');
  if (before.board.paused === paused) return;
  const button = page.getByRole('button', { name: paused ? 'Pause new starts' : 'Resume new starts', exact: true });
  await button.click();
  await until(async () => (await api('/api/settings')).board.paused === paused, paused ? 'queue paused' : 'queue resumed');
}
async function complete(id) {
  await until(async () => (await api('/api/sessions')).records.find(task => task.id === id)?.status === 'completed', 'completed ' + id);
  await refresh();
}
try {
  await page.goto(h.url);
  await page.getByRole('button', { name: 'Unlock worker', exact: true }).waitFor();
  assert.equal(await page.getByRole('navigation', { name: 'Worker pages' }).count(), 0);
  await screenshot('login-desktop');
  await page.setViewportSize({ width: 390, height: 844 }); await screenshot('login-mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel('Worker access token', { exact: true }).fill('invalid');
  await page.getByRole('button', { name: 'Unlock worker', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'incorrect' }).waitFor();
  await h.unlock();
  await page.getByRole('heading', { name: 'Taskboard', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/taskboard');
  await page.reload(); await page.getByRole('button', { name: 'Lock', exact: true }).waitFor();
  result.checks.push('unlock, invalid access, Taskboard default route, reload retains browser access');

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Provider connections & accounts', exact: true }).waitFor();
  await page.getByLabel('CLI executable on this machine', { exact: true }).fill(h.fixture);
  await page.getByRole('button', { name: 'Save provider', exact: true }).click();
  await page.getByText('Settings saved.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Check sign-in', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Codex reports a signed-in account. No model request was made.' }).waitFor();
  await page.getByRole('navigation', { name: 'Worker settings sections', exact: true }).getByRole('link', { name: /Agent definitions/ }).click();
  await page.getByRole('heading', { name: 'Docker Agent definitions', exact: true }).waitFor();
  await page.getByLabel('Definition name', { exact: true }).fill('Protocol reviewer');
  await page.getByLabel('Or paste Docker Agent YAML', { exact: true }).fill('version: "15"\nagents:\n  root:\n    model: openai/gpt-fixture\n    description: Review requirements\n    instruction: Review acceptance criteria before proposing work.\n    toolsets:\n      - type: filesystem\n');
  await page.getByRole('button', { name: 'Preview definition', exact: true }).click();
  await page.getByRole('heading', { name: 'Review before importing', exact: true }).waitFor();
  await screenshot('definition-preview-desktop');
  await page.getByRole('button', { name: 'Import definition', exact: true }).click();
  await page.getByText('Definition saved. Choose it when creating a new task.', { exact: true }).waitFor();
  result.checks.push('Settings provider save/sign-in check and agent definition preview/import');

  await page.getByRole('link', { name: 'Taskboard', exact: true }).click();
  await showNew();
  const initialOptions = panel().locator('.intake-definition:not(.repository-options)');
  assert.equal(await initialOptions.evaluate(element => element.open), false, 'task options start collapsed');
  const instructionsTop = await panel().locator('#new-task-instructions').evaluate(element => element.getBoundingClientRect().top);
  const optionsTop = await initialOptions.locator(':scope > summary').evaluate(element => element.getBoundingClientRect().top);
  assert.ok(instructionsTop < optionsTop, 'instructions precede optional setup');
  await initialOptions.locator(':scope > summary').focus();
  await page.keyboard.press('Enter');
  await until(async () => initialOptions.evaluate(element => element.open), 'keyboard opens task options');
  await choose('Agent definition', 'Protocol reviewer');
  await panel().locator('#new-task-instructions').fill('Prepare acceptance criteria [slow]');
  assert.equal(await panel().getByRole('button', { name: 'Create request', exact: true }).isDisabled(), true);
  await panel().getByLabel('Use instructions only. I accept the omitted features listed above.', { exact: true }).check();
  assert.match(await panel().locator('.intake-model').textContent(), /gpt-fixture/);
  await setQueue(true);
  await screenshot('task-intake-desktop');
  const first = await createTask('Review worker lifecycle', 'Prepare acceptance criteria [slow]');
  const initialRecord = await api('/api/feature-tracking', { action: 'get', sessionId: first });
  assert.equal(initialRecord.sessionId, first); assert.match(initialRecord.filename, /\.md$/); assert.match(initialRecord.markdown, /Prepare acceptance criteria/);
  await panel().locator('.feature-request-filename').filter({ hasText: initialRecord.filename }).waitFor();
  const noteDetails = panel().locator('#feature-request-note > details');
  await noteDetails.locator(':scope > summary').click();
  await panel().locator('.request-markdown').filter({ hasText: 'Prepare acceptance criteria' }).waitFor();
  const downloading = page.waitForEvent('download');
  await panel().getByRole('button', { name: 'Download Markdown', exact: true }).click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), initialRecord.filename); assert.match(await readFile(await download.path(), 'utf8'), /Prepare acceptance criteria/);
  await noteDetails.locator(':scope > summary').click();
  result.checks.push('every admitted request has a readable Markdown record and authenticated exact-file download');
  await panel().getByRole('button', { name: 'Cancel queued task', exact: true }).waitFor();
  const firstMessageCount = (await api('/api/chat')).messages.length;
  await panel().getByLabel('Follow-up for this task', { exact: true }).fill('First task follow-up draft');
  await panel().getByLabel('Follow-up for this task', { exact: true }).press('Control+Enter');
  assert.equal((await api('/api/chat')).messages.length, firstMessageCount);
  assert.equal(await panel().getByRole('button', { name: 'Send follow-up', exact: true }).count(), 0);
  const second = await createTask('Prepare release notes', 'Describe changes for the release.');
  await panel().getByLabel('Follow-up for this task', { exact: true }).fill('Second task follow-up draft');
  await selectTask('Review worker lifecycle');
  assert.equal(await panel().getByLabel('Follow-up for this task', { exact: true }).inputValue(), 'First task follow-up draft');
  await selectTask('Prepare release notes');
  assert.equal(await panel().getByLabel('Follow-up for this task', { exact: true }).inputValue(), 'Second task follow-up draft');
  await selectTask('Review worker lifecycle');
  const originalQueueCapacity = (await api('/api/settings')).board.queueCapacity;
  await api('/api/settings', { board: { queueCapacity: 2 } });
  await refresh();
  await page.getByRole('button', { name: 'New request', exact: true }).click();
  await panel().locator('#new-task-instructions').fill('Keep these instructions while capacity is full.');
  await until(async () => panel().getByRole('button', { name: 'Create request', exact: true }).isDisabled(), 'full local admission disables create');
  assert.match(await page.locator('.worker-capacity').textContent(), /2 \/ 2 local places used/);
  assert.match(await panel().textContent(), /Local admission is full/);
  await panel().locator('#new-task-instructions').press('Control+Enter');
  assert.equal((await api('/api/sessions')).records.filter(task => task.status === 'queued').length, 2, 'full admission keeps existing tasks');
  assert.equal(await panel().locator('#new-task-instructions').inputValue(), 'Keep these instructions while capacity is full.');
  await api('/api/settings', { board: { queueCapacity: originalQueueCapacity } });
  await refresh();
  await until(async () => panel().getByRole('button', { name: 'Create request', exact: true }).isEnabled(), 'restored admission enables retained draft');
  await selectTask('Review worker lifecycle');
  result.checks.push('instructions-first intake, keyboard task options, explicit New task, exact local capacity gating retains draft and accepted tasks');
  await screenshot('queued-tasks-desktop');
  await page.setViewportSize({ width: 1488, height: 1056 }); await screenshot('selected-direction-1488'); await page.setViewportSize({ width: 1440, height: 1000 });
  console.log(JSON.stringify({ readyForVisualReview: h.evidence + '/selected-direction-1488.png' }));
  result.checks.push('single idempotent feature-request admission with provider/definition, busy follow-up gating, per-task draft isolation');

  await setQueue(false);
  await until(async () => (await api('/api/sessions')).execution.currentSessionId === first, 'first task running');
  await refresh();
  await panel().getByRole('button', { name: 'Stop task', exact: true }).waitFor();
  await setQueue(true);
  assert.equal((await api('/api/sessions')).execution.currentSessionId, first);
  await screenshot('running-task-desktop');
  await panel().getByRole('button', { name: 'Stop task', exact: true }).click();
  await until(async () => !(await api('/api/chat')).busy, 'running task stopped');
  assert.equal((await api('/api/sessions')).records.find(task => task.id === second).status, 'queued');
  await selectTask('Prepare release notes');
  await panel().getByRole('button', { name: 'Cancel queued task', exact: true }).click();
  await until(async () => !(await api('/api/chat')).busy, 'queued task cancelled');
  result.checks.push('pause new starts leaves active task running; stop active and cancel queued are distinct');

  const finished = await createTask('Review task results', 'Explain the task results.\n\n' + Array.from({ length: 40 }, (_, index) => '- Context item ' + (index + 1) + ': retain the acceptance evidence.').join('\n'));
  await setQueue(false); await complete(finished);
  assert.equal(await page.evaluate(() => window.unsafeMessage), undefined);
  await panel().getByRole('button', { name: 'Copy code', exact: true }).click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Review the saved patch/);
  const conversation = panel().locator('.task-conversation');
  assert.ok(await conversation.evaluate(element => element.scrollHeight > element.clientHeight), 'long transcript can scroll');
  await conversation.evaluate(element => { element.scrollTop = 0; });
  await refresh();
  await panel().getByLabel('Follow-up for this task', { exact: true }).fill('Summarize the next steps.');
  assert.equal(await conversation.evaluate(element => element.scrollTop), 0, 'refresh and drafting preserve the reading position');
  const rejectFollowUp = route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture send rejection.' }) });
  await page.route('**/api/chat', rejectFollowUp);
  await panel().getByRole('button', { name: 'Send follow-up', exact: true }).click();
  await panel().getByRole('alert').filter({ hasText: 'Fixture send rejection.' }).waitFor();
  assert.equal(await conversation.evaluate(element => element.scrollTop), 0, 'a rejected send preserves the reading position');
  assert.equal(await panel().getByLabel('Follow-up for this task', { exact: true }).inputValue(), 'Summarize the next steps.');
  await page.unroute('**/api/chat', rejectFollowUp);
  await panel().getByRole('button', { name: 'Send follow-up', exact: true }).click();
  await until(async () => await conversation.evaluate(element => element.scrollTop > 0), 'successful follow-up reveals the latest message');
  await complete(finished);
  assert.equal((await api('/api/chat')).messages.length, 4);
  assert.equal((await api('/api/sessions')).selected, finished);
  assert.equal((await api('/api/feature-tracking', { action: 'get', sessionId: finished })).sessionId, finished);
  result.checks.push('same-task follow-up scrolls after success, preserves reading position/draft after rejected send and refresh; formatted output/copy code, inert provider HTML');

  const checkpoint = await createTask('Choose delivery target', 'Choose the delivery target [checkpoint]');
  await until(async () => !!(await api('/api/interactions', { action: 'get', sessionId: checkpoint })).pending, 'durable question');
  await refresh();
  await panel().getByRole('button', { name: 'Browser app', exact: true }).click();
  assert.equal(await panel().getByLabel('Your answer or decision', { exact: true }).inputValue(), 'Browser app');
  assert.ok((await api('/api/interactions', { action: 'get', sessionId: checkpoint })).pending);
  await screenshot('checkpoint-desktop');
  await setQueue(true);
  await panel().getByRole('button', { name: 'Answer & continue', exact: true }).click();
  await until(async () => (await api('/api/sessions')).records.find(task => task.id === checkpoint)?.status === 'queued', 'answer queued');
  await setQueue(false); await complete(checkpoint);
  const answered = await api('/api/interactions', { action: 'get', sessionId: checkpoint });
  assert.equal(answered.pending, null); assert.ok(answered.totalTurns >= 2);
  result.checks.push('saved checkpoint choice never auto-submits; answer queues continuation and respects paused queue');

  await page.getByRole('button', { name: 'List', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'List', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByLabel('Search tasks', { exact: true }).fill('Review task results');
  await until(async () => await page.locator('article.overview-card').count() === 1, 'search filters one matching task');
  assert.equal(await page.locator('article.overview-card').getAttribute('aria-label'), 'Review task results');
  await screenshot('search-list-desktop');
  await page.getByLabel('Search tasks', { exact: true }).fill('No matching task exists');
  await until(async () => await page.locator('article.overview-card').count() === 0, 'search empty result');
  await page.getByLabel('Search tasks', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await showNew();
  await panel().locator('#new-task-instructions').fill('Unsent new task instructions');
  await screenshot('taskboard-desktop');
  await page.setViewportSize({ width: 900, height: 900 }); await screenshot('taskboard-tablet');
  await page.setViewportSize({ width: 390, height: 844 }); await screenshot('taskboard-mobile');
  await page.getByRole('button', { name: 'New request', exact: true }).click();
  assert.equal(await panel().locator('#new-task-instructions').inputValue(), 'Unsent new task instructions');
  await page.getByRole('button', { name: 'Continue selected task', exact: true }).click();
  await until(async () => page.evaluate(() => document.activeElement?.id === 'chat-task-title'), 'mobile selected task jump focuses conversation');
  await panel().getByRole('button', { name: 'Write a follow-up', exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'chat-message');
  await panel().getByRole('button', { name: 'Back to taskboard', exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'taskboard-heading');
  await page.getByRole('button', { name: 'Continue selected task', exact: true }).click();
  const mobileTranscript = panel().locator('.task-conversation');
  assert.ok(await mobileTranscript.evaluate(element => element.clientHeight <= innerHeight * .56), 'mobile transcript leaves the composer within reach');
  result.checks.push('mobile New task preserves draft; selected-task, composer and taskboard jumps move keyboard focus; bounded transcript');
  await screenshot('followup-mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('link', { name: 'History', exact: true }).click(); await screenshot('history-desktop');
  await page.getByRole('button', { name: 'Open task Choose delivery target', exact: true }).click();
  await until(async () => await panel().getByRole('tab', { name: 'Follow up', exact: true }).getAttribute('aria-selected') === 'true', 'history reopens selected conversation');
  assert.equal(await page.locator('#chat-task-title').textContent(), 'Choose delivery target');
  await page.getByRole('link', { name: 'Metrics', exact: true }).click(); await screenshot('metrics-desktop');
  assert.equal(await page.locator('.metrics-page form').count(), 0, 'Metrics does not contain configuration forms');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Provider connections & accounts', exact: true }).waitFor();
  const settingsNav = page.getByRole('navigation', { name: 'Worker settings sections', exact: true });
  await settingsNav.getByRole('link', { name: /Queue & duration/ }).click();
  const queuePanel = page.locator('.queue-settings');
  await page.getByLabel('Local request capacity', { exact: true }).fill('20');
  await settingsNav.getByRole('link', { name: /Providers & accounts/ }).click();
  await settingsNav.getByRole('link', { name: /Queue & duration/ }).click();
  assert.equal(await page.locator('#local-capacity').inputValue(), '20', 'Queue edits survive section navigation');
  await api('/api/settings', { board: { queueCapacity: 24 } }); await refresh();
  await queuePanel.getByText('Saved queue settings changed while you were editing.', { exact: false }).waitFor();
  assert.equal(await queuePanel.getByRole('button', { name: 'Save queue settings', exact: true }).isDisabled(), true);
  await screenshot('settings-queue-stale-desktop');
  await queuePanel.getByRole('button', { name: 'Discard edits and reload', exact: true }).click();
  assert.equal(await page.locator('#local-capacity').inputValue(), '24');
  await page.locator('#local-capacity').fill('16');
  await queuePanel.getByRole('button', { name: 'Save queue settings', exact: true }).click();
  await until(async () => (await api('/api/settings')).board.queueCapacity === 16, 'queue settings saved');
  await page.locator('#resource-warning-hours').fill('2');
  await page.getByRole('button', { name: 'Save duration settings', exact: true }).click();
  await until(async () => (await api('/api/settings')).resources.longRunningMs === 7200000, 'duration saved');
  await screenshot('settings-queue-desktop');
  await page.setViewportSize({ width: 390, height: 844 }); await screenshot('settings-queue-mobile');
  await choose('Settings section', 'Consumption');
  await page.getByLabel('Total allowance · tokens', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '#consumption-limits');
  await page.setViewportSize({ width: 1440, height: 1000 });
  result.checks.push('dedicated Metrics and Settings routes, navigation-retained edits, competing queue settings refusal, reload/save, duration save and mobile section selector');
  await page.getByRole('button', { name: 'Tour', exact: true }).click();
  await page.getByRole('dialog').waitFor(); await screenshot('tour-desktop');
  await page.locator('button[aria-label="Close tour"]').click();
  await page.getByRole('link', { name: 'Taskboard', exact: true }).click();
  await showNew();
  assert.equal(await panel().locator('#new-task-instructions').inputValue(), 'Unsent new task instructions');
  await panel().getByRole('tab', { name: 'New request', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await panel().getByRole('tab', { name: 'Follow up', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'followup-task-tab');
  await panel().getByLabel('Follow-up for this task', { exact: true }).fill('Unsent follow-up survives worker restart.');
  const transcriptBeforeRestart = (await api('/api/chat')).messages;
  await h.stop(); await h.start();
  await until(async () => page.getByRole('button', { name: 'Unlock worker', exact: true }).isVisible(), 'worker restart relocks');
  await h.unlock();
  await panel().getByRole('tab', { name: 'Follow up', exact: true }).click();
  assert.equal(await panel().getByLabel('Follow-up for this task', { exact: true }).inputValue(), 'Unsent follow-up survives worker restart.');
  assert.deepEqual((await api('/api/chat')).messages, transcriptBeforeRestart);
  await showNew();
  assert.equal(await panel().locator('#new-task-instructions').inputValue(), 'Unsent new task instructions');
  result.checks.push('tour, keyboard task tabs, internal-route draft preservation, restart relocks and preserves transcript plus per-task/intake drafts');
  await page.goto(h.url + '/chat?session=' + checkpoint);
  await page.getByRole('heading', { name: 'Taskboard', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/taskboard');
  await showNew();
  // Full navigation clears an in-memory draft; internal route changes above preserve it.
  await panel().locator('#new-task-instructions').fill('Explicit lock must clear this draft');
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await h.unlock(); await showNew();
  assert.equal(await panel().locator('#new-task-instructions').inputValue(), '');
  await page.getByRole('button', { name: 'Lock', exact: true }).click(); await page.reload();
  await page.getByRole('button', { name: 'Unlock worker', exact: true }).waitFor();
  assert.equal(await page.getByRole('navigation', { name: 'Worker pages' }).count(), 0);
  await h.unlock(); await showNew();
  result.checks.push('Board/List/search, desktop/tablet/mobile no document overflow, History/Metrics/Settings, legacy Chat redirect, explicit lock remains locked after reload');

  const fileOptions = panel().locator('.repository-options');
  await fileOptions.locator(':scope > summary').click();
  assert.equal(await page.getByLabel('Allow changes to approved repository files', { exact: true }).isChecked(), false);
  await page.getByLabel('Allow changes to approved repository files', { exact: true }).check();
  await page.getByLabel('Repository directory on the worker machine', { exact: true }).fill(h.repository);
  await page.getByLabel('Approved files · one relative path per line', { exact: true }).fill('README.md');
  const fileRequest = await createTask('Review navigation patch', 'Clarify the task interaction guidance in README.md.');
  const fileRecord = await api('/api/feature-tracking', { action: 'get', sessionId: fileRequest });
  assert.equal(fileRecord.sessionId, fileRequest); assert.match(fileRecord.markdown, /Clarify the task interaction guidance/);
  assert.doesNotMatch(await panel().locator('.task-conversation').textContent(), /Approved file snapshots:/);
  await until(async () => (await api('/api/taskboard')).tasks.some(task => task.title === 'Review navigation patch' && task.status === 'review'), 'file patch ready for review');
  await refresh();
  await page.getByRole('article', { name: 'Review navigation patch', exact: true }).getByRole('link', { name: 'Review proposed patch', exact: true }).click();
  await page.locator('#local-task-detail').filter({ hasText: 'Review navigation patch' }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/history');
  assert.ok(new URL(page.url()).searchParams.get('fileId'));
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'local-task-detail');
  await screenshot('file-patch-review-desktop');
  assert.equal(await readFile(join(h.repository, 'README.md'), 'utf8'), '# Worker UI fixture\nOriginal instructions.\n');
  await page.getByRole('link', { name: 'Taskboard', exact: true }).click();
  result.checks.push('approved-file task produces review patch without checkout changes; board Review proposed patch deep-link opens and focuses exact file evidence');

  await showNew();
  const representativeOptions = panel().locator('.intake-definition:not(.repository-options)');
  if (!await representativeOptions.evaluate(element => element.open)) await representativeOptions.locator(':scope > summary').click();
  await choose('Agent definition', 'Protocol reviewer');
  await panel().getByLabel('Use instructions only. I accept the omitted features listed above.', { exact: true }).check();
  const representativeQuestion = await createTask('Confirm release scope', 'Confirm the delivery format [checkpoint]');
  await until(async () => !!(await api('/api/interactions', { action: 'get', sessionId: representativeQuestion })).pending, 'representative decision');
  await createTask('Validate the worker lifecycle', 'Review task transitions and restart behavior [hold]');
  await createTask('Prepare release checklist', 'List the acceptance checks for the worker release.');
  await createTask('Document interaction states', 'Describe the task questions and follow-up states.');
  await showNew();
  const optionsDisclosure = panel().locator('.intake-definition:not(.repository-options)');
  if (await optionsDisclosure.evaluate(element => element.open)) await optionsDisclosure.locator(':scope > summary').click();
  await panel().locator('#new-task-instructions').fill('Review the retry flow and propose clearer next steps.');
  await page.setViewportSize({ width: 1488, height: 1056 });
  await screenshot('representative-taskboard-1488');
  await page.screenshot({ path: join(h.evidence, 'representative-taskboard-viewport.png'), fullPage: false });
  result.screenshots.push('representative-taskboard-viewport');
  await panel().screenshot({ path: join(h.evidence, 'representative-interaction-panel.png') });
  result.screenshots.push('representative-interaction-panel');
  console.log(JSON.stringify({ representativeCapture: h.evidence + '/representative-taskboard-1488.png', fixture: true }));
  await page.setViewportSize({ width: 390, height: 844 }); await screenshot('representative-taskboard-mobile');
  assert.deepEqual(result.pageErrors, []);
  await h.close(); console.log(JSON.stringify({ evidence: h.evidence, ...result }, null, 2));
} catch (error) {
  console.error(error.stack);
  await page.screenshot({ path: h.evidence + '/failure-state.png', fullPage: true }).catch(() => {});
  await h.close(error); process.exitCode = 1;
}
