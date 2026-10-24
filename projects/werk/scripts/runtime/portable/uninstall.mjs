import { realpath, stat as follow, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPrivate, inputError } from '../config.mjs';
import { editEnvironment } from './uninstall-environment.mjs';
import { status, stop } from './lifecycle.mjs';
import { inventory, taskWorktrees } from './footprint.mjs';
import { holdsOtherThan, info, missing, pruneParents, removeUntracked, within } from './footprint-files.mjs';
import { LOCK, ORDER, decide, guardedNow, isGuard, keptPaths, phase, predict, protectWorktrees, residue } from './uninstall-plan.mjs';

/**
 * Guarded removal of a project worker. Git-tracked files, request folders and .env
 * stay unless explicitly included; tracked files are never deleted. Task worktrees go
 * through the worker's owned-worktree removal, so changed, locked, linked, committed
 * and unowned worktrees are kept and reported. The worker lock is held until the end;
 * the .werk ignore rules and project marker go after everything they protect, and the
 * running CLI's own app goes last.
 */
const STOP_HINT = 'Stop it first (node bin/apps/worker/cli.mjs stop, or docker compose --env-file .env -f .werk/compose.worker.yaml down), or pass --stop to stop the native worker gracefully.';
const summary = ({ group, path, type, size, trackedFiles }) => ({ group, path, type, size, ...(trackedFiles ? { keepsTrackedFiles: trackedFiles } : {}) });
const byPhase = (a, b) => ORDER.indexOf(phase(a.entry)) - ORDER.indexOf(phase(b.entry));

async function worktreePlan(root, project, state, layout, flags) {
  const git = await import(pathToFileURL(join(root, 'src/worker/dist/worker/infrastructure/repositories-git.js')).href);
  const listing = await taskWorktrees(root, project, state, layout), result = [];
  for (const item of listing.items) {
    const base = { group: 'worktrees', path: item.path ?? item.name, repositoryId: item.repositoryId, name: item.name, state: item.state };
    if (!item.owned) { result.push({ ...base, outcome: 'kept', reason: item.state === 'invalid' ? 'Its ownership record is invalid. Review it manually.' : 'Created for another repository assignment; not owned by this worker.' }); continue; }
    try {
      const removal = await git.removeRepositoryWorktree(item.root, item.name, AbortSignal.timeout(300000), 30000, { dryRun: !flags.confirm, checkoutTimeoutMs: 300000 });
      result.push({ ...base, outcome: removal.outcome, ...(removal.reason ? { reason: removal.reason } : {}), ...(removal.changes ? { changes: removal.changes } : {}) });
    } catch (error) { result.push({ ...base, outcome: 'kept', reason: error instanceof git.WorktreeProblem ? error.message : 'The worktree could not be inspected or removed; review it manually.' }); }
  }
  for (const failure of listing.errors) result.push({ group: 'worktrees', path: null, repositoryId: failure.repositoryId ?? null, outcome: 'kept', reason: failure.error });
  return result;
}

async function lockState(state) {
  const path = join(state, LOCK);
  const stat = await info(state);
  // A state path that is not a folder is kept by the plan; there is nothing to lock.
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return { path: null, real: undefined, release: async () => {} };
  try { await createPrivate(path, { maintenance: 'uninstall', pid: process.pid }); }
  catch (error) { if (error.code === 'EEXIST') throw inputError('The worker started again or another operation holds its lock. Inspect status and retry.'); throw error; }
  return { path, real: await realpath(path), release: () => unlink(path).catch(missing) };
}
function failure(error) {
  if (error.code === 'EACCES') return 'Could not remove (EACCES); permission denied.';
  if (['EBUSY', 'EPERM'].includes(error.code)) return `Could not remove (${error.code}); a process holds it open or it is read-only.`;
  return `Could not remove (${error.code ?? 'error'}).`;
}

async function apply(project, plan, hold) {
  const removed = [], kept = [], manual = [];
  for (const { action, entry } of plan.filter(item => item.action !== 'keep').sort(byPhase)) {
    const report = { group: entry.group, path: entry.path };
    try {
      if (action === 'edit') {
        const outcome = await editEnvironment(project, entry);
        if (outcome.kept) kept.push({ ...report, reason: outcome.kept });
        else { removed.push({ ...report, file: outcome.removed ? 'removed' : 'edited', ...(entry.path === '.env' ? { removedKeys: entry.keys } : { removedBlock: '# Werk worker environment' }) }); if (outcome.removed) await pruneParents(project, entry.absolute); }
        continue;
      }
      const guarded = isGuard(entry) && await guardedNow(project, entry, plan);
      if (guarded) { kept.push({ ...report, reason: guarded }); continue; }
      const result = await removeUntracked(project, entry.absolute, entry.trackedSet, { hold, skip: keptPaths(project, plan, entry) });
      const gone = result.gone || (!!hold && within(entry.absolute, hold) && !await holdsOtherThan(entry.absolute, [LOCK]));
      removed.push({ ...report, files: result.removed, ...(gone ? {} : { partial: true }) });
      kept.push(...residue(report, result));
      if (result.gone) await pruneParents(project, entry.absolute);
    } catch (error) {
      kept.push({ ...report, reason: failure(error) });
      if (entry.group === 'app') manual.push(`After the CLI exits and no shell, editor or npm --prefix uses it, remove ${entry.path} with ${process.platform === 'win32' ? `Remove-Item -Recurse -Force ${entry.path.replaceAll('/', '\\')}` : `rm -rf ${entry.path}`}.`);
      else manual.push(`Review and remove ${entry.path} manually.`);
    }
  }
  return { removed, kept, manual };
}

