/** Shared update command metadata; importing it never loads process or filesystem adapters. */
export const updateCommands = {
  'update check': { options: ['version', 'from', 'project-dir'], flags: [] },
  'update status': { options: ['state-dir', 'project-dir'], flags: [] },
  'update apply': { options: ['version', 'from', 'state-dir', 'project-dir'], flags: ['stop', 'no-restart'] },
  'update rollback': { options: ['state-dir', 'project-dir'], flags: ['stop', 'no-restart'] },
  'update restore': { options: ['from', 'to'], flags: [] },
};
export const updateHelp = {
  check: 'update check [--version X.Y.Z] [--from EXTRACTED_RELEASE]: compare this app with the latest stable (or requested) GitHub release; changes nothing',
  status: 'update status: installed version, running state, retained previous folders and last update',
  apply: 'update apply [--version X.Y.Z | --from EXTRACTED_RELEASE] [--stop] [--no-restart]: verify the release, back up state, replace this app folder atomically and keep the previous folder',
  rollback: 'update rollback [--stop] [--no-restart]: swap back the folder retained by the last update or rollback; state is not changed',
  restore: 'update restore --from BACKUP --to NEW_STATE_DIRECTORY: restore a verified update backup into a new directory',
  safety: 'Refuses while the selected instance runs unless --stop is given; restarts only an instance it stopped. Stop every other instance that runs from this app folder first.',
};
