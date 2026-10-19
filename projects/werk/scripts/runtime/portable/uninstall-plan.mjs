import { join } from 'node:path';
import { holdsOtherThan, info, removeUntracked, within } from './footprint-files.mjs';

/**
 * Decides what uninstall removes and keeps. The same plan, including the predicted
 * partial removals and the guard files they keep, drives both --dry-run and --confirm.
 */
export const ORDER = ['integrations', 'authoring', 'configuration', 'requests', 'environment', 'state', 'retained', 'ignore', 'marker', 'app'];
const IGNORE = '.werk/.gitignore', MARKER = '.werk/worker-project.json';
const GUARDS = { [IGNORE]: 'they keep worker state and credentials out of Git', [MARKER]: 'uninstall finds this worker through it' };
export const LOCK = 'worker.lock';
export const phase = entry => entry.path === IGNORE ? 'ignore' : entry.path === MARKER ? 'marker' : entry.group;
const keep = (entry, reason, extra = {}) => ({ action: 'keep', entry, reason, ...extra });
export const isGuard = entry => !!GUARDS[entry.path];

export function decide(entry, flags) {
  if (!entry.exists) return null;
  if (entry.type === 'unreadable') return keep(entry, `Could not be inspected (${entry.error}); review it manually.`);
  if (!entry.inside) return keep(entry, 'Outside the project directory or reached through a link; remove it manually after review.');
  if (entry.type === 'link') return keep(entry, 'A symbolic link or junction; remove it manually after review.');
  if (entry.type === 'special') return keep(entry, 'Not a regular file or directory; remove it manually after review.');
  if (entry.stateDirectory && entry.holdsProjectFiles) return keep(entry, 'The selected state directory contains other project files; nothing in it was removed. Check --state-dir and WERK_WORKER_STATE_DIR.');
  if (entry.stateDirectory && entry.workerState === false) return keep(entry, 'The selected state directory holds entries the worker does not write; nothing in it was removed. Check --state-dir and WERK_WORKER_STATE_DIR.', { unknownEntries: entry.unknownEntries.slice(0, 20) });
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

/** Paths that hold a task worktree staying in place are never removed recursively. */
export function protectWorktrees(plan, worktrees) {
  const staying = worktrees.filter(item => item.outcome === 'kept' && item.name && item.path).map(item => item.path);
  return plan.map(item => item.action !== 'keep' && staying.some(path => within(item.entry.absolute, path)) ? keep(item.entry, 'Contains a task worktree that stays; review the worktree first.') : item);
}

/** What a removal leaves behind, reported identically for the prediction and the actual run. */
export function residue(report, result) {
  return [
    ...(result.tracked ? [{ ...report, reason: `${result.tracked} Git-tracked file(s) stay.` }] : []),
    ...(result.links ? [{ ...report, reason: `${result.links} link(s) or junction(s) stay; review them manually.`, links: result.linkPaths }] : []),
    ...(result.repositories.length ? [{ ...report, reason: 'Nested Git repositories, submodules or worktrees stay; review them manually.', repositories: result.repositories }] : []),
    ...(result.special ? [{ ...report, reason: `${result.special} special file(s) stay.` }] : []),
  ];
}

/** Paths a guard file protects: worker state, provider home, retained folders and integration records. */
function protectedBy(project, guard, plan) {
  const werk = join(project, '.werk');
  const paths = plan.filter(item => ['state', 'retained'].includes(item.entry.group) || item.entry.path.startsWith('.werk/agent-integrations')).map(item => item.entry.absolute);
  return guard.path === IGNORE ? paths.filter(path => within(werk, path)) : [...paths, join(project, IGNORE)];
}
const stays = (plan, path) => plan.some(item => item.entry.absolute === path && item.entry.exists && (item.action === 'keep' || (item.action === 'remove' && item.prediction && !item.prediction.gone)));

/**
 * Predict every removal without changing anything, then keep each guard file while any
 * path it protects stays, so the dry run shows exactly what --confirm will do.
 */
export async function predict(project, plan, hold) {
  for (const item of plan.filter(entry => entry.action === 'remove')) {
    try { item.prediction = await removeUntracked(project, item.entry.absolute, item.entry.trackedSet, { hold, dryRun: true }); }
    catch (error) { Object.assign(item, keep(item.entry, `Could not be inspected (${error.code ?? 'error'}); review it manually.`)); }
  }
  for (const guard of [IGNORE, MARKER]) {
    const item = plan.find(entry => entry.entry.path === guard && entry.action === 'remove');
    const remaining = item && protectedBy(project, item.entry, plan).find(path => stays(plan, path));
    if (remaining) Object.assign(item, keep(item.entry, guardReason(project, item.entry, remaining)));
  }
  return plan;
}
const guardReason = (project, entry, remaining) => `Kept while ${remaining.startsWith(project) ? remaining.slice(project.length + 1).replaceAll('\\', '/') : remaining} still exists; ${GUARDS[entry.path]}. Resolve the kept paths, then run uninstall --confirm again.`;

/** At removal time, also keep a guard when a protected path was left by an incomplete removal. */
export async function guardedNow(project, entry, plan) {
  for (const path of protectedBy(project, entry, plan)) {
    const stat = await info(path);
    // The state folder still holds the uninstall lock, which is released last.
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || await holdsOtherThan(path, [LOCK]))) return guardReason(project, entry, path);
  }
  return null;
}
