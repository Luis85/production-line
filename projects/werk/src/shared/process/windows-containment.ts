import { windowsJobSource } from './windows-supervisor-source.js';
import { win32 } from 'node:path';

// The supervisor owns an outer lifetime job before creating a child. A suspended
// provider inherits it immediately, then joins an inner job before its code runs.
// Cancellation closes the outer handle even during inner-job assignment; normal
// exit kills the inner job before draining pipes. No cleanup relies on PID lookup.
const supervisor = String.raw`
$ErrorActionPreference = 'Stop'
# With redirected streams, progress (such as first-use module preparation) would
# reach the contained process's stderr as serialized CLIXML records.
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -TypeDefinition @'
${windowsJobSource}
'@
  $spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Environment]::GetEnvironmentVariable('WERK_PROVIDER_LAUNCH')))
  [Environment]::SetEnvironmentVariable('WERK_PROVIDER_LAUNCH', $null)
  $launch = ConvertFrom-Json -InputObject $spec
  foreach ($entry in $launch.restoreEnvironment.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($entry.Name, $entry.Value)
  }
  $code = [WerkProviderJob]::Run([string]$launch.executable, [string[]]$launch.arguments, [string]$launch.commandLine)
  exit $code
} catch {
  [Console]::Error.WriteLine('Provider supervisor could not complete the contained invocation.')
  exit 125
}
`;

const cmdSwitch = /^\/[A-Za-z](?::\w+)?$/;

/**
 * Command line for cmd.exe, built like Node's `shell: true` on Windows: switches
 * stay unquoted and the text after /c or /k is verbatim, wrapped in one pair of
 * outer quotes when /s is present. cmd.exe does not use C runtime quoting, so it
 * would misparse `"/d" "/s" "/c" "..."`. Returns null for any other executable or
 * for an argument shape this form does not describe, which keeps standard quoting.
 */
export function windowsCommandLine(executable: string, args: string[]): string | null {
  if (win32.basename(executable).toLowerCase() !== 'cmd.exe' || executable.includes('"')) return null;
  const run = args.findIndex(arg => /^\/[ck]$/i.test(arg));
  const switches = run < 0 ? args : args.slice(0, run + 1);
  if (!switches.every(arg => cmdSwitch.test(arg))) return null;
  const parts = [`"${executable}"`, ...switches];
  if (run >= 0 && run + 1 < args.length) {
    const text = args.slice(run + 1).join(' ');
    parts.push(switches.some(arg => arg.toLowerCase() === '/s') ? `"${text}"` : text);
  }
  return parts.join(' ');
}

/**
 * Windows launch plan for a contained process: Windows PowerShell runs the job
 * supervisor above, which creates the real executable inside a kill-on-close job.
 * Paths and arguments travel as base64 JSON, never as script text. A cmd.exe command
 * line is built verbatim only when the caller states that every argument is
 * operator-fixed; otherwise cmd.exe keeps the standard quoting.
 */
export function windowsContainment(executable: string, args: string[], env: NodeJS.ProcessEnv, verbatimCmd = false): { executable: string; args: string[]; env: NodeJS.ProcessEnv } {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) throw Error('Windows SystemRoot is unavailable');
  const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Windows PowerShell needs its OS installation/architecture context to resolve
  // built-in cmdlets and compile the helper. Restore the caller's environment
  // before creating the provider so these wrapper-only values never broaden it.
  const supervisorEnv = { ...env }, restoreEnvironment: Record<string, string | null> = {};
  const setRuntimeValue = (key: string, value: string) => {
    const matches = Object.keys(supervisorEnv).filter(candidate => candidate.toLowerCase() === key.toLowerCase()).sort();
    restoreEnvironment[key] = matches.length ? supervisorEnv[matches[0]] ?? null : null;
    for (const candidate of matches) delete supervisorEnv[candidate];
    supervisorEnv[key] = value;
  };
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'NUMBER_OF_PROCESSORS', 'OS'])
    if (process.env[key]) setRuntimeValue(key, process.env[key]!);
  if (process.env.PSModulePath) setRuntimeValue('PSModulePath', process.env.PSModulePath);
  // Windows PowerShell appends ';.CPL' to PATHEXT at startup, and without one it creates
  // 'PathEXT=.CPL', which stops cmd.exe resolving 'node'. Always restore the caller's
  // value exactly (or remove the variable) before the child is created.
  const callerPathext = Object.keys(env).filter(key => key.toLowerCase() === 'pathext').sort()[0];
  restoreEnvironment.PATHEXT = callerPathext === undefined ? null : env[callerPathext] ?? null;
  return {
    executable: powershell,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(supervisor, 'utf16le').toString('base64')],
    env: { ...supervisorEnv, WERK_PROVIDER_LAUNCH: Buffer.from(JSON.stringify({ executable, arguments: args, commandLine: (verbatimCmd ? windowsCommandLine(executable, args) : null) ?? undefined, restoreEnvironment }), 'utf8').toString('base64') },
  };
}