const PROJECT_HINT = 'Run uninstall from the project directory (node bin/apps/worker/cli.mjs uninstall --dry-run), not from inside the app folder or another folder.';
/** Checked before state resolution so a shell inside the app folder gets the actionable message. */
export async function assertOutsideApp(root) {
  if (within(await realpath(root), await realpath(process.cwd()))) throw inputError(PROJECT_HINT);
}
const keepItem = item => ({ group: item.entry.group, path: item.entry.path, reason: item.reason, ...(item.unknownEntries ? { unknownEntries: item.unknownEntries } : {}) });
export async function uninstallWorker(root, options, state, flags) {
  if (!!flags['dry-run'] === !!flags.confirm) throw inputError(flags['dry-run'] ? 'Use either --dry-run or --confirm, not both.' : 'uninstall removes files. Preview with uninstall --dry-run, then run uninstall --confirm.');
  const { configuredProjectRoot } = await import('./project.mjs');
  const project = await configuredProjectRoot(options);
  if (!project) throw inputError('No project worker found in this directory. Run uninstall from a project initialized with worker init.');
  if (!within(project, await realpath(process.cwd())) || !within(await realpath(process.cwd()), project)) throw inputError(PROJECT_HINT);
  // The running CLI may be the app folder this command removes last; load what the error path needs now.
  await import(pathToFileURL(join(root, 'src/worker/dist/shared/errors.js')).href);
  const self = within(join(project, 'bin/apps/worker'), await realpath(root));
  // A file named as the state folder is reported as kept by --dry-run and footprint; --confirm stops before changing anything.
  if (flags.confirm && await info(state) && !(await follow(state).catch(() => null))?.isDirectory()) throw inputError(`The selected state directory ${state} is not a folder, so uninstall cannot tell what the worker wrote. Pass the worker's state folder with --state-dir or WERK_WORKER_STATE_DIR (by default .werk/worker), then run uninstall --confirm again; uninstall --dry-run reports the path as kept.`);
  const live = await status('worker', state, options);
  if (flags.confirm && live.state === 'unreachable') throw inputError(live.action);
  // A stale worker crashed: --confirm removes its provably stale locks without --stop.
  const running = !['stopped', 'stale'].includes(live.state);
  if (flags.confirm && running && !flags.stop) throw inputError('The worker is running. ' + STOP_HINT);
  if (flags.confirm && live.state !== 'stopped') await stop('worker', state, options);
  const { entries, layout, tracked } = await inventory(root, project, state);
  if (tracked.repository === null) throw inputError('Git cannot read this checkout, so tracked files cannot be protected. Repair Git access and retry.');
  if (flags.confirm && entries.some(entry => entry.group === 'state' && entry.path.endsWith('/_worker.lock') && entry.exists)) throw inputError('A worker holds the feature folder lock (_worker.lock), for example in Docker. ' + STOP_HINT + ' After a crash, verify no worker runs before deleting the lock.');
  const decided = entries.map(entry => decide({ ...entry, trackedSet: tracked }, flags)).filter(Boolean);
  const header = { schemaVersion: 1, projectDirectory: project, stateDirectory: state, worker: { state: flags.confirm ? 'stopped' : live.state, ...(running ? { stopRequired: true } : {}) } };
  if (flags['dry-run']) {
    const worktrees = await worktreePlan(root, project, state, layout, flags), plan = await predict(project, protectWorktrees(decided, worktrees));
    const removing = plan.filter(item => item.action !== 'keep').sort(byPhase);
    return { ...header, dryRun: true,
      remove: [...worktrees.filter(item => item.outcome === 'would_remove').map(({ outcome, ...item }) => item), ...removing.map(item => ({ ...summary(item.entry), ...(item.prediction && !item.prediction.gone ? { partial: true } : {}), ...(item.action === 'edit' ? { edit: item.entry.path === '.env' ? { removeKeys: item.entry.keys } : { removeBlock: '# Werk worker environment' } } : {}) }))],
      keep: [...worktrees.filter(item => item.outcome !== 'would_remove').map(({ outcome, ...item }) => item), ...plan.filter(item => item.action === 'keep').map(keepItem), ...removing.flatMap(item => item.prediction ? residue({ group: item.entry.group, path: item.entry.path }, item.prediction) : [])],
      ...(self ? { note: 'This CLI runs from the app folder it removes; the app folder is removed last.' } : {}),
      next: running ? 'Stop the worker or pass --stop, then run uninstall --confirm.' : 'Run uninstall --confirm to apply exactly this plan.' };
  }
  const lock = await lockState(state);
  let worktrees, plan, result;
  try {
    worktrees = await worktreePlan(root, project, state, layout, flags);
    plan = await predict(project, protectWorktrees(decided, worktrees), lock.real);
    result = await apply(project, plan, lock.real);
  } finally {
    await lock.release();
    // The state folder stayed only for the lock; remove it now when nothing else is left.
    if (lock.path && plan?.some(item => item.action === 'remove' && item.entry.stateDirectory) && !await holdsOtherThan(state)) await pruneParents(project, lock.path);
  }
  const keptWorktrees = worktrees.filter(item => item.outcome !== 'removed');
  const manual = [...result.manual, ...(keptWorktrees.some(item => item.name) ? ['Review kept task worktrees; after review remove each with git worktree remove PATH in its repository.'] : [])];
  return { ...header, dryRun: false, ok: !result.kept.some(item => item.reason.startsWith('Could not remove')),
    removed: [...worktrees.filter(item => item.outcome === 'removed').map(({ outcome, ...item }) => item), ...result.removed],
    kept: [...keptWorktrees.map(({ outcome, ...item }) => item), ...plan.filter(item => item.action === 'keep').map(keepItem), ...result.kept], manual,
    next: 'Git-tracked files were not changed. If the team no longer needs them, remove them from the checkout in a separate commit.' };
}
