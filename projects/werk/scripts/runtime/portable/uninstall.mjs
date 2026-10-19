import { randomBytes } from 'node:crypto';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPrivate, inputError } from '../config.mjs';
import { environmentExample, environmentKeys } from './environment.mjs';
import { status, stop } from './lifecycle.mjs';
import { inventory, taskWorktrees } from './footprint.mjs';
import { holdsOtherThan, info, missing, pruneParents, removeUntracked, smallText, within } from './footprint-files.mjs';

/**
 * Guarded removal of a project worker. Git-tracked files, request folders and .env
 * stay unless explicitly included; tracked files are never deleted. Task worktrees go
 * through the worker's owned-worktree removal, so changed, locked, linked, committed
 * and unowned worktrees are kept and reported. The worker lock is held until the end;
 * the .werk ignore rules and project marker go after everything they protect, and the
 * running CLI's own app goes last.
 */
const ORDER = ['integrations', 'authoring', 'configuration', 'requests', 'environment', 'state', 'retained', 'ignore', 'marker', 'app'];
const GUARDS = { '.werk/.gitignore': 'they keep worker state and credentials out of Git', '.werk/worker-project.json': 'uninstall finds this worker through it' };
const LOCK = 'worker.lock';
const keep = (entry, reason) => ({ action: 'keep', entry, reason });
const phase = entry => entry.path === '.werk/.gitignore' ? 'ignore' : entry.path === '.werk/worker-project.json' ? 'marker' : entry.group;
const STOP_HINT = 'Stop it first (node bin/apps/worker/cli.mjs stop, or docker compose --env-file .env -f .werk/compose.worker.yaml down), or pass --stop to stop the native worker gracefully.';

function decide(entry, flags) {
  if (!entry.exists) return null;
  if (!entry.inside) return keep(entry, 'Outside the project directory or reached through a link; remove it manually after review.');
  if (entry.type === 'link') return keep(entry, 'A symbolic link or junction; remove it manually after review.');
  if (entry.type === 'special') return keep(entry, 'Not a regular file or directory; remove it manually after review.');
  if (entry.stateDirectory && entry.holdsProjectFiles) return keep(entry, 'The selected state directory contains other project files; check --state-dir and WERK_WORKER_STATE_DIR.');
  if (entry.stateDirectory && entry.workerState === false) return keep(entry, 'The selected state directory has no worker state files (webview-token, workspace-settings.json, portable.json, portable.log); check --state-dir and WERK_WORKER_STATE_DIR.');
  if (entry.group === 'requests' && !flags['include-requests']) return keep(entry, 'Request folders are kept. Pass --include-requests to remove their untracked files.');
  if (entry.group === 'environment') {
    if (entry.path === '.gitignore') return entry.rules?.length ? keep(entry, 'Project ignore rules stay; they keep .env out of Git.') : null;
    if (entry.path === '.env' ? !entry.keys?.length : !entry.werkBlock) return null;
    if (!flags['include-environment']) return keep(entry, 'Environment entries are kept. Pass --include-environment to remove the worker entries.');
    if (entry.tracked) return keep(entry, 'Tracked by Git; never changed.');
    return { action: 'edit', entry };
  }
  if (entry.managed === false) return keep(entry, entry.note);
  if (entry.type === 'file' && entry.tracked) return keep(entry, 'Tracked by Git; never removed.');
  return { action: 'remove', entry };
}
const summary = ({ group, path, type, size, trackedFiles }) => ({ group, path, type, size, ...(trackedFiles ? { keepsTrackedFiles: trackedFiles } : {}) });

/** Replace a private file through a sibling temporary file, so a failure leaves the original intact. */
async function replaceFile(path, text, mode) {
  const temporary = `${path}.werk-${randomBytes(4).toString('hex')}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    if (process.platform !== 'win32') await handle.chmod(mode & 0o777);
    await handle.writeFile(text); await handle.sync();
  } catch (error) { await handle.close(); await unlink(temporary).catch(missing); throw error; }
  await handle.close();
  try { await rename(temporary, path); } catch (error) { await unlink(temporary).catch(missing); throw error; }
}
/** Remove the worker's .env keys or .env.example block; other lines and files stay unchanged. */
async function editEnvironment(project, entry) {
  const path = join(project, entry.path), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return { kept: 'Not a single regular file; edit it manually.' };
  const text = await smallText(path);
  if (text === undefined) return { kept: 'Larger than 64 KiB; edit it manually.' };
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  let next;
  if (entry.path === '.env') {
    const keys = new Set(environmentKeys('worker')), lines = text.split(/\r?\n/), kept = [];
    for (const line of lines) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match || !keys.has(match[1])) { kept.push(line); continue; }
      const quote = ['"', "'", '`'].includes(match[2][0]) ? match[2][0] : undefined;
      if (quote && !match[2].slice(1).includes(quote)) return { kept: 'A worker key spans several lines; edit .env manually.' };
    }
    next = kept.join(newline);
  } else {
    const block = environmentExample('worker').replaceAll('\n', newline);
    if (!text.includes(block)) return { kept: 'The Werk worker block was edited; edit .env.example manually.' };
    next = text.replace(block, '');
  }
  if (!next.trim()) { await unlink(path); return { removed: true }; }
  await replaceFile(path, next, stat.mode);
  return { edited: true };
}

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
/** Paths that hold a task worktree staying in place are never removed recursively. */
function protectWorktrees(plan, worktrees) {
  const staying = worktrees.filter(item => item.outcome === 'kept' && item.name && item.path).map(item => item.path);
  return plan.map(item => item.action !== 'keep' && staying.some(path => within(item.entry.absolute, path)) ? keep(item.entry, 'Contains a task worktree that stays; review the worktree first.') : item);
}

