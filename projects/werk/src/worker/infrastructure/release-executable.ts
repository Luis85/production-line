import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { DomainError } from '../../shared/errors.js';

interface ResolutionOptions { platform?: NodeJS.Platform; nodeExecutable?: string; accessible?: (path: string) => Promise<boolean>; }
/** Resolve only the operator PATH or an explicit configured path. Windows containment never searches a project checkout. */
export async function releaseBuildLaunch(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, options: ResolutionOptions = {}) {
  const windows = (options.platform ?? process.platform) === 'win32', path = windows ? win32 : posix;
  const environment = (name: string) => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  const accessible = options.accessible ?? (async (candidate: string) => {
    try { if (!(await stat(candidate)).isFile()) return false; await access(candidate, constants.X_OK); return true; } catch { return false; }
  });
  let selected: string | undefined;
  if (windows ? /^node(?:\.exe)?$/i.test(executable) : executable === 'node') selected = options.nodeExecutable ?? process.execPath;
  else if (path.isAbsolute(executable) || executable.includes('/') || windows && executable.includes('\\')) {
    const candidate = path.resolve(cwd, executable); if (await accessible(candidate)) selected = candidate;
  } else {
    const extensions = windows ? (path.extname(executable) ? [''] : ['.exe', '.com', '.cmd', '.bat']) : [''];
    for (const entry of (environment('PATH') ?? '').split(windows ? ';' : ':')) {
      const directory = entry.replace(/^"(.*)"$/, '$1');
      if (!directory || !path.isAbsolute(directory)) continue;
      for (const extension of extensions) {
        const candidate = path.join(directory, executable + extension);
        if (await accessible(candidate)) { selected = candidate; break; }
      }
      if (selected) break;
    }
  }
  if (!selected || !path.isAbsolute(selected)) throw new DomainError('conflict', 'The configured release build executable is unavailable on the operator PATH.');
  if (!windows || !/\.(?:cmd|bat)$/i.test(selected)) return { executable: selected, args: [...args], verbatimCmd: false };
  // These values come only from an operator-approved committed build policy. Shell-variable expansion and embedded quoting stay unsupported.
  if ([selected, ...args].some(value => /[%!^"\r\n]/.test(value))) throw new DomainError('conflict', 'Windows batch build arguments cannot contain shell variables or embedded quotes. Use a native executable or Node script.');
  const systemRoot = environment('SystemRoot');
  if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new DomainError('conflict', 'Windows SystemRoot is unavailable for the approved batch build.');
  const shell = win32.join(systemRoot, 'System32', 'cmd.exe');
  if (!await accessible(shell)) throw new DomainError('conflict', 'Windows command shell is unavailable for the approved batch build.');
  const command = [selected, ...args].map(value => '"' + value + '"').join(' ');
  return { executable: shell, args: ['/d', '/s', '/c', command], verbatimCmd: true };
}
