import { assertNode, inputError } from '../config.mjs';
import { backupState, verifyBackup, restoreState, diagnose } from './backup.mjs';
export async function main(args = process.argv.slice(3), { stdout = value => console.log(value), stderr = value => console.error(value) } = {}) {
  const json = args.includes('--json');
  try {
    assertNode(); args = [...args]; const command = args.shift() ?? 'help';
    if (['help', '--help', '-h'].includes(command)) { stdout('node werk.mjs maintenance backup --state-dir PATH --to NEW_BACKUP_DIRECTORY [--json]\nnode werk.mjs maintenance verify --from BACKUP_DIRECTORY [--json]\nnode werk.mjs maintenance restore --from BACKUP_DIRECTORY --to NEW_STATE_DIRECTORY [--json]\nnode werk.mjs maintenance diagnose --state-dir PATH [--json]\nNative stopped-state maintenance. Backups contain credentials: keep them private. Existing destinations are never overwritten.'); return 0; }
    const allowed = { backup: ['state-dir', 'to'], verify: ['from'], restore: ['from', 'to'], diagnose: ['state-dir'] }[command];
    if (!allowed) throw inputError('Unknown maintenance command. Run node werk.mjs maintenance --help.');
    const options = {};
    while (args.length) {
      const flag = args.shift(), key = flag?.slice(2);
      if (!flag?.startsWith('--') || ![...allowed, 'json'].includes(key) || Object.hasOwn(options, key)) throw inputError('Unknown or repeated maintenance option.');
      if (key === 'json') options[key] = true;
      else { const value = args.shift(); if (!value || value.startsWith('--')) throw inputError(`${flag} requires a value.`); options[key] = value; }
    }
    if (allowed.some(key => !options[key])) throw inputError('Required maintenance paths are missing. Run node werk.mjs maintenance --help.');
    const result = command === 'backup' ? await backupState(options['state-dir'], options.to) : command === 'verify' ? await verifyBackup(options.from) : command === 'restore' ? await restoreState(options.from, options.to) : await diagnose(options['state-dir']);
    stdout(JSON.stringify(result)); return result.ok ? 0 : 1;
  } catch (error) {
    const code = error.exitCode === 2 ? 2 : 1;
    const message = error.code === 'EEXIST' ? 'Destination already exists. Select a new private directory; existing data was preserved.' : error.code && !error.exitCode ? `Maintenance I/O failed (${error.code}). Check storage and permissions; no existing destination was replaced.` : error.message;
    const result = { ok: false, error: { code: code === 2 ? 'INVALID_CONFIGURATION' : 'MAINTENANCE_FAILED', message } };
    if (json) stdout(JSON.stringify(result)); else stderr(message); return code;
  }
}
