import { fileURLToPath } from 'node:url';
import { readFile, lstat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { assertNode, inputError, readPrivate } from '../config.mjs';
import { initializeWorker, projectDefaults } from './project.mjs';
import { setupFeatureAuthoring, runFeatureAuthoring } from './feature-authoring.mjs';
import { isYamlProfile, definitionName } from './definition-input.mjs';
import { workerBody, workerOutput, waitForWorker } from './worker-commands.mjs';
import { commands } from './commands.mjs';
import { loadEnvironment, environmentDefaults, seedEnvironment } from './environment.mjs';
import { run, start, status, stop, stateDirectory } from './lifecycle.mjs';
import { updateCommands, updateHelp, checkUpdate, updateStatus, applyUpdate, rollbackUpdate, restoreBackup } from './update.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
export async function main(kind, argv = process.argv.slice(2)) {
  const { args, validateOptions, input, integer } = await import(new URL(`../../../src/${kind}/dist/shared/cli.js`, import.meta.url));
  const { request } = await import(new URL(`../../../src/${kind}/dist/shared/http/client.js`, import.meta.url));
  try {
    assertNode();
    // JSON is the default; accept a familiar explicit flag without a value.
    const dryRun = argv.includes('--dry-run');
    if (argv.filter(value => value === '--dry-run').length > 1) throw inputError('--dry-run must occur once.');
    // Update switches are valueless like --json; the shared parser requires option values.
    const switches = argv[0] === 'update' ? ['--stop', '--no-restart'] : [];
    if (switches.some(flag => argv.filter(value => value === flag).length > 1)) throw inputError('Update switches must occur once.');
    const flags = Object.fromEntries(switches.filter(flag => argv.includes(flag)).map(flag => [flag.slice(2), true]));
    const parsed = args(argv.filter(value => value !== '--json' && value !== '--dry-run' && !switches.includes(value))), cmd = parsed.commands.join(' ');
    let o = parsed.options;
    const catalog = commands(kind);
    if (dryRun && !(kind === 'worker' && ['integrations sync', 'definition update', 'worktrees prune', 'shared setup'].includes(cmd))) throw inputError('--dry-run is supported only by integrations sync, definition update, worktrees prune and shared setup.');
    if (!cmd || o.help || cmd === 'help' || cmd === 'schema') {
      console.log(JSON.stringify({ schemaVersion: 1, application: kind, node: '24.x', usage: `node bin/apps/${kind}/cli.mjs COMMAND [--state-dir PATH] [--json]`, lifecycle: { run: 'Foreground; Ctrl+C drains and closes', start: 'Detached; returns when ready', status: 'Authenticated process identity and webview URL', stop: 'Graceful authenticated shutdown; preserves state' }, environment: { initialize: 'env init [--project-dir PATH] [--state-dir PATH]', file: '.env in the project directory (current directory by default)', precedence: 'Process environment overrides .env; explicit command options override environment defaults', credentials: 'Initialization returns file paths and key names only. Read the private .env locally.' }, launchOptions: ['state-dir', 'host', 'port', 'project-dir', ...(kind === 'worker' ? ['config', 'url', 'features-dir', 'poll-ms', 'mock-ms'] : kind === 'orchestrator' ? ['project'] : [])], clientOptions: ['state-dir', 'project-dir', 'url', 'token-file', 'file', 'id', 'key', 'request-timeout-ms'], requestTimeout: 'Each API call waits 10 s by default and 120 s for Git operations such as shared sync; --request-timeout-ms 1000–600000 overrides it. A timeout means the client stopped waiting, not that the operation was cancelled.', input: 'JSON --file PATH or --file - (stdin), maximum 64 KiB (definition preview|import|update also take a YAML --file PATH.yaml or PATH.yml) unless the command documents a larger import limit. Local credentials resolved privately from state; remote URL requires explicit token-file or WERK_APP_TOKEN.', commands: catalog, ...(kind === 'worker' ? { executionPolicy: { environment: 'WERK_WORKER_MAX_RUNTIME_MS', scope: 'Local model invocations; frozen per dispatch, not total session age or polling timeout', defaultMs: 21600000, minimumMs: 1000, maximumMs: 86400000, precedence: 'Validated environment override, then saved private settings, then default', inspect: 'settings get: execution and executionSource; resource status: admission policy', toolCalls: { default: 128, minimum: 1, maximum: 512 }, commandDurationMs: { default: 300000, minimum: 1000, maximum: 3600000 }, update: 'settings set with execution and expectedToolBudget; environment override locks maxRuntimeMs only' }, requestGates: { inspect: 'request get and request events', completion: 'Model completion, Request Done and applied/merged changes are distinct', dispatch: 'Inspect current-generation dispatch state; identical command receipt replay never admits new work', recovery: 'If not admitted and still ready, read current revision and issue a new guarded execute with a new key', guide: 'docs/how-to/rework-worker-requests.md' }, projectSetup: { command: 'init [--project-dir PATH] [--features-dir features] [--provider codex-cli] [--port 4100]', sharedSetup: 'shared setup --file setup.json [--dry-run] connects the generated team template to committed Git intake; provider and repository selection are explicit', featureFolder: 'feature folder get | plan --path requests/features | set --path requests/features', template: 'feature template (prints Markdown without a running worker)', authoring: 'feature setup | feature author create | feature author validate | feature author ready (offline; no running worker required)', npm: 'npm --prefix bin/apps/worker run lists scripts; append -- before command options. No npm install required.', behavior: 'Installs a project-local app, config, authoring kit, npm entrypoints and Docker Compose file; preserves existing files and project package.json.' } } : {}), api: 'api --path /local/path [--method GET|POST|PUT|PATCH|DELETE] [--file PATH|-] [--key KEY]', update: updateHelp, exitCodes: { 0: 'success', 1: 'operational failure', 2: 'input/API rejection' } }, null, 2)); return;
    }
    if (parsed.commands[0] === 'update') {
      const spec = updateCommands[cmd];
      if (!spec) throw inputError('Unknown update command. Use update check|status|apply|rollback|restore.');
      validateOptions(o, spec.options);
      for (const name of Object.keys(flags)) if (!spec.flags.includes(name)) throw inputError(`--${name} is not valid for ${cmd}.`);
      if (cmd === 'update check') { console.log(JSON.stringify(await checkUpdate(kind, root, o))); return; }
      if (cmd === 'update restore') {
        if (!o.from || !o.to) throw inputError('--from BACKUP and --to NEW_STATE_DIRECTORY required.');
        console.log(JSON.stringify(await restoreBackup(o.from, o.to))); return;
      }
    }
    if (kind === 'worker' && cmd === 'feature setup') {
      validateOptions(o, ['project-dir', 'features-dir', 'provider', 'if-match']);
      console.log(JSON.stringify(await setupFeatureAuthoring(root, o['project-dir'] ?? process.cwd(), { ...(o['features-dir'] === undefined ? {} : { featuresDirectory: o['features-dir'] }), ...(o.provider === undefined ? {} : { provider: o.provider }), ...(o['if-match'] === undefined ? {} : { ifMatch: o['if-match'] }) }))); return;
    }
    if (kind === 'worker' && ['feature author create', 'feature author validate', 'feature author ready'].includes(cmd)) {
      const action = cmd.split(' ')[2];
      validateOptions(o, ['project-dir', ...(action === 'create' ? ['name', 'title'] : ['file', ...(action === 'ready' ? ['if-match'] : [])])]);
      const result = await runFeatureAuthoring(root, o['project-dir'] ?? process.cwd(), [action, ...Object.entries(o).filter(([key]) => key !== 'project-dir').flatMap(([key, value]) => ['--' + key, value])]);
      console.log(JSON.stringify(result)); if (result.valid === false) process.exitCode = 2; return;
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
    if (cmd === 'env init') {
      validateOptions(o, ['project-dir', 'state-dir']);
      const directory = resolve(o['project-dir'] ?? process.cwd());
      const selected = o['state-dir'] === undefined ? undefined : await stateDirectory(kind, root, o['state-dir']);
      console.log(JSON.stringify(await seedEnvironment(kind, directory, { ...(selected ? { stateDirectory: selected, defaults: { 'state-dir': relative(directory, selected) || '.' } } : {}) }))); return;
    }
    if (kind === 'worker' && cmd === 'init') { validateOptions(o, ['project-dir', 'features-dir', 'provider', 'port']); console.log(JSON.stringify(await initializeWorker(root, o))); return; }
    if (kind === 'worker' && cmd === 'feature template') { validateOptions(o, []); const { featureTemplate } = await import(new URL('../../../src/worker/dist/worker/infrastructure/features/document.js', import.meta.url)); process.stdout.write(featureTemplate); return; }
    const launching = ['run', '_run', 'start'].includes(cmd), recovery = ['status', 'stop', 'update status', 'update apply', 'update rollback'].includes(cmd);
    // Explicit state recovery remains available even when project environment files need repair.
    if (!(recovery && o['state-dir'] !== undefined) && !(o.url && !launching)) {
      const directory = resolve(o['project-dir'] ?? process.cwd());
      await loadEnvironment(kind, directory);
      const defaults = environmentDefaults(kind, process.env, directory);
      o = launching ? { ...defaults, ...o } : { ...(defaults['state-dir'] ? { 'state-dir': defaults['state-dir'] } : {}), ...o };
      if (kind === 'worker') {
        const project = await projectDefaults(o, launching);
        o = launching ? project : { ...o, 'state-dir': project['state-dir'] ?? o['state-dir'] };
      }
      if (o['state-dir'] === undefined) o = { ...o, 'state-dir': join(directory, '.werk', kind) };
    }
    const state = await stateDirectory(kind, root, o['state-dir']);
    if (['update status', 'update apply', 'update rollback'].includes(cmd)) {
      const options = { ...o, ...flags }, context = { projectDir: o['project-dir'], log: message => console.error(JSON.stringify({ event: 'update_progress', message })) };
      const value = cmd === 'update status' ? await updateStatus(kind, root, state) : await (cmd === 'update apply' ? applyUpdate : rollbackUpdate)(kind, root, state, options, context);
      console.log(JSON.stringify(value)); if (value.ok === false) process.exitCode = 1; return;
    }
    if (['run', '_run', 'start'].includes(cmd)) {
      validateOptions(o, ['state-dir', 'host', 'port', 'project-dir', ...(kind === 'worker' ? ['config', 'url', 'features-dir', 'poll-ms', 'mock-ms'] : kind === 'orchestrator' ? ['project'] : [])]);
      if (o.port !== undefined) integer(o.port, 'port', 0, 65535);
      if (cmd === '_run' && !process.send) throw inputError('Internal launch requires an IPC parent. Use run or start.');
      if (cmd === 'start') console.log(JSON.stringify(await start(kind, state, root, argv.slice(1))));
      // Preserve resolved non-secret launch options, including defaults supplied by the caller's environment.
      // Credentials remain in private application state or the environment; they are never launch arguments.
      else await run(kind, state, root, o, cmd === '_run', { mode: cmd === '_run' ? 'start' : 'run', cwd: process.cwd(),
        args: Object.entries({ ...o, 'state-dir': state }).filter(([, value]) => value !== undefined).flatMap(([key, value]) => ['--' + key, value]),
        ...(kind === 'worker' && process.env.WERK_WORKER_MAX_RUNTIME_MS !== undefined ? { environment: { WERK_WORKER_MAX_RUNTIME_MS: process.env.WERK_WORKER_MAX_RUNTIME_MS } } : {}) });
      return;
    }
    if (cmd === 'status' || cmd === 'stop') {
      validateOptions(o, ['state-dir', 'project-dir']);
      const value = await (cmd === 'status' ? status : stop)(kind, state);
      console.log(JSON.stringify(value)); if (value.state === 'unreachable') process.exitCode = 1; return;
    }
    const command = catalog[cmd];
    if (!command && cmd !== 'api') throw inputError('Unknown command. Use help or schema.');
    const allowed = ['state-dir', 'project-dir', 'url', 'token-file', 'key', 'request-timeout-ms', ...(command?.body || cmd === 'api' ? ['file'] : []), ...(command?.required ?? []), ...(command?.options ?? []), ...(cmd === 'api' ? ['path', 'method'] : [])];
    validateOptions(o, [...new Set(allowed)]);
    for (const key of command?.required ?? []) if (!o[key]) throw inputError(`--${key} required`);
    if (command?.body && !command.inputBodyOptional && !o.file) throw inputError('--file required (use - for stdin).');
    const method = command?.method ?? o.method ?? 'GET';
    let path = command?.path ?? o.path;
    if (!path || !/^\/(?!\/)/.test(path) || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw inputError('Use a local API path and supported method.');
    if (path.includes(':id')) path = path.replace(':id', encodeURIComponent(o.id));
    const yamlProfile = kind === 'worker' && isYamlProfile(cmd, o.file);
    let body = o.file ? (yamlProfile ? { yaml: await input(o.file, command?.inputLimit, { text: true }) } : await input(o.file, command?.inputLimit)) : undefined;
    if (kind === 'worker' && !command?.action && cmd.startsWith('task ') && cmd !== 'task list') {
      if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body))) throw inputError('Task input must be a JSON object.');
      if (body && (Object.hasOwn(body, 'action') || (cmd !== 'task create' && Object.hasOwn(body, 'id')))) throw inputError('Task action and target id come from the command.');
      body = { ...body, action: cmd.split(' ')[1], ...(o.id ? { id: o.id } : {}) };
    }
    if (kind === 'worker' && cmd.startsWith('definition ')) {
      if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body))) throw inputError('Definition input must be a JSON object.');
      if (body && (Object.hasOwn(body, 'action') || (['definition delete', 'definition ref', 'definition update'].includes(cmd) && ['id', 'ref', 'revision', 'dryRun'].some(key => Object.hasOwn(body, key))))) throw inputError('Definition action, target, revision and dry run come from the command.');
      body = definitionName(cmd, body, o, yamlProfile);
      if (cmd === 'definition update' && !dryRun && !o['if-match']) throw inputError('--if-match REVISION required; read it with definition list or definition update --dry-run.');
      if (cmd !== 'definition list') body = { ...body, action: cmd.split(' ')[1], ...(o.id ? { id: o.id } : {}), ...(['definition ref', 'definition update'].includes(cmd) ? { ref: o.ref } : {}), ...(o['if-match'] ? { revision: o['if-match'] } : {}), ...(cmd === 'definition update' && dryRun ? { dryRun: true } : {}) };
    }
    if (kind === 'worker' && cmd === 'provider check') body = { id: o.id };
    if (cmd === 'file-task get') body = { id: o.id };
    if (kind === 'worker' && command) body = await workerBody(command, body, o);
    if (kind === 'worker' && cmd === 'worktrees prune' && dryRun) body = { ...body, dryRun: true };
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
    const timeoutMs = o['request-timeout-ms'] === undefined ? command?.timeoutMs : integer(o['request-timeout-ms'], '--request-timeout-ms', 1000, 600000);
    if (kind === 'worker' && cmd === 'shared setup') {
      if (o.key) throw inputError('shared setup uses each configuration revision; it does not accept --key.');
      const { setupSharedIntake } = await import('./shared-setup.mjs');
      console.log(JSON.stringify(await setupSharedIntake(body, (method, path, body) => request(base, path, token, method, body, undefined, timeoutMs), { dryRun })));
      return;
    }
    const call = () => request(base, path, token, method, body, o.key, timeoutMs);
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
