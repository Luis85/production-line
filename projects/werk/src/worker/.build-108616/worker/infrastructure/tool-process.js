import { runProcess,                } from '../../shared/process/launcher.js';

                                             
                                                                              
                                                                                                     
                         
 
/** Operator-granted tools share containment and credential isolation, but callers own authority, output and evidence. */
export function runApprovedToolProcess(executable        , args          , options                            )                     {
  const env                    = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  if (options.disableColor) Object.assign(env, { NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' });
  return runProcess(executable, args, { cwd: options.cwd, env, mode: 'contained', signal: options.signal, timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes, captureStderr: true, allowNonZeroExit: true });
}
