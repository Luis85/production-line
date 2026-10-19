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
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
public static class WerkProviderJob {
  [StructLayout(LayoutKind.Sequential)] struct Security { public int Length; public IntPtr Descriptor; public int Inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int Size; public string Reserved, Desktop, Title; public int X, Y, Width, Height, CharsX, CharsY, Fill, Flags;
    public short Show, ReservedLength; public IntPtr ReservedPointer, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr Minimum, Maximum; public uint Active;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Counters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public Limits Basic; public Counters IO; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security security, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref Startup startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
  // Windows CRT argument quoting, including empty strings and trailing backslashes.
  static string Quote(string value) {
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); slashes = 0; result.Append(c);
    }
    return result.Append('\\', slashes * 2).Append('"').ToString();
  }
  static IntPtr CreateContainedJob() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero);
    var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) { CloseHandle(job); throw new InvalidOperationException("Provider job unavailable"); }
    return job;
  }
  static void PumpInput(Stream source, Stream destination) {
    var buffer = new byte[8192]; int count;
    while ((count = source.Read(buffer, 0, buffer.Length)) != 0) {
      destination.Write(buffer, 0, count);
      // Interactive protocols keep stdin open while waiting for each response.
      // Flush every read so small frames do not wait in FileStream's write buffer.
      destination.Flush();
    }
  }
  public static int Run(string executable, string[] arguments) {
    IntPtr job = IntPtr.Zero, inRead = IntPtr.Zero, inWrite = IntPtr.Zero, outRead = IntPtr.Zero, outWrite = IntPtr.Zero, errRead = IntPtr.Zero, errWrite = IntPtr.Zero;
    ProcessInfo child = new ProcessInfo(); FileStream input = null, output = null, error = null;
    try {
      IntPtr lifetimeJob = CreateContainedJob();
      if (!AssignProcessToJobObject(lifetimeJob, GetCurrentProcess())) { CloseHandle(lifetimeJob); throw new InvalidOperationException("Supervisor containment unavailable"); }
      // Deliberately retain this noninheritable handle until OS process exit. Closing
      // it here would kill the supervisor before it returns the provider exit code.
      job = CreateContainedJob();
      var security = new Security { Length = Marshal.SizeOf(typeof(Security)), Inherit = 1 };
      Check(CreatePipe(out inRead, out inWrite, ref security, 0)); Check(SetHandleInformation(inWrite, 1, 0));
      Check(CreatePipe(out outRead, out outWrite, ref security, 0)); Check(SetHandleInformation(outRead, 1, 0));
      Check(CreatePipe(out errRead, out errWrite, ref security, 0)); Check(SetHandleInformation(errRead, 1, 0));
      var startup = new Startup { Size = Marshal.SizeOf(typeof(Startup)), Flags = 0x100, Input = inRead, Output = outWrite, Error = errWrite };
      var command = new StringBuilder(Quote(executable)); foreach (string arg in arguments ?? new string[0]) command.Append(' ').Append(Quote(arg));
      // CREATE_SUSPENDED | CREATE_NO_WINDOW. Environment inherits the sanitized supervisor environment.
      Check(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, Environment.CurrentDirectory, ref startup, out child));
      if (!AssignProcessToJobObject(job, child.Process)) {
        TerminateProcess(child.Process, 125); WaitForSingleObject(child.Process, 5000); throw new InvalidOperationException("Provider containment unavailable");
      }
      Close(ref inRead); Close(ref outWrite); Close(ref errWrite);
      input = new FileStream(new SafeFileHandle(inWrite, true), FileAccess.Write); inWrite = IntPtr.Zero;
      output = new FileStream(new SafeFileHandle(outRead, true), FileAccess.Read); outRead = IntPtr.Zero;
      error = new FileStream(new SafeFileHandle(errRead, true), FileAccess.Read); errRead = IntPtr.Zero;
      Check(ResumeThread(child.Thread) != uint.MaxValue);
      var providerInput = input; var hostOutput = Console.OpenStandardOutput(); var hostError = Console.OpenStandardError();
      // Anonymous pipe handles are synchronous on .NET Framework. Starting an async
      // read here can block before the provider is resumed. Dedicated pumps keep all
      // blocking pipe I/O off the supervisor thread and avoid thread-pool starvation.
      Task.Factory.StartNew(() => { try { PumpInput(Console.OpenStandardInput(), providerInput); } catch (IOException) {} catch (ObjectDisposedException) {} finally { providerInput.Dispose(); } }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
      var providerOutput = output; var providerError = error;
      Task stdout = Task.Factory.StartNew(() => providerOutput.CopyTo(hostOutput), CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
      Task stderr = Task.Factory.StartNew(() => providerError.CopyTo(hostError), CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
      if (WaitForSingleObject(child.Process, uint.MaxValue) != 0) throw new InvalidOperationException("Provider wait failed");
      uint code; Check(GetExitCodeProcess(child.Process, out code));
      Check(TerminateJobObject(job, 125)); // Provider exited; terminate any remaining descendants before draining.
      Task.WaitAll(stdout, stderr); hostOutput.Flush(); hostError.Flush();
      return unchecked((int)code);
    } finally {
      if (job != IntPtr.Zero) TerminateJobObject(job, 125);
      if (input != null) input.Dispose(); if (output != null) output.Dispose(); if (error != null) error.Dispose();
      Close(ref inRead); Close(ref inWrite); Close(ref outRead); Close(ref outWrite); Close(ref errRead); Close(ref errWrite);
      Close(ref child.Thread); Close(ref child.Process); Close(ref job);
    }
  }
}
'@
  $spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Environment]::GetEnvironmentVariable('WERK_PROVIDER_LAUNCH')))
  [Environment]::SetEnvironmentVariable('WERK_PROVIDER_LAUNCH', $null)
  $launch = ConvertFrom-Json -InputObject $spec
  foreach ($entry in $launch.restoreEnvironment.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($entry.Name, $entry.Value)
  }
  $code = [WerkProviderJob]::Run([string]$launch.executable, [string[]]$launch.arguments)
  exit $code
} catch {
  [Console]::Error.WriteLine('Provider supervisor could not complete the contained invocation.')
  exit 125
}
`;

/**
 * Windows launch plan for a contained process: Windows PowerShell runs the job
 * supervisor above, which creates the real executable inside a kill-on-close job.
 * Paths and arguments travel as base64 JSON, never as script text.
 */
export function windowsContainment(executable: string, args: string[], env: NodeJS.ProcessEnv): { executable: string; args: string[]; env: NodeJS.ProcessEnv } {
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
    env: { ...supervisorEnv, WERK_PROVIDER_LAUNCH: Buffer.from(JSON.stringify({ executable, arguments: args, restoreEnvironment }), 'utf8').toString('base64') },
  };
}
