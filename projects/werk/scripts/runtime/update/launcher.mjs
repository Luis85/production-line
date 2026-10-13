import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseSystem } from '../../system/cli.mjs';
import { loadDefinition } from '../../system/definition.mjs';
import { parse as parseLine } from '../cli.mjs';
import { storeFor, selection, activeRoot, manifest, exists, lock } from './store.mjs';
import { apply } from './manager.mjs';

export async function invocationFor(baseRoot, arguments_, environment = process.env) {
  const args = [...arguments_], quick = args[0] === 'up', kind = quick || args[0] === 'system' ? 'system' : 'line';
  const forwarded = kind === 'system' && !quick ? args.slice(1) : args;
  const disabled = forwarded.includes('--no-update');
  if (disabled) {
    if (!['up', 'start'].includes(forwarded[0]) || forwarded.filter(x => x === '--no-update').length !== 1) throw Error('--no-update is valid once on native up/start only.');
    forwarded.splice(forwarded.indexOf('--no-update'), 1);
  }
  if (quick && !forwarded.includes('--file') && !environment.WERK_SYSTEM_FILE) forwarded.push('--file', join(baseRoot, 'examples/system.yaml'));
  const { command, options } = (kind === 'system' ? parseSystem : parseLine)(forwarded, environment);
  if (command === 'help') return { kind, command, args: forwarded, disabled };
  let stateDir;
  if (kind === 'system') {
    const definition = options.file ? await loadDefinition(options.file, { environment: options.environment }) : undefined;
    if (definition?.environment === 'docker') throw Error('Use the Docker launcher for Docker definitions. Automatic updates manage native installations.');
    stateDir = options['state-dir'] ? resolve(options['state-dir']) : join(baseRoot, '.werk-system', definition.id);
  } else stateDir = options['state-dir'] ? resolve(options['state-dir']) : join(baseRoot, '.werk');
  // Freeze defaults before loading another release. Relative user paths remain
  // relative to this caller; the packaged default YAML stays with the base launcher.
  const normalized = [command];
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || key === 'state-dir') continue;
    normalized.push('--' + key);
    if (value !== true) normalized.push(String(value));
  }
  normalized.push('--state-dir', stateDir);
  return { kind, command, args: normalized, stateDir, disabled };
}
export async function runNative(baseRoot, args, { environment = process.env, stdout = console.log, stderr = console.error, fetcher = fetch } = {}) {
  let unlock;
  const json = args.includes('--json');
  const notify = (event, details) => json ? stdout(JSON.stringify({ ok: true, event, ...details })) : stderr(details.message ?? `Werk ${event}: ${details.version ?? ''}`);
  try {
    const invocation = await invocationFor(baseRoot, args, environment);
    const packaged = environment.WERK_UPDATES !== 'external' && await exists(join(baseRoot, 'release-manifest.json'));
    let root = baseRoot;
    if (packaged && invocation.stateDir && !['plan'].includes(invocation.command)) {
      const store = storeFor(baseRoot, invocation.stateDir);
      if (['up', 'start', 'setup'].includes(invocation.command)) unlock = await lock(store, invocation.command);
      const record = await selection(store);
      root = await activeRoot(store, record);
      if (['up', 'start'].includes(invocation.command) && record.automatic && !invocation.disabled && environment.WERK_AUTO_UPDATE !== '0') {
        try {
          const result = await apply(store, invocation, { fetcher, log: message => notify('update_progress', { message }) });
          if (result.updated) notify('updated', result);
        } catch (error) {
          // Integrity/compatibility/network/backup failures leave selection untouched.
          // Continue only the previously verified release, never a partial candidate.
          notify('update_skipped', { message: 'Update was not applied: ' + (error.cmd ? 'Candidate preflight failed.' : error.message) + ' Starting the installed version.' });
        }
        root = await activeRoot(store);
      }
    }
    const { main } = await import(pathToFileURL(join(root, 'scripts', invocation.kind === 'system' ? 'system/cli.mjs' : 'runtime/cli.mjs')).href);
    return await main(invocation.args, { environment, stdout, stderr });
  } catch (error) {
    if (json) stdout(JSON.stringify({ ok: false, error: { code: 'UPDATE_OR_RUNTIME_FAILED', message: error.message } }));
    else stderr(error.message);
    return error.exitCode === 2 ? 2 : 1;
  } finally { await unlock?.(); }
}
