import { fileURLToPath } from 'node:url';
import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNode, inputError, readPrivate } from '../config.mjs';
import { initializeWorker, projectDefaults } from './project.mjs';
import { workerBody, workerOutput, waitForWorker } from './worker-commands.mjs';
import { commands } from './commands.mjs';
import { run, start, status, stop, stateDirectory } from './lifecycle.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
export async function main(kind, argv = process.argv.slice(2)) {
  const { args, validateOptions, input, integer } = await import(new URL(`../../../src/${kind}/dist/shared/cli.js`, import.meta.url));
  const { request } = await import(new URL(`../../../src/${kind}/dist/shared/http/client.js`, import.meta.url));
  try {
    assertNode();
    // JSON is the default; accept a familiar explicit flag without a value.
    const dryRun = argv.includes('--dry-run');
    if (argv.filter(value => value === '--dry-run').length > 1) throw inputError('--dry-run must occur once.');
    const parsed = args(argv.filter(value => value !== '--json' && value !== '--dry-run')), cmd = parsed.commands.join(' ');
    let o = parsed.options;
    const catalog = commands(kind);
    if (dryRun && !(kind === 'worker' && cmd === 'integrations sync')) throw inputError('--dry-run is supported only by integrations sync.');
    if (!cmd || o.help || cmd === 'help' || cmd === 'schema') {
      console.log(JSON.stringify({ schemaVersion: 1, application: kind, node: '24.x', usage: `node bin/apps/${kind}/cli.mjs COMMAND [--state-dir PATH] [--json]`, lifecycle: { run: 'Foreground; Ctrl+C drains and closes', start: 'Detached; returns when ready', status: 'Authenticated process identity and webview URL', stop: 'Graceful authenticated shutdown; preserves state' }, launchOptions: ['state-dir', 'host', 'port', ...(kind === 'worker' ? ['config', 'url', 'project-dir', 'features-dir', 'poll-ms', 'mock-ms'] : kind === 'orchestrator' ? ['project'] : [])], clientOptions: ['state-dir', 'url', 'token-file', 'file', 'id', 'key'], input: 'JSON --file PATH or --file - (stdin), maximum 64 KiB. Local credentials resolved privately from state; remote URL requires explicit token-file or WERK_APP_TOKEN.', commands: catalog, ...(kind === 'worker' ? { executionPolicy: { environment: 'WERK_WORKER_MAX_RUNTIME_MS', scope: 'Local model invocations; frozen per dispatch, not total session age or polling timeout', defaultMs: 21600000, minimumMs: 1000, maximumMs: 86400000, precedence: 'Validated environment override, then saved private settings, then default', inspect: 'settings get: execution and executionSource; resource status: admission policy', update: 'settings set with execution; rejected while environment override is active' }, requestGates: { inspect: 'request get and request events', completion: 'Model completion, Request Done and applied/merged changes are distinct', dispatch: 'Inspect current-generation dispatch state; identical command receipt replay never admits new work', recovery: 'If not admitted and still ready, read current revision and issue a new guarded execute with a new key', guide: 'docs/how-to/rework-worker-requests.md' }, projectSetup: { command: 'init [--project-dir PATH] [--features-dir features] [--provider codex-cli] [--port 4100]', featureFolder: 'feature folder get | plan --path requests/features | set --path requests/features', template: 'feature template (prints Markdown without a running worker)', behavior: 'Installs a project-local app, config, draft template and Docker Compose file; preserves existing files.' } } : {}), api: 'api --path /local/path [--method GET|POST|PUT|PATCH|DELETE] [--file PATH|-] [--key KEY]', exitCodes: { 0: 'success', 1: 'operational failure', 2: 'input/API rejection' } }, null, 2)); return;
    }
    if (kind === 'worker' && ['integrations status', 'integrations plan', 'integrations sync'].includes(cmd)) {
      validateOptions(o, ['project-dir', ...(cmd.endsWith('sync') ? ['if-match'] : [])]);
      const { planProjectIntegrations, syncProjectIntegrations } = await import(new URL('../../../src/worker/dist/worker/infrastructure/project-integrations.js', import.meta.url));
      const project = o['project-dir'] ?? process.cwd();
      if (cmd.endsWith('sync') && !dryRun && !o['if-match']) throw inputError('--if-match PLAN_ID required; inspect integrations plan first.');
      console.log(JSON.stringify(cmd.endsWith('sync') && !dryRun ? await syncProjectIntegrations(project, o['if-match']) : await planProjectIntegrations(project))); return;
    }
    if (kind === 'worker' && ['feature folder get', 'feature folder plan', 'feature folder set'].includes(cmd)) {
      validateOptions(o, ['project-dir', ...(cmd.endsWith('get') ? [] : ['path'])]);
      const { featureFolder } = await import('./feature-folder.mjs');
      console.log(JSON.stringify(await featureFolder(cmd.split(' ')[2], o))); return;
    }
    if (kind === 'worker' && cmd === 'init') { validateOptions(o, ['project-dir', 'features-dir', 'provider', 'port']); console.log(JSON.stringify(await initializeWorker(root, o))); return; }
    if (kind === 'worker' && cmd === 'feature template') { validateOptions(o, []); const { featureTemplate } = await import(new URL('../../../src/worker/dist/worker/infrastructure/features/document.js', import.meta.url)); process.stdout.write(featureTemplate); return; }
    if (kind === 'worker' && ['run', '_run', 'start', 'status', 'stop'].includes(cmd)) {
      const defaults = await projectDefaults(o, !['status', 'stop'].includes(cmd));
      o = ['status', 'stop'].includes(cmd) ? { ...o, 'state-dir': defaults['state-dir'] ?? o['state-dir'] } : defaults;
    }
    const state = await stateDirectory(kind, root, o['state-dir']);
    if (['run', '_run', 'start'].includes(cmd)) {
      validateOptions(o, ['state-dir', 'host', 'port', ...(kind === 'worker' ? ['config', 'url', 'project-dir', 'features-dir', 'poll-ms', 'mock-ms'] : kind === 'orchestrator' ? ['project'] : [])]);
      if (o.port !== undefined) integer(o.port, 'port', 0, 65535);
      if (cmd === '_run' && !process.send) throw inputError('Internal launch requires an IPC parent. Use run or start.');
      if (cmd === 'start') console.log(JSON.stringify(await start(kind, state, root, argv.slice(1))));
      else await run(kind, state, root, o, cmd === '_run');
      return;
    }
    if (cmd === 'status' || cmd === 'stop') {
      validateOptions(o, ['state-dir']);
      const value = await (cmd === 'status' ? status : stop)(kind, state);
      console.log(JSON.stringify(value)); if (value.state === 'unreachable') process.exitCode = 1; return;
    }
    const command = catalog[cmd];
    if (!command && cmd !== 'api') throw inputError('Unknown command. Use help or schema.');
    const allowed = ['state-dir', 'url', 'token-file', 'key', ...(command?.body || cmd === 'api' ? ['file'] : []), ...(command?.required ?? []), ...(command?.options ?? []), ...(cmd === 'api' ? ['path', 'method'] : [])];
    validateOptions(o, [...new Set(allowed)]);
    for (const key of command?.required ?? []) if (!o[key]) throw inputError(`--${key} required`);
    if (command?.body && !command.inputBodyOptional && !o.file) throw inputError('--file required (use - for stdin).');
    const method = command?.method ?? o.method ?? 'GET';
    let path = command?.path ?? o.path;
    if (!path || !/^\/(?!\/)/.test(path) || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw inputError('Use a local API path and supported method.');
    if (path.includes(':id')) path = path.replace(':id', encodeURIComponent(o.id));
    let body = o.file ? await input(o.file) : undefined;
    if (kind === 'worker' && !command?.action && cmd.startsWith('task ') && cmd !== 'task list') {
      if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body))) throw inputError('Task input must be a JSON object.');
      if (body && (Object.hasOwn(body, 'action') || (cmd !== 'task create' && Object.hasOwn(body, 'id')))) throw inputError('Task action and target id come from the command.');
      body = { ...body, action: cmd.split(' ')[1], ...(o.id ? { id: o.id } : {}) };
    }
    if (kind === 'worker' && cmd.startsWith('definition ')) {
      if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body))) throw inputError('Definition input must be a JSON object.');
      if (body && (Object.hasOwn(body, 'action') || (cmd === 'definition delete' && Object.hasOwn(body, 'id')))) throw inputError('Definition action and target id come from the command.');
      if (cmd !== 'definition list') body = { ...body, action: cmd.split(' ')[1], ...(o.id ? { id: o.id } : {}) };
    }
    if (kind === 'worker' && cmd === 'provider check') body = { id: o.id };
    if (cmd === 'file-task get') body = { id: o.id };
    if (kind === 'worker' && command) body = await workerBody(command, body, o);
    let base = o.url, token = process.env.WERK_APP_TOKEN ?? '';
    if (base && !o['token-file'] && !token && cmd !== 'health') throw inputError('Remote --url requires --token-file or WERK_APP_TOKEN. Local secrets are never sent to an explicit URL.');
    if (!base) {
      const live = await status(kind, state);
      if (live.state !== 'running') throw inputError('App is not running. Use start or supply --url with an explicit credential.');
      base = live.url;
      if (kind === 'worker') token = await tokenFile(join(state, 'webview-token'));
      else token = (await readPrivate(join(state, 'component.json'))).adminToken;
    }
    if (o['token-file']) token = await tokenFile(o['token-file']);
    const call = () => request(base, path, token, method, body, o.key);
    const result = command?.wait ? await waitForWorker(call, command.wait, o['timeout-ms']) : await call();
    console.log(kind === 'worker' ? workerOutput(result, o, command) : JSON.stringify(result));
  } catch (error) {
    const { DomainError } = await import(new URL(`../../../src/${kind}/dist/shared/errors.js`, import.meta.url));
    const code = error.exitCode === 2 || (error.status >= 400 && error.status < 500) || (error instanceof DomainError && !['internal', 'unavailable'].includes(error.code)) ? 2 : 1;
    console.error(JSON.stringify({ error: error.message ?? 'Operation failed', ...(typeof error.code === 'string' ? { code: error.code } : {}), ...(Number.isInteger(error.status) ? { status: error.status } : {}), exitCode: code }));
    if (process.send) process.send({ ok: false, error: error.message }, () => { if (process.connected) process.disconnect(); });
    process.exitCode = code;
  }
}
async function tokenFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (process.platform !== 'win32' && stat.mode & 0o077)) throw inputError('Token file must be a private regular file of at most 4096 bytes.');
  const token = (await readFile(path, 'utf8')).trim();
  if (token.length < 24 || /[\r\n]/.test(token)) throw inputError('Invalid token file.');
  return token;
}
