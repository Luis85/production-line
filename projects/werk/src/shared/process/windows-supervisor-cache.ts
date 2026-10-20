import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { lstat, mkdtemp, readFile, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep, win32 } from 'node:path';
import { windowsCommandLine } from './windows-containment.js';
import { windowsSupervisorSource } from './windows-supervisor-source.js';

export interface WindowsSupervisorCompile {
  executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; input: string;
}
export type WindowsSupervisorCompiler = (plan: WindowsSupervisorCompile, signal: AbortSignal) => Promise<void>;
interface Identity { dev: number; ino: number; birthtimeMs: number; }
interface Artifact { directory: string; directoryIdentity: Identity; executable: string; identity: Identity; size: number; digest: string; }
interface Preparation { controller: AbortController; promise: Promise<void>; waiters: number; settled: boolean; }
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
const within = (base: string, target: string) => { const path = relative(base, target); return !path || !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep); };
const separate = (directory: string, cwd: string) => !within(cwd, directory) && !within(directory, cwd);
const bounded = (size: number) => size >= 2 && size <= 4 * 1024 * 1024;
const compilerScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$directory=[Environment]::GetEnvironmentVariable('WERK_SUPERVISOR_CACHE')
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().User
$security=New-Object Security.AccessControl.DirectorySecurity
$security.SetOwner($identity)
$security.SetAccessRuleProtection($true,$false)
$rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$security.AddAccessRule($rule)
[IO.Directory]::SetAccessControl($directory,$security)
$source=[Console]::In.ReadToEnd()
Microsoft.PowerShell.Utility\Add-Type -TypeDefinition $source -OutputAssembly ([IO.Path]::Combine($directory,'pending.exe')) -OutputType ConsoleApplication
`;

/** OS/compiler context only. A requested command's environment never enters compilation. */
function compilerEnvironment(directory: string): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) throw Error('Windows SystemRoot is unavailable');
  const env: NodeJS.ProcessEnv = { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: win32.join(systemRoot, 'System32'), TEMP: directory, TMP: directory, WERK_SUPERVISOR_CACHE: directory };
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'NUMBER_OF_PROCESSORS', 'OS'])
    if (process.env[key]) env[key] = process.env[key];
  env.PSModulePath = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  return env;
}

/**
 * Process-private executable cache under the same trust boundary as installed runtime files.
 * Nothing is adopted across processes/restarts. Identity and hash checks detect drift; they are
 * not a Windows write lock and do not claim to defeat concurrent code running as this same user.
 */
export class WindowsSupervisorCache {
  private artifact?: Artifact;
  private preparation?: Preparation;
  private disabled = false;
  private directory?: string;
  private directoryIdentity?: Identity;
  private readonly onExit = () => { void this.close(); };
  private readonly temporaryRoot: string;
  constructor(temporaryRoot = tmpdir()) { this.temporaryRoot = temporaryRoot; process.once('exit', this.onExit); }

  private cleanup() {
    if (!this.directory || !this.directoryIdentity) return;
    try {
      const info = lstatSync(this.directory);
      if (info.isDirectory() && !info.isSymbolicLink() && same(info, this.directoryIdentity) && realpathSync(this.directory) === this.directory)
        rmSync(this.directory, { recursive: true, force: true });
    } catch { /* An executing Windows image may remain locked until its supervisor exits. */ }
  }

  private async compile(compile: WindowsSupervisorCompiler, cwd: string, signal: AbortSignal) {
    const parent = await realpath(this.temporaryRoot), workspace = await realpath(cwd);
    if (parent.startsWith('\\\\') || within(workspace, parent)) throw Error('Supervisor cache must be outside the project on a local filesystem');
    signal.throwIfAborted();
    const directory = await realpath(await mkdtemp(join(parent, 'werk-supervisor-')));
    this.directory = directory; this.directoryIdentity = await lstat(directory);
    if (!separate(directory, workspace)) throw Error('Supervisor cache overlaps the project');
    const env = compilerEnvironment(directory);
    await compile({ executable: win32.join(env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(compilerScript, 'utf16le').toString('base64')], cwd: directory, env, input: windowsSupervisorSource }, signal);
    signal.throwIfAborted();
    const current = await lstat(directory), pending = join(directory, 'pending.exe');
    if (!current.isDirectory() || current.isSymbolicLink() || !same(current, this.directoryIdentity) || await realpath(directory) !== directory) throw Error('Supervisor cache identity changed');
    const info = await lstat(pending);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !bounded(info.size) || await realpath(pending) !== pending) throw Error('Supervisor compilation produced no ordinary bounded executable');
    const bytes = await readFile(pending);
    if (bytes.length !== info.size || bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw Error('Supervisor compilation produced an invalid executable');
    const after = await lstat(pending);
    if (!same(info, after) || info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw Error('Supervisor executable changed during compilation');
    const executable = join(directory, 'supervisor.exe');
    await rename(pending, executable); signal.throwIfAborted();
    this.artifact = { directory, directoryIdentity: current, executable, identity: after, size: bytes.length, digest: digest(bytes) };
    if (!this.plan('fixture', [], {}, cwd)) throw Error('Supervisor executable changed before publication');
  }

  async prepare(compile: WindowsSupervisorCompiler, cwd: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.disabled || this.artifact) return;
    try { cwd = realpathSync(cwd); } catch { return; }
    let pending = this.preparation;
    if (!pending) {
      pending = { controller: new AbortController(), promise: Promise.resolve(), waiters: 0, settled: false };
      this.preparation = pending;
      const current = pending;
      current.promise = this.compile(compile, cwd, current.controller.signal).catch(() => {
        if (!current.controller.signal.aborted) this.disabled = true;
        this.artifact = undefined; this.cleanup();
      }).finally(() => { current.settled = true; if (this.preparation === current) this.preparation = undefined; });
    }
    pending.waiters++;
    let abort!: () => void;
    const interrupted = new Promise<void>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
    try { await Promise.race([pending.promise, interrupted]); signal.throwIfAborted(); }
    finally {
      signal.removeEventListener('abort', abort); pending.waiters--;
      if (!pending.waiters && !pending.settled && signal.aborted) { pending.controller.abort(); await pending.promise; }
    }
    if (pending.controller.signal.aborted && !this.disabled) await this.prepare(compile, cwd, signal);
  }

  /** Revalidate every invocation, including a later project with a different working directory. */
  plan(executable: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, verbatimCmd = false) {
    const saved = this.artifact;
    if (!saved || this.disabled) return undefined;
    let workspace: string;
    try { workspace = realpathSync(cwd); } catch { return undefined; }
    try {
      if (!separate(saved.directory, workspace)) throw Error('Supervisor cache overlaps the project');
      const directory = lstatSync(saved.directory), info = lstatSync(saved.executable);
      if (!directory.isDirectory() || directory.isSymbolicLink() || !same(directory, saved.directoryIdentity) || realpathSync(saved.directory) !== saved.directory ||
          !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !same(info, saved.identity) || info.size !== saved.size || !bounded(info.size) || realpathSync(saved.executable) !== saved.executable ||
          digest(readFileSync(saved.executable)) !== saved.digest) throw Error('Supervisor cache changed');
      const commandLine = verbatimCmd ? windowsCommandLine(executable, args) : null;
      const targetEnvironment = { ...env };
      for (const key of Object.keys(targetEnvironment)) if (key.toUpperCase() === 'WERK_PROVIDER_LAUNCH' || key.toUpperCase() === 'WERK_SUPERVISOR_CACHE') delete targetEnvironment[key];
      return { executable: saved.executable, args: ['werk-supervisor-v1', commandLine === null ? 'argv' : 'raw', executable, ...(commandLine === null ? args : [commandLine])], env: targetEnvironment };
    } catch { this.disabled = true; this.artifact = undefined; this.cleanup(); return undefined; }
  }

  async close() {
    this.disabled = true;
    const pending = this.preparation; pending?.controller.abort();
    this.artifact = undefined; this.cleanup(); process.removeListener('exit', this.onExit);
    await pending?.promise; this.cleanup();
  }
}