async function lockState(state) {
  const path = join(state, LOCK);
  if (!await info(state)) return { path: null, release: async () => {} };
  try { await createPrivate(path, { maintenance: 'uninstall', pid: process.pid }); }
  catch (error) { if (error.code === 'EEXIST') throw inputError('The worker started again or another operation holds its lock. Inspect status and retry.'); throw error; }
  return { path, release: () => unlink(path).catch(missing) };
}
function failure(error) {
  if (error.code === 'EACCES') return 'Could not remove (EACCES); permission denied.';
  if (['EBUSY', 'EPERM'].includes(error.code)) return `Could not remove (${error.code}); a process holds it open or it is read-only.`;
  return `Could not remove (${error.code ?? 'error'}).`;
}
/** A guard stays while any path it protects, and that this run meant to remove, still has content. */
async function guardedBy(project, entry, plan, lock) {
  const planned = new Set(plan.filter(item => item.action === 'remove').map(item => item.entry.absolute));
  const protectedPaths = entry.path === '.werk/.gitignore'
    ? ['.werk/worker', '.werk/provider-home', '.werk/agent-integrations.json', '.werk/agent-integrations.pending.json', '.werk/agent-integrations.lock'].map(path => join(project, path))
    : [...plan.filter(item => ['state', 'retained'].includes(item.entry.group)).map(item => item.entry.absolute), join(project, '.werk/.gitignore')];
  for (const path of protectedPaths) {
    if (!planned.has(path)) continue;
    const stat = await info(path);
    if (stat && (!stat.isDirectory() || await holdsOtherThan(path, lock && join(path, LOCK) === lock ? [LOCK] : []))) return path;
  }
  return null;
}

