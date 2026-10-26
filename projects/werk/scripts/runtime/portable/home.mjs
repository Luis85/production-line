import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { main } from './cli.mjs';
import { status, stop } from './lifecycle.mjs';
import { selectWorkerHome, inspectWorkerHome } from './home-layout.mjs';
import { assertNode, inputError } from '../config.mjs';
import { openBrowser } from '../browser.mjs';

const applicationRoot = fileURLToPath(new URL('../../../', import.meta.url));
function argumentsFor(argv) {
  if (argv[0] === 'update') {
    const forwarded = [], values = {};
    for (let index = 1; index < argv.length; index++) {
      if (argv[index] !== '--home') { forwarded.push(argv[index]); continue; }
      const value = argv[++index];
      if (values['--home'] || !value || value.startsWith('--') || /[\x00-\x1f\x7f]/.test(value)) throw inputError('Use --home once with a folder path.');
      values['--home'] = value;
    }
    return { command: 'update', values, updateArgs: forwarded, help: false, open: false };
  }
  const values = {}, switches = new Set(), commands = [];
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (['--help', '--no-open', '--json'].includes(item)) {
      if (switches.has(item)) throw inputError('Worker launcher switches must occur once.');
      switches.add(item); continue;
    }
    if (item.startsWith('--')) {
      if (!['--home', '--state-dir', '--port', '--startup-timeout-ms'].includes(item) || Object.hasOwn(values, item) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw inputError('Unknown, duplicate or incomplete worker launcher option. Use --help.');
      values[item] = argv[++index]; continue;
    }
    commands.push(item);
  }
  const command = commands.join(' ') || 'start';
  if (!['start', 'status', 'stop', 'migration plan', 'migration adopt'].includes(command)) throw inputError('Use worker.mjs start, status, stop or migration plan|adopt.');
  for (const key of ['--home', '--state-dir']) if (values[key] && /[\x00-\x1f\x7f]/.test(values[key])) throw inputError('Home and state must be folder paths without control characters.');
  if (values['--state-dir'] && !command.startsWith('migration ')) throw inputError('--state-dir is only a migration selector; normal launches use the authoritative Home selection.');
  if (command === 'migration adopt' && !values['--state-dir']) throw inputError('migration adopt requires --state-dir ORIGINAL_LEGACY_STATE. Inspect migration plan first.');
  if (values['--port'] !== undefined && (!/^\d+$/.test(values['--port']) || Number(values['--port']) > 65535)) throw inputError('--port must be an integer from 0 to 65535.');
  if (command !== 'start' && (values['--port'] !== undefined || values['--startup-timeout-ms'] !== undefined)) throw inputError('Launch options are only valid for worker.mjs start.');
  return { command, values, help: switches.has('--help'), open: !switches.has('--no-open') };
}
/** The root launcher supplies Home explicitly; application installation and caller cwd never select it. */
export async function workerHome(argv = process.argv.slice(2), { homeRoot } = {}) {
  try {
    assertNode();
    const selected = argumentsFor(argv);
    if (selected.help) {
      console.log(JSON.stringify({ application: 'Werk Home', usage: 'node worker.mjs [start|status|stop|migration plan|migration adopt|update] [--home PATH] [--no-open]',
        home: 'The root launcher directory is Home, regardless of your current directory. A copied app requires --home PATH outside the copied app folder. Fresh private state is state/worker; visible project checkouts are projects/<id>.',
        start: 'Starts one central worker and opens its local webview. Add projects and connect your provider in the webview; no project worker installation or npm is required.',
        migration: 'migration plan [--state-dir ORIGINAL_STATE] is read-only. Stop the old worker, then migration adopt --state-dir ORIGINAL_STATE selects it without moving absolute journal or checkout paths. Conflicting state or unverified locks block adoption.',
        update: 'update plan --from VERIFIED_HOME previews a release; update apply --from VERIFIED_HOME --if-match PLAN_ID replaces owned release files only. Stop the worker first or explicitly add --stop.',
        unlock: 'Read the private token from credentialsFile and paste it into the webview. Credentials never appear in URLs or launcher output.' }, null, 2)); return;
    }
    if (!selected.values['--home'] && !homeRoot) throw inputError('A copied app requires --home PATH outside the copied app folder. Start the root worker.mjs in your extracted Home.');
    const home = resolve(selected.values['--home'] ?? homeRoot);
    if (selected.command === 'migration plan') { console.log(JSON.stringify(await inspectWorkerHome(home, applicationRoot, selected.values['--state-dir']), null, 2)); return; }
    if (selected.command === 'migration adopt') {
      const plan = await inspectWorkerHome(home, applicationRoot, selected.values['--state-dir']);
      const { withHomeRuntimeLock } = await import('../home-update/guard.mjs');
      const adopted = await withHomeRuntimeLock(plan.homeDir, () => selectWorkerHome(plan.homeDir, applicationRoot, { adoptState: selected.values['--state-dir'] }));
      console.log(JSON.stringify({ ...adopted, message: 'Legacy state remains at its original absolute path. No checkout, journal or credential was moved.' }, null, 2)); return;
    }
    const layout = await selectWorkerHome(home, applicationRoot, { initialize: selected.command === 'start' });
    const verifySelection = async () => {
      const current = await selectWorkerHome(layout.homeDir, applicationRoot);
      if (current.stateDirectory !== layout.stateDirectory || current.layout !== layout.layout) throw inputError('The Home state selection changed during admission. Inspect migration plan before retrying.');
    };
    if (selected.command === 'update') {
      const { homeUpdate } = await import('../home-update.mjs');
      console.log(JSON.stringify(await homeUpdate(layout.homeDir, selected.updateArgs, { stateDirectory: layout.stateDirectory, inspectWorker: async () => { await verifySelection(); return status('worker', layout.stateDirectory); }, stopWorker: async () => { await verifySelection(); return stop('worker', layout.stateDirectory); } }), null, 2)); return;
    }
    const base = ['--state-dir', layout.stateDirectory];
    if (selected.command === 'start') process.chdir(layout.homeDir);
    if (selected.command !== 'start') { await main('worker', [selected.command, ...base]); return; }
    const { withHomeRuntimeLock } = await import('../home-update/guard.mjs');
    await withHomeRuntimeLock(layout.homeDir, async () => {
      await verifySelection();
      const before = await status('worker', layout.stateDirectory);
      if (before.state === 'running') console.log(JSON.stringify({ ...before, alreadyRunning: true }));
      else {
        await main('worker', ['start', ...base, '--home-dir', layout.homeDir, '--standalone', '--host', '127.0.0.1', '--port', selected.values['--port'] ?? '4100',
          ...(selected.values['--startup-timeout-ms'] ? ['--startup-timeout-ms', selected.values['--startup-timeout-ms']] : [])]);
        if (process.exitCode) return;
      }
      const ready = await status('worker', layout.stateDirectory);
      if (ready.state !== 'running' || typeof ready.url !== 'string') throw Error('The worker has no confirmed local webview. Inspect worker.mjs status before retrying.');
      console.error('Werk Home is ready: ' + ready.url + '\nUnlock the webview with the private token in ' + ready.credentialsFile + '.\nAdd a project and connect your model provider in the webview.');
      if (layout.layout === 'legacy') console.error('Retained legacy state: ' + layout.stateDirectory + '. Original absolute paths are preserved.');
      if (selected.open) {
        const browser = await openBrowser(ready.url);
        if (!browser.opened) console.error(browser.reason ?? 'Open the worker URL in your browser.');
      }
    });
  } catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = error.exitCode ?? 1; }
}
