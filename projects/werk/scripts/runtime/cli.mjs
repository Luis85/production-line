import { assertNode, inputError, resolveStateDir, setup, loadSetup, loadConfig } from './config.mjs';
import { startRuntime } from './supervisor.mjs';
import { runtimeStatus, stopRuntime } from './control.mjs';
import { checkArtifacts, freePort, orchestratorReady, workerReady } from './health.mjs';
import { openBrowser } from './browser.mjs';
import { diagnose as maintenanceDiagnose } from './maintenance/backup.mjs';
import { logOutputMode } from './service-logs.mjs';

const help = `Werk local release runtime — Node.js 24.x, mock execution only

node werk.mjs up [--file PATH] [--state-dir PATH] [--no-open] [--no-update] [--json]\n  Start the complete Factory system (defaults to the packaged example YAML).\nnode werk.mjs setup [--state-dir PATH] [--project demo] [--port 3000]
                   [--worker-port 4100] [--workers 1] [--runtime native|docker] [--json]
node werk.mjs start [--state-dir PATH] [--log-output file|stream|both] [--no-open] [--json]
node werk.mjs status|doctor|stop|open [--state-dir PATH] [--json]

node werk.mjs update check|apply|status|enable|disable [--state-dir PATH] [--line] [--json]\nNative downloaded releases check for stable updates before startup. --no-update skips it.\n\nRun setup once, then start. The foreground launcher waits for a healthy orchestrator
and mock worker before opening the Intake page. Ctrl+C or stop drains workers first.
Default private state: .werk beside werk.mjs. Existing settings and credentials are
preserved. Read WERK_ADMIN_TOKEN from credentials.json to sign in; never put it in a URL.
--json produces redacted JSON; start emits lifecycle JSON lines and does not open a browser.
WERK_STATE_DIR supplies the state path; WERK_LOG_OUTPUT supplies start's log output.
Explicit flags override environment values. Empty variables use the defaults.
file (default) keeps rotating private logs; stream emits service_log records to stdout
without local supervisor logs; both does both. --json start output remains JSONL.
This prebuilt release needs no npm install or build. Factory is an optional later service.
Exit 0 success, 2 invalid input/configuration, 1 failed runtime or doctor check.`;
export function parse(arguments_, environment = process.env) {
  const args = [...arguments_], command = args.shift() ?? 'help', options = {};
  if (['--help', '-h', 'help'].includes(command)) { if (args.length) throw inputError('Unexpected help arguments.'); return { command: 'help', options }; }
  if (!['setup', 'start', 'status', 'doctor', 'stop', 'open'].includes(command)) throw inputError('Unknown command. Run node werk.mjs --help.');
  const allowed = new Set(['state-dir', 'json', ...(command === 'start' ? ['no-open', 'log-output'] : []), ...(command === 'setup' ? ['project', 'port', 'worker-port', 'workers', 'runtime'] : [])]);
  while (args.length) {
    const name = args.shift();
    if (!name.startsWith('--') || !allowed.has(name.slice(2)) || Object.hasOwn(options, name.slice(2))) throw inputError('Unknown or repeated option. Run node werk.mjs --help.');
    const key = name.slice(2);
    if (['json', 'no-open'].includes(key)) options[key] = true;
    else { const value = args.shift(); if (!value || value.startsWith('--')) throw inputError(`${name} requires a value.`); options[key] = value; }
  }
  options['state-dir'] ??= environment.WERK_STATE_DIR || undefined;
  if (command === 'start') options['log-output'] = logOutputMode(options['log-output'] ?? (environment.WERK_LOG_OUTPUT || undefined));
  for (const key of ['port', 'worker-port', 'workers']) if (options[key] !== undefined) {
    if (!/^[1-9][0-9]*$/.test(options[key])) throw inputError(`--${key} requires a positive integer.`); options[key] = Number(options[key]);
  }
  return { command, options };
}
async function nativeConfig(stateDir) {
  const config = await loadConfig(stateDir);
  if (config.runtime !== 'native') throw inputError('This state belongs to Docker. Use the werk-docker launcher, not the native lifecycle commands.');
  return config;
}
async function nativeSetup(stateDir) {
  const loaded = await loadSetup(stateDir);
  if (loaded.config.runtime !== 'native') throw inputError('This state belongs to Docker. Use the werk-docker launcher, not the native lifecycle commands.');
  return loaded;
}
export async function doctor(stateDir) {
  const checks = []; let loaded, status = { state: 'unknown' };
  const check = async (name, task) => { try { await task(); checks.push({ name, ok: true }); } catch (error) { checks.push({ name, ok: false, message: error.message }); } };
  await check('release', checkArtifacts);
  try { checks.push(...(await maintenanceDiagnose(stateDir)).checks.filter(item => item.name === 'disk-space' || item.name.startsWith('lock:'))); } catch { checks.push({ name: 'disk-space', ok: false, message: 'Cannot inspect storage. Check mount availability and state directory permissions.' }); }
  await check('configuration', async () => { loaded = await nativeSetup(stateDir); });
  if (loaded) {
    await check('supervisor', async () => { status = await runtimeStatus(stateDir); if (status.state === 'unreachable') throw Error(status.action); });
    if (status.state === 'running') {
      await check('orchestrator', async () => { if (!await orchestratorReady(loaded.config, loaded.credentials)) throw Error('Expected authenticated orchestrator is not healthy.'); });
      for (let n = 1; n <= loaded.config.workers; n++) await check(`worker-${n}`, async () => { if (!await workerReady(loaded.config, loaded.credentials, stateDir, n)) throw Error('Expected enrolled worker is not healthy. Check its status view for disconnected state, verify orchestrator credentials/connectivity, then restart through the owning launcher. Preserve identity.json and pending evidence.'); });
    } else if (status.state === 'stopped') {
      await check('ports', async () => { for (const port of [loaded.config.orchestratorPort, ...Array.from({ length: loaded.config.workers }, (_, n) => loaded.config.workerPort + n)]) await freePort(port); });
    }
  }
  return { ok: checks.every(check => check.ok), state: status.state, checks, next: status.state === 'stopped' ? 'Run node werk.mjs start with the same --state-dir.' : 'Use status or inspect private runtime logs for lifecycle details.' };
}
export async function main(arguments_ = process.argv.slice(2), { stdout = value => console.log(value), stderr = value => console.error(value), opener = openBrowser, environment = process.env } = {}) {
  let jsonMode = arguments_.includes('--json');
  try {
    assertNode(); const { command, options } = parse(arguments_, environment); jsonMode = Boolean(options.json);
    if (command === 'help') { stdout(help); return 0; }
    const stateDir = resolveStateDir(options['state-dir']);
    const print = value => stdout(JSON.stringify(value));
    if (command === 'start') {
      await startRuntime(stateDir, { noOpen: jsonMode || Boolean(options['no-open']), opener, environment, logOutput: options['log-output'], emit: value => {
        if (jsonMode) print({ ok: true, ...value });
        else if (value.event === 'service_log' && options['log-output'] !== 'file') print(value);
        else if (value.event === 'ready') stdout(`Werk is ready: ${value.url}\nMock workers: ${value.workers.length}. Sign in using WERK_ADMIN_TOKEN from ${stateDir}/credentials.json.\nCtrl+C stops this runtime; use node werk.mjs stop from another terminal.`);
        else if (value.event === 'browser' && !value.opened) stderr(`${value.reason} ${value.url}`);
        else if (['starting', 'stopping', 'stopped'].includes(value.event)) stdout(`Werk ${value.event}.`);
      } }); return 0;
    }
    let result;
    if (command === 'setup') result = { ok: true, ...await setup({ stateDir, project: options.project, port: options.port, workerPort: options['worker-port'], workers: options.workers, runtime: options.runtime ?? 'native' }) };
    else if (command === 'doctor') result = await doctor(stateDir);
    else {
      await nativeConfig(stateDir);
      if (command === 'stop') result = { ok: true, ...await stopRuntime(stateDir) };
      else {
        const status = await runtimeStatus(stateDir);
        if (status.state === 'unreachable') throw Error(status.action);
        if (command === 'open') {
          if (status.state !== 'running') throw inputError('Runtime is not ready. Start it before opening the browser.');
          result = { ok: true, ...await opener(status.url) };
        } else result = { ok: true, ...status };
      }
    }
    if (jsonMode) print(result);
    else if (command === 'setup') stdout(`Werk ${result.created ? 'configured' : 'configuration preserved'} at ${stateDir}.\n${result.config.runtime === 'docker' ? 'Use the werk-docker launcher to start this Docker runtime.' : 'Run node werk.mjs start' + (options['state-dir'] ? ' --state-dir ' + JSON.stringify(stateDir) : '') + '.'}`);
    else if (command === 'doctor') stdout(result.checks.map(check => `${check.ok ? 'OK' : 'FAIL'} ${check.name}${check.message ? ': ' + check.message : ''}`).join('\n') + '\n' + result.next);
    else stdout(result.url ? `${result.state ?? (result.opened ? 'Opened' : 'Open manually')}: ${result.url}` : `Werk ${result.state}.`);
    return result.ok ? 0 : 1;
  } catch (error) {
    const exitCode = error.exitCode === 2 ? 2 : 1;
    const result = { ok: false, error: { code: exitCode === 2 ? 'INVALID_CONFIGURATION' : 'RUNTIME_FAILED', message: error.message } };
    if (jsonMode) stdout(JSON.stringify(result)); else stderr(result.error.message);
    return exitCode;
  }
}