async function apply(project, plan, lock) {
  const removed = [], kept = [], manual = [];
  const ordered = plan.filter(item => item.action !== 'keep').sort((a, b) => ORDER.indexOf(phase(a.entry)) - ORDER.indexOf(phase(b.entry)));
  for (const { action, entry } of ordered) {
    const report = { group: entry.group, path: entry.path };
    try {
      if (action === 'edit') {
        const outcome = await editEnvironment(project, entry);
        if (outcome.kept) kept.push({ ...report, reason: outcome.kept });
        else { removed.push({ ...report, file: outcome.removed ? 'removed' : 'edited', ...(entry.path === '.env' ? { removedKeys: entry.keys } : { removedBlock: '# Werk worker environment' }) }); if (outcome.removed) await pruneParents(project, entry.absolute); }
        continue;
      }
      if (GUARDS[entry.path]) {
        const remaining = await guardedBy(project, entry, plan, lock);
        if (remaining) { kept.push({ ...report, reason: `Kept while ${remaining} still exists; ${GUARDS[entry.path]}. Resolve the kept paths, then run uninstall --confirm again.` }); continue; }
      }
      const result = await removeUntracked(project, entry.absolute, entry.trackedSet, lock);
      const gone = result.gone || (lock && join(entry.absolute, LOCK) === lock && !await holdsOtherThan(entry.absolute, [LOCK]));
      removed.push({ ...report, files: result.removed, ...(gone ? {} : { partial: true }) });
      if (result.tracked) kept.push({ ...report, reason: `${result.tracked} Git-tracked file(s) stay.` });
      if (result.links) kept.push({ ...report, reason: `${result.links} link(s) or junction(s) stay; review them manually.`, links: result.linkPaths });
      if (result.repositories.length) kept.push({ ...report, reason: 'Nested Git repositories, submodules or worktrees stay; review them manually.', repositories: result.repositories });
      if (result.special) kept.push({ ...report, reason: `${result.special} special file(s) stay.` });
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
export async function uninstallWorker(root, options, state, flags) {
  if (!!flags['dry-run'] === !!flags.confirm) throw inputError(flags['dry-run'] ? 'Use either --dry-run or --confirm, not both.' : 'uninstall removes files. Preview with uninstall --dry-run, then run uninstall --confirm.');
  const { configuredProjectRoot } = await import('./project.mjs');
  const project = await configuredProjectRoot(options);
  if (!project) throw inputError('No project worker found in this directory. Run uninstall from a project initialized with worker init.');
  if (!within(project, await realpath(process.cwd())) || !within(await realpath(process.cwd()), project)) throw inputError(PROJECT_HINT);
  // The running CLI may be the app folder this command removes last; load what the error path needs now.
  await import(pathToFileURL(join(root, 'src/worker/dist/shared/errors.js')).href);
  const self = within(join(project, 'bin/apps/worker'), await realpath(root));
  const live = await status('worker', state);
  if (flags.confirm && live.state === 'unreachable') throw inputError(live.action);
  const running = live.state !== 'stopped';
  if (flags.confirm && running && !flags.stop) throw inputError('The worker is running. ' + STOP_HINT);
  if (flags.confirm && running) await stop('worker', state);
  const { entries, layout, tracked } = await inventory(root, project, state);
  if (tracked.repository === null) throw inputError('Git cannot read this checkout, so tracked files cannot be protected. Repair Git access and retry.');
  if (flags.confirm && entries.some(entry => entry.group === 'state' && entry.path.endsWith('/_worker.lock') && entry.exists)) throw inputError('A worker holds the feature folder lock (_worker.lock), for example in Docker. ' + STOP_HINT + ' After a crash, verify no worker runs before deleting the lock.');
  const decided = entries.map(entry => decide({ ...entry, trackedSet: tracked }, flags)).filter(Boolean);
  const header = { schemaVersion: 1, projectDirectory: project, stateDirectory: state, worker: { state: running && flags.confirm ? 'stopped' : live.state, ...(running ? { stopRequired: true } : {}) } };
  const keepList = plan => plan.filter(item => item.action === 'keep').map(item => ({ group: item.entry.group, path: item.entry.path, reason: item.reason }));
  if (flags['dry-run']) {
    const worktrees = await worktreePlan(root, project, state, layout, flags), plan = protectWorktrees(decided, worktrees);
    return { ...header, dryRun: true,
      remove: [...worktrees.filter(item => item.outcome === 'would_remove').map(({ outcome, ...item }) => item), ...plan.filter(item => item.action !== 'keep').sort((a, b) => ORDER.indexOf(phase(a.entry)) - ORDER.indexOf(phase(b.entry))).map(item => ({ ...summary(item.entry), ...(item.action === 'edit' ? { edit: item.entry.path === '.env' ? { removeKeys: item.entry.keys } : { removeBlock: '# Werk worker environment' } } : {}) }))],
      keep: [...worktrees.filter(item => item.outcome !== 'would_remove').map(({ outcome, ...item }) => item), ...keepList(plan)],
      ...(self ? { note: 'This CLI runs from the app folder it removes; the app folder is removed last.' } : {}),
      next: running ? 'Stop the worker or pass --stop, then run uninstall --confirm.' : 'Run uninstall --confirm to apply exactly this plan.' };
  }
  const lock = await lockState(state);
  let worktrees, plan, result;
  try {
    worktrees = await worktreePlan(root, project, state, layout, flags);
    plan = protectWorktrees(decided, worktrees);
    result = await apply(project, plan, lock.path);
  } finally {
    await lock.release();
    // The state folder stayed only for the lock; remove it now when nothing else is left.
    if (lock.path && plan?.some(item => item.action === 'remove' && item.entry.stateDirectory) && !await holdsOtherThan(state)) await pruneParents(project, lock.path);
  }
  const keptWorktrees = worktrees.filter(item => item.outcome !== 'removed');
  const manual = [...result.manual, ...(keptWorktrees.some(item => item.name) ? ['Review kept task worktrees; after review remove each with git worktree remove PATH in its repository.'] : [])];
  return { ...header, dryRun: false, ok: !result.kept.some(item => item.reason.startsWith('Could not remove')),
    removed: [...worktrees.filter(item => item.outcome === 'removed').map(({ outcome, ...item }) => item), ...result.removed],
    kept: [...keptWorktrees.map(({ outcome, ...item }) => item), ...keepList(plan), ...result.kept], manual,
    next: 'Git-tracked files were not changed. If the team no longer needs them, remove them from the checkout in a separate commit.' };
}
