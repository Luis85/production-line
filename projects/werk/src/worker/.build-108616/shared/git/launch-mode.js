                                                         

/** Fixed metadata operations avoid a Windows supervisor; transports, filters and unknown variants own a process tree. */
export function gitLaunchMode(args                   )             {
  let offset = 0;
  while (args[offset] === '--no-optional-locks') offset++;
  const [command, ...rest] = args.slice(offset);
  // Callers disable hooks/fsmonitor. Status can still launch clean filters, so it remains contained.
  if (['rev-parse', 'rev-list', 'merge-base', 'ls-files', 'ls-tree', 'update-ref', 'write-tree'].includes(command)) return 'plain';
  if (command === 'cat-file' && rest.length === 2 && ['-s', '-t', 'blob'].includes(rest[0])) return 'plain';
  if (command === 'branch' && rest.length === 1 && rest[0] === '--show-current') return 'plain';
  if (command === 'remote' && rest.length === 0) return 'plain';
  if (command === 'config' && rest.length === 2 && rest[0] === '--get') return 'plain';
  if (command === 'worktree' && (rest.join(' ') === 'list --porcelain -z' || rest.length === 4 && rest.slice(0, 3).join(' ') === 'remove --force --')) return 'plain';
  if (command === 'update-index' && rest.length === 5 && rest[0] === '--add' && rest[1] === '--cacheinfo') return 'plain';
  if (command === 'commit-tree' && rest.length === 3 && rest[1] === '-p') return 'plain';
  if (command === 'hash-object' && rest.join(' ') === '-w --stdin --no-filters') return 'plain';
  if (command === 'log' && (rest.length === 5 && rest[0] === '-1' && rest[1] === '--format=%H' && rest[3] === '--' || rest.length === 3 && rest[0] === '--max-count=128' && rest[1] === '--format=%H%x00%B%x00')) return 'plain';
  return 'contained';
}
