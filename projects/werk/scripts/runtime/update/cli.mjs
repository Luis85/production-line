import { join, resolve } from 'node:path';
import { releaseRoot, assertNode } from '../config.mjs';
import { invocationFor } from './launcher.mjs';
import { storeFor, manifest, exists, selection, save, lock, activeRoot } from './store.mjs';
import { check, apply, recover } from './manager.mjs';

const help = `node werk.mjs update check|apply|status|enable|disable [--file PATH] [--state-dir PATH] [--line] [--json]
node werk.mjs update rollback --to NEW_STATE_DIRECTORY [--file PATH] [--state-dir PATH] [--line] [--json]
Native releases check stable GitHub releases before up/start by default. Existing state
is backed up before activation. Running systems are never interrupted. --no-update on
up/start or WERK_AUTO_UPDATE=0 skips the network check; disable persists that choice.
Use --line for a single-line runtime; otherwise defaults match node werk.mjs up.
rollback restores a verified pre-update snapshot into a NEW directory and identifies
the matching previous release. Original state is preserved. No automatic data downgrade.
Source checkouts and Docker/managed-VM deployments use their existing manual upgrade flow.`;
export function parse(args) {
  const values = [...args], command = values.shift() ?? 'help', options = {};
  if (['--help', '-h', 'help'].includes(command)) { if (values.length) throw Error('Unexpected help arguments.'); return { command: 'help', options }; }
  if (!['check', 'apply', 'status', 'enable', 'disable', 'rollback'].includes(command)) throw Error('Unknown update command. Use node werk.mjs update --help.');
  while (values.length) {
    const flag = values.shift(), key = flag?.slice(2);
    if (!flag?.startsWith('--') || !['file','state-dir','line','json', ...(command === 'rollback' ? ['to'] : [])].includes(key) || Object.hasOwn(options, key)) throw Error('Unknown or repeated update option.');
    if (['line','json'].includes(key)) options[key] = true;
    else { const value = values.shift(); if (!value || value.startsWith('--')) throw Error(`${flag} requires a path.`); options[key] = value; }
  }
  if (options.line && options.file) throw Error('--file applies to Factory systems; omit --line.');
  if (command === 'rollback' && !options.to) throw Error('rollback requires --to NEW_STATE_DIRECTORY.');
  return { command, options };
}
export async function main(args, { stdout = console.log, stderr = console.error, environment = process.env, baseRoot = releaseRoot, fetcher = fetch } = {}) {
  let unlock;
  try {
    assertNode(); const { command, options } = parse(args);
    if (command === 'help') { stdout(help); return 0; }
    if (environment.WERK_UPDATES === 'external') throw Error('This deployment is externally managed. Use its pinned-release deployment procedure.');
    if (!await exists(join(baseRoot, 'release-manifest.json'))) throw Error('Updates require an extracted release. Source checkouts use Git.');
    await manifest(baseRoot);
    const selector = options.line ? ['status'] : options['state-dir'] && !options.file && !environment.WERK_SYSTEM_FILE ? ['system', 'status'] : ['up'];
    for (const key of ['file','state-dir']) if (options[key]) selector.push('--' + key, options[key]);
    const invocation = await invocationFor(baseRoot, selector, environment), store = storeFor(baseRoot, invocation.stateDir);
    if (!['status','check'].includes(command)) unlock = await lock(store, 'update ' + command);
    let result;
    if (command === 'check') result = await check(store, { fetcher });
    else if (command === 'apply') result = await apply(store, invocation, { fetcher });
    else if (command === 'rollback') result = await recover(store, resolve(options.to));
    else {
      const record = await selection(store);
      if (['enable','disable'].includes(command)) { record.automatic = command === 'enable'; await save(store, record); }
      result = { ok: true, current: (await manifest(await activeRoot(store, record))).version, automatic: record.automatic,
        stateDir: store.stateDir, previous: record.previous, backup: record.backup ? join(store.backups, record.backup) : null };
    }
    stdout(JSON.stringify(result)); return 0;
  } catch (error) {
    const message = error.cmd ? 'Candidate preflight failed. The previous version and verified backup were retained.' : error.message;
    if (args.includes('--json')) stdout(JSON.stringify({ ok: false, error: { code: 'UPDATE_FAILED', message } })); else stderr(message);
    return 1;
  } finally { await unlock?.(); }
}
