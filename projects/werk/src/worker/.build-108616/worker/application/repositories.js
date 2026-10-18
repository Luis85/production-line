import { identifier, object, text } from '../../shared/contracts.js';
import { ValidationError } from '../../shared/errors.js';

                                                                                                                    
/** `worktreeDirectory` is an optional absolute folder outside every checkout for new task worktrees. */
                                                                                                                       
export const defaultRepositoryConfiguration = ()                          => ({ pollMs: 30000, items: [] });

/** Validate assignment policy without accessing a repository or performing Git operations. */
export function validateRepositoryConfiguration(input         , normalizePath                                          = path => path)                          {
  const value = object(input === undefined ? {} : input, 'Repositories', ['pollMs', 'items', 'worktreeDirectory']);
  const pollMs = value.pollMs === undefined ? 30000 : value.pollMs;
  if (!Number.isSafeInteger(pollMs) || Number(pollMs) < 1000 || Number(pollMs) > 3600000)
    throw new ValidationError('repositories.pollMs must be an integer between 1000 and 3600000.');
  const entries = value.items === undefined ? [] : value.items;
  if (!Array.isArray(entries) || entries.length > 64) throw new ValidationError('repositories.items must contain at most 64 repositories.');
  const ids = new Set        (), paths = new Set        ();
  const items = entries.map(entry => {
    const item = object(entry, 'Repository', ['id', 'path', 'remote', 'branch', 'watch']);
    const id = identifier(item.id, 'Repository id');
    const sourcePath = text(item.path, 'Repository path', 4096);
    if (/[\x00-\x1f\x7f]/.test(sourcePath)) throw new ValidationError('Repository path must not contain control characters.');
    const path = normalizePath(sourcePath, 'Repository path');
    if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path)) throw new ValidationError('Repository path must be absolute on the worker machine.');
    const remote = item.remote === undefined ? 'origin' : text(item.remote, 'Repository remote', 100);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote) || remote.endsWith('.lock') || remote.includes('..'))
      throw new ValidationError('Repository remote must be an existing Git remote name, such as origin.');
    const watch = item.watch === undefined ? true : item.watch;
    if (typeof watch !== 'boolean') throw new ValidationError('Repository watch must be true or false.');
    let branch                    ;
    if (item.branch !== undefined) {
      branch = text(item.branch, 'Repository branch', 200);
      if (branch === '@' || branch.startsWith('-') || /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) || branch.includes('..') || branch.includes('@{') || branch.endsWith('.') || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock')))
        throw new ValidationError('Repository branch must be a valid Git branch name.');
    }
    if (ids.has(id)) throw new ValidationError('Repository ids must be unique.');
    if (paths.has(path)) throw new ValidationError('Repository paths must be unique.');
    ids.add(id); paths.add(path);
    return { id, path, remote, ...(branch ? { branch } : {}), watch };
  });
  let worktreeDirectory                    ;
  if (value.worktreeDirectory !== undefined && value.worktreeDirectory !== '') {
    const sourcePath = text(value.worktreeDirectory, 'Task worktree directory', 1024);
    if (/[\x00-\x1f\x7f]/.test(sourcePath)) throw new ValidationError('Task worktree directory must not contain control characters.');
    worktreeDirectory = normalizePath(sourcePath, 'Task worktree directory');
    if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(worktreeDirectory)) throw new ValidationError('Task worktree directory must be absolute on the worker machine.');
  }
  return { pollMs: Number(pollMs), items, ...(worktreeDirectory ? { worktreeDirectory } : {}) };
}
