import { runProcess, type RunResult } from '../../shared/process/launcher.js';

export interface ApprovedToolProcessOptions {
  cwd: string; signal: AbortSignal; timeoutMs: number; maxOutputBytes: number;
  /** CLI text rendering opts in; fixed commands and verification keep their existing environment. */
  disableColor?: boolean;
  /** Every argument is operator-fixed (command presets, required checks), so cmd.exe may receive its command text verbatim. CLI tools append model arguments and never set this. */
  fixedArguments?: boolean;
}
/** Operator-granted tools share containment and credential isolation, but callers own authority, output and evidence. */
export function runApprovedToolProcess(executable: string, args: string[], options: ApprovedToolProcessOptions): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = Object.fromEntries(['PATH', 'PATHEXT', 'ComSpec', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  if (options.disableColor) Object.assign(env, { NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' });
  return runProcess(executable, args, { cwd: options.cwd, env, mode: 'contained', observation: { kind: 'tool', label: 'Approved command' }, signal: options.signal, timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes, captureStderr: true, allowNonZeroExit: true, verbatimCmd: options.fixedArguments === true });
}
