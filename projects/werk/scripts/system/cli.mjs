import { join, resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { assertNode, inputError, releaseRoot } from '../runtime/config.mjs';
import { doctor as lineDoctor } from '../runtime/cli.mjs';
import { freePort } from '../runtime/health.mjs';
import { loadDefinition, planDefinition } from './definition.mjs';
import { loadSystem, sameDefinition, setupSystem, resolveSystemStateDir, factoryCredentials } from './state.mjs';
import { startSystem, systemStatus, stopSystem } from './supervisor.mjs';
import { factoryRequest } from './bootstrap.mjs';
import { formatPlan } from './plan-view.mjs';
import { diagnose as maintenanceDiagnose } from '../runtime/maintenance/backup.mjs';
import { logOutputMode } from '../runtime/service-logs.mjs';

export function parse(args, environment = process.env) {
  args = [...args]; const command = args.shift() ?? 'help', options = {};
  if (['help', '--help', '-h'].includes(command)) return { command: 'help', options };
  if (!['plan', 'setup', 'up', 'start', 'status', 'doctor', 'stop'].includes(command)) throw inputError('Unknown system command. Run node werk.mjs system --help.');
  while (args.length) {
    const flag = args.shift(), key = flag?.slice(2);
    if (!flag?.startsWith('--') || !['file', 'state-dir', 'environment', 'json', ...(['start', 'up'].includes(command) ? ['no-open', 'log-output'] : [])].includes(key) || Object.hasOwn(options, key)) throw inputError('Unknown or repeated system option.');
    if (['json', 'no-open'].includes(key)) options[key] = true;
    else { const value = args.shift(); if (!value || value.startsWith('--')) throw inputError(`${flag} requires a value.`); options[key] = value; }
  }
  options.file ??= environment.WERK_SYSTEM_FILE || undefined;
  options['state-dir'] ??= environment.WERK_STATE_DIR || undefined;
  if (['start', 'up'].includes(command)) options['log-output'] = logOutputMode(options['log-output'] ?? (environment.WERK_LOG_OUTPUT || undefined));
  if (!options.file && (!['status', 'doctor', 'stop'].includes(command) || !options['state-dir'])) throw inputError('Use --file PATH, or --state-dir PATH for status/doctor/stop on saved configuration.');
  if (options.environment && !['native', 'docker'].includes(options.environment)) throw inputError('--environment must be native or docker.');
  return { command, options };
}
export async function doctorSystem(stateDir, definition) {
  const checks = [], status = await systemStatus(stateDir); let credentials;
  async function check(name, operation) { try { await operation(); checks.push({ name, ok: true }); } catch (error) { checks.push({ name, ok: false, message: error.message }); } }
  try { checks.push(...(await maintenanceDiagnose(stateDir)).checks.filter(item => item.name === 'disk-space' || item.name.startsWith('lock:'))); } catch { checks.push({ name: 'disk-space', ok: false, message: 'Cannot inspect storage. Check the state mount and permissions.' }); }
  await check('factory-release', async () => { try { for (const file of ['server.js', 'public/index.html']) await access(join(releaseRoot, 'src/factory/dist/factory', file)); } catch { throw inputError('Factory runtime is incomplete. Extract a complete prebuilt release.'); } });
  await check('system-supervisor', async () => { if (status.state === 'unreachable') throw Error(status.action); if (['starting', 'stopping'].includes(status.state)) throw Error('System is transitioning. Retry after lifecycle completion.'); });
  await check('credentials', async () => { credentials = await factoryCredentials(stateDir, definition); });
  if (status.state === 'running' && credentials) await check('factory', async () => { if ((await factoryRequest(`http://127.0.0.1:${definition.factory.port}`, credentials.adminToken, '/v1/factories')).status !== 200) throw Error('Expected authenticated Factory is not healthy.'); });
  if (status.state === 'stopped') await check('factory-port', () => freePort(definition.factory.port));
  for (const line of definition.productionLines) await check(`line-${line.id}`, async () => { const result = await lineDoctor(join(stateDir, 'lines', line.id)); if (!result.ok || (status.state === 'running' && result.state !== 'running')) throw Error('Line checks failed. Run the single-line doctor with its private state directory.'); });
  return { ok: checks.every(item => item.ok), state: status.state, checks };
}
export async function main(args = process.argv.slice(3), { stdout = value => console.log(value), stderr = value => console.error(value), opener, environment = process.env } = {}) {
  const json = args.includes('--json');
  try {
    assertNode(); const { command, options } = parse(args, environment);
    if (command === 'help') { stdout('node werk.mjs system plan|setup|up|start|status|doctor|stop --file PATH [--state-dir PATH] [--environment native|docker] [--json]\nup/start run in the foreground; --no-open suppresses the browser. JSON also suppresses opening. --log-output file|stream|both selects rotating private logs (default), stdout service_log records without local supervisor logs, or both.\nWERK_STATE_DIR and WERK_SYSTEM_FILE supply path defaults; WERK_LOG_OUTPUT supplies start/up log output. Explicit flags win; empty variables use defaults.\nstatus/doctor/stop may use --state-dir without --file. Tasks are created through each line API/UI after startup.'); return 0; }
    let definition = options.file ? await loadDefinition(options.file, { environment: options.environment }) : undefined;
    const stateDir = definition ? resolveSystemStateDir(definition, options['state-dir']) : resolve(options['state-dir']);
    if (command === 'plan') { stdout(json ? JSON.stringify({ ok: true, stateDir, plan: planDefinition(definition) }) : formatPlan(planDefinition(definition), { stateDir, file: options.file })); return 0; }
    if (!definition) definition = await loadSystem(stateDir);
    if (definition.environment !== 'native') throw inputError('This definition belongs to Docker. Use werk-docker system with the same --file and --state-dir; native commands never start Docker state.');
    let result;
    if (['setup', 'up'].includes(command)) result = { ok: true, ...await setupSystem(definition, { stateDir }) };
    else {
      const saved = await loadSystem(stateDir);
      if (command === 'start') sameDefinition(saved, definition);
      else if (saved.id !== definition.id) throw inputError('Selected file and saved system IDs differ. Use --state-dir alone for maintenance.');
      definition = saved;
      if (definition.environment !== 'native') throw inputError('Saved state belongs to Docker. Use the Docker system launcher.');
    }
    if (['start', 'up'].includes(command)) {
      await startSystem(stateDir, { noOpen: json || Boolean(options['no-open']), opener, environment, logOutput: options['log-output'], emit: value => {
        if (json) stdout(JSON.stringify({ ok: true, ...value }));
        else if (value.event === 'service_log' && options['log-output'] !== 'file') stdout(JSON.stringify(value));
        else if (value.event === 'ready') stdout(`Werk system is ready: ${value.url}\nFactory sign-in: WERK_FACTORY_ADMIN_TOKEN in ${join(stateDir, 'factory/credentials.json')}.\nCtrl+C drains workers and lines before Factory.`);
        else if (value.event === 'browser' && !value.opened) stderr(`${value.reason} ${value.url}`);
        else if (['starting', 'stopping', 'stopped'].includes(value.event)) stdout(`Werk system ${value.event}.`);
      } }); return 0;
    }
    if (command === 'status') { const status = await systemStatus(stateDir); if (status.state === 'unreachable') throw Error(status.action); result = { ok: true, ...status, definition: planDefinition(definition) }; }
    else if (command === 'stop') result = { ok: true, ...await stopSystem(stateDir) };
    else if (command === 'doctor') result = await doctorSystem(stateDir, definition);
    stdout(json ? JSON.stringify(result) : command === 'setup' ? `Werk system configuration ${result.created ? 'created' : 'preserved'}: ${stateDir}\nNext: run system start with the same --file and --state-dir options.` : command === 'doctor' ? result.checks.map(item => `${item.ok ? 'OK' : 'FAIL'} ${item.name}${item.message ? ': ' + item.message : ''}`).join('\n') : `Werk system ${result.state}.`);
    return result.ok ? 0 : 1;
  } catch (error) { const code = error.exitCode === 2 ? 2 : 1; const result = { ok: false, error: { code: code === 2 ? 'INVALID_CONFIGURATION' : 'RUNTIME_FAILED', message: error.message } }; if (json) stdout(JSON.stringify(result)); else stderr(result.error.message); return code; }
}
