import { fileURLToPath } from 'node:url';
import { mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { main } from './cli.mjs';
import { status, stateDirectory } from './lifecycle.mjs';
import { assertNode, inputError } from '../config.mjs';
import { openBrowser } from '../browser.mjs';

const applicationRoot = fileURLToPath(new URL('../../../', import.meta.url));
function argumentsFor(argv) {
  const values = {}, switches = new Set(), commands = [];
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (['--help', '--no-open', '--json'].includes(item)) {
      if (switches.has(item)) throw inputError('Worker launcher switches must occur once.');
      switches.add(item); continue;
    }
    if (item.startsWith('--')) {
      if (!['--home', '--port', '--startup-timeout-ms'].includes(item) || Object.hasOwn(values, item) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw inputError('Unknown, duplicate or incomplete worker launcher option. Use --help.');
      values[item] = argv[++index]; continue;
    }
    commands.push(item);
  }
  if (commands.length > 1 || commands[0] && !['start', 'status', 'stop'].includes(commands[0])) throw inputError('Use worker.mjs start, status or stop.');
  const command = commands[0] ?? 'start';
  if (values['--home'] && /[\x00-\x1f\x7f]/.test(values['--home'])) throw inputError('Worker home must be a folder path without control characters.');
  if (values['--port'] !== undefined && (!/^\d+$/.test(values['--port']) || Number(values['--port']) > 65535)) throw inputError('--port must be an integer from 0 to 65535.');
  if (command !== 'start' && (values['--port'] !== undefined || values['--startup-timeout-ms'] !== undefined)) throw inputError('Launch options are only valid for worker.mjs start.');
  return { command, values, help: switches.has('--help'), open: !switches.has('--no-open') };
}
/** Standalone archive entrypoint. The home owns state; application files remain separately replaceable. */
export async function workerHome(argv = process.argv.slice(2)) {
  try {
    assertNode();
    const selected = argumentsFor(argv);
    if (selected.help) {
      console.log(JSON.stringify({ application: 'Werk standalone worker', usage: 'node path/to/extracted/worker.mjs [start|status|stop] [--home PATH] [--port 4100] [--no-open]',
        home: 'Current directory by default, outside the copied app folder. Run a copied app from your dedicated worker home or pass --home PATH. Private state is .werk/worker beneath this home.',
        start: 'Starts one standalone worker in the background and opens its local webview. No project init, npm installation or model call is performed.',
        unlock: 'Read the private token from the printed credentialsFile path and paste it into the webview. Credentials never appear in the URL or launcher output.',
        setup: 'Connect your provider and register a project in the webview before submitting a Feature Request.' }, null, 2)); return;
    }
    let home = resolve(selected.values['--home'] ?? process.cwd());
    if (selected.command === 'start') await mkdir(home, { recursive: true, mode: 0o700 });
    home = await realpath(home).catch(error => { if (error.code === 'ENOENT' && selected.command !== 'start') return home; throw error; });
    const state = await stateDirectory('worker', applicationRoot, join(home, '.werk', 'worker')).catch(error => {
      if (/outside the copied app folder/.test(error.message)) throw inputError('Choose a worker home outside the copied app folder. Run the starter from your dedicated worker home or pass --home PATH.');
      throw error;
    });
    // The portable child shares this explicit home, not the application's installation folder.
    if (selected.command === 'start') process.chdir(home);
    const base = ['--state-dir', state];
    if (selected.command !== 'start') { await main('worker', [selected.command, ...base]); return; }
    const before = await status('worker', state);
    if (before.state === 'running') console.log(JSON.stringify({ ...before, alreadyRunning: true }));
    else {
      await main('worker', ['start', ...base, '--standalone', '--host', '127.0.0.1', '--port', selected.values['--port'] ?? '4100',
        ...(selected.values['--startup-timeout-ms'] ? ['--startup-timeout-ms', selected.values['--startup-timeout-ms']] : [])]);
      if (process.exitCode) return;
    }
    const ready = await status('worker', state);
    if (ready.state !== 'running' || typeof ready.url !== 'string') throw Error('The worker has no confirmed local webview. Inspect worker.mjs status before retrying.');
    console.error('Werk worker is ready: ' + ready.url + '\nUnlock the webview with the private token in ' + ready.credentialsFile + '.\nConnect your model provider and add a project in the webview.');
    if (selected.open) {
      const browser = await openBrowser(ready.url);
      if (!browser.opened) console.error(browser.reason ?? 'Open the worker URL in your browser.');
    }
  } catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = error.exitCode ?? 1; }
}
