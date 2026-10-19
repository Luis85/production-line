import type { DevelopmentCandidate, DevelopmentListedFile } from '../application/development.js';

/** Serialized bytes for listed paths and hashes, well below the 128 KiB tool result limit. */
const CANDIDATE_LISTING_BYTES = 64 * 1024;
/** Unchanged files below approved folders listed at most, within the byte budget. */
const CANDIDATE_LISTED_FOLDER_FILES = 200;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) + 1;

/**
 * Bounded model-facing listing. Exact and requested entries always keep their hashes; changed paths follow with hashes
 * while the byte budget allows, then without hashes, then only as a count; unchanged folder files fill what remains.
 */
export function boundedListing(all: readonly DevelopmentListedFile[], changedPaths: readonly string[], kept: ReadonlySet<string>, requested: readonly string[], budget = CANDIDATE_LISTING_BYTES) {
  const changed = new Set(changedPaths), byPath = new Map(all.map(file => [file.path, file]));
  const entry = (path: string): DevelopmentListedFile => ({ path, hash: byPath.get(path)?.hash ?? null, ...(changed.has(path) ? { changed: true as const } : {}) });
  const files: DevelopmentListedFile[] = [], listed = new Set<string>(), changedPathsWithoutHashes: string[] = [];
  let used = 0, omittedChangedPaths = 0, hashed = true;
  const add = (path: string) => { const value = entry(path); files.push(value); listed.add(path); used += size(value); };
  for (const file of all) if (kept.has(file.path)) add(file.path);
  for (const path of requested) if (!listed.has(path)) add(path);
  const pending = changedPaths.filter(path => !listed.has(path));
  // When not every changed path fits with its hash, hashes may use half of what remains so the rest are still named.
  const hashBudget = used + pending.reduce((sum, path) => sum + size(entry(path)), 0) <= budget ? budget : used + (budget - used) / 2;
  for (const path of pending) {
    if (hashed && used + size(entry(path)) <= hashBudget) { add(path); continue; }
    hashed = false;
    if (used + size(path) <= budget) { changedPathsWithoutHashes.push(path); used += size(path); } else omittedChangedPaths++;
  }
  const others = all.filter(file => !listed.has(file.path) && !changed.has(file.path));
  let shown = 0;
  for (const file of others) {
    if (shown >= CANDIDATE_LISTED_FOLDER_FILES || used + size(entry(file.path)) > budget) break;
    add(file.path); shown++;
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const omittedFiles = others.length - shown;
  return { files, ...(changedPathsWithoutHashes.length ? { changedPathsWithoutHashes } : {}), ...(omittedChangedPaths ? { omittedChangedPaths } : {}), ...(omittedFiles ? { omittedFiles } : {}) };
}

/** The status and apply result shape: each changed path appears once, with a note whenever the listing is incomplete. */
export function candidateView(candidate: DevelopmentCandidate) {
  const unhashed = candidate.changedPathsWithoutHashes?.length ?? 0, omittedChanged = candidate.omittedChangedPaths ?? 0, omitted = candidate.omittedFiles ?? 0;
  const notes = [
    unhashed ? `${unhashed} changed paths are listed without hashes in changedPathsWithoutHashes.` : '',
    omittedChanged ? `${omittedChanged} more changed paths are not listed (omittedChangedPaths).` : '',
    omitted ? `${omitted} more unchanged files below approved folders are not listed.` : '',
  ].filter(Boolean);
  return {
    digest: candidate.digest, changedFileCount: candidate.changedPaths.length, files: candidate.files ?? [],
    ...(unhashed ? { changedPathsWithoutHashes: candidate.changedPathsWithoutHashes } : {}),
    ...(omittedChanged ? { omittedChangedPaths: omittedChanged } : {}), ...(omitted ? { omittedFiles: omitted } : {}),
    ...(notes.length ? { filesNote: `${notes.join(' ')} Call werk_candidate_status with paths (at most 32) for the files you want to edit.` } : {}),
  };
}
