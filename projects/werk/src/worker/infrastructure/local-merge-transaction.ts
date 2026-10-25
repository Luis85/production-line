import { gitExecutable } from '../../shared/git/executable.js';
import { gitEnvironment } from '../../shared/git/environment.js';
import { launchProcess, terminateProcess } from '../../shared/process/launcher.js';
import { DomainError } from '../../shared/errors.js';

/** Keep Git's own expected-old ref lock while the guarded index/worktree update executes. */
export async function localMergeTransaction(input: { repository: string; branch: string; previous: string; next: string; signal: AbortSignal }, apply: () => Promise<void>) {
  const { signal } = input, env = { ...gitEnvironment('host-local'), GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' };
  signal.throwIfAborted();
  const child = launchProcess(await gitExecutable(input.repository, env, 'plain'), ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'update-ref', '--stdin'], { cwd: input.repository, env, mode: 'plain', observation: { kind: 'git', label: 'Main checkout merge' } });
  let buffer = '', bytes = 0, awaiting: { expected: string; resolve(): void; reject(error: Error): void } | undefined;
  const failure = () => new DomainError('conflict', 'The main branch ref transaction could not retain its expected head. Preserve the checkout and reconcile the saved merge.');
  const fail = () => { awaiting?.reject(failure()); awaiting = undefined; };
  child.stdin.on('error', fail);
  child.stdout.on('data', chunk => {
    bytes += chunk.length; if (bytes > 65536) { fail(); terminateProcess(child); return; }
    buffer += chunk.toString('utf8');
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!awaiting || line !== awaiting.expected) { fail(); terminateProcess(child); return; }
      awaiting.resolve(); awaiting = undefined;
    }
  });
  child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) { fail(); terminateProcess(child); } });
  const done = new Promise<void>((resolve, reject) => { child.once('error', () => { fail(); reject(failure()); }); child.once('close', code => { fail(); code === 0 ? resolve() : reject(failure()); }); });
  void done.catch(() => {});
  const cancel = () => { fail(); terminateProcess(child); }; signal.addEventListener('abort', cancel, { once: true });
  const command = (text: string, expected: string) => new Promise<void>((resolve, reject) => { signal.throwIfAborted(); awaiting = { expected, resolve, reject }; child.stdin.write(text); });
  let committed = false;
  try {
    await command('start\n', 'start: ok');
    await command(`update refs/heads/${input.branch} ${input.next} ${input.previous}\nprepare\n`, 'prepare: ok');
    signal.throwIfAborted(); await apply(); signal.throwIfAborted();
    await command('commit\n', 'commit: ok'); committed = true; child.stdin.end(); await done;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!committed) { child.stdin.end('abort\n'); terminateProcess(child); }
    await done.catch(() => {});
  }
}
