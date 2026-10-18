import { randomUUID } from 'node:crypto';
import { withProcessObserver, type ObservedLaunch, type ProcessPurpose } from '../../shared/process/observation.js';
import type { ObservedProcessKind, ObservedProcessMeasurement, ObservedProcessRecord, ObservedProcessStatus, ProcessObservation, ProcessObservationContext } from '../application/process-observation.js';
import type { ProcessMeasurement } from '../application/process-supervision.js';
import { sampleOwnedProcessGroup } from './processes/sampler.js';

interface Entry { record: ObservedProcessRecord; launch?: ObservedLaunch; }
interface ObservationOptions { sampleGroup?: (groupId: number) => Promise<ProcessMeasurement>; }
const kinds = new Set<ObservedProcessKind>(['provider', 'tool', 'mcp', 'git', 'other']);
const labels: Record<ObservedProcessKind, string> = { provider: 'Model provider', tool: 'Approved command', mcp: 'MCP connection', git: 'Git operation', other: 'Worker process' };
const live = (entry: Entry) => !!entry.launch?.child.pid && entry.record.state === 'running' && entry.launch.child.exitCode === null && entry.launch.child.signalCode === null;
const unknown = (reason: string): ObservedProcessMeasurement => ({ scope: 'owned_execution_process_group', platform: process.platform,
  capturedAt: new Date().toISOString(), cpuTotalMicros: null, rssBytes: null, processCount: null, coverage: 'unavailable', unavailableReason: reason });
const numeric = (value: number | null) => value !== null && Number.isFinite(value) && value >= 0;

/** Ephemeral observation only: no process identity survives restart and this registry never sends signals. */
export function createProcessObservation(options: ObservationOptions = {}): ProcessObservation {
  const entries: Entry[] = [];
  const sampleGroup = options.sampleGroup ?? sampleOwnedProcessGroup;
  let timer: ReturnType<typeof setInterval> | undefined, sampling: Promise<void> | undefined, sampledAt = 0;
  const active = () => entries.filter(entry => entry.record.state === 'running');
  const prune = () => {
    let completed = entries.filter(entry => entry.record.state !== 'running').length;
    for (let index = 0; completed > 100 && index < entries.length;) {
      if (entries[index].record.state !== 'running') { entries.splice(index, 1); completed--; } else index++;
    }
  };
  const sample = (): Promise<void> => {
    if (sampling) return sampling;
    sampling = Promise.all(active().map(async entry => {
      if (!live(entry)) return;
      const launch = entry.launch!;
      let measurement: ObservedProcessMeasurement;
      if (!launch.ownsProcessGroup) measurement = unknown(process.platform === 'win32' ? 'Process-group CPU and memory sampling is available on Linux.' : 'This process shares an existing group; separate counters are unavailable.');
      else try {
        const value = await sampleGroup(launch.child.pid!);
        measurement = value.coverage === 'complete_group' && numeric(value.cpuTotalMicros) && numeric(value.rssBytes) && numeric(value.processCount) && value.processCount! > 0
          ? { scope: 'owned_execution_process_group', platform: value.platform, capturedAt: value.capturedAt, cpuTotalMicros: value.cpuTotalMicros, rssBytes: value.rssBytes, processCount: value.processCount, coverage: 'complete_group', unavailableReason: null }
          : unknown(value.unavailableReason ?? 'The operating system did not provide complete process-group counters.');
      } catch { measurement = unknown('Process-group counters are temporarily unavailable.'); }
      // A PID alone is never authority. Ignore late samples after this live handle has exited.
      if (entry.launch === launch && live(entry)) entry.record.measurement = measurement;
    })).then(() => { sampledAt = Date.now(); }).finally(() => { sampling = undefined; });
    return sampling;
  };
  const observe = (context: ProcessObservationContext, launch: ObservedLaunch, purpose?: ProcessPurpose) => {
    const requestedKind = purpose?.kind ?? context.kind ?? 'other';
    const kind = kinds.has(requestedKind as ObservedProcessKind) ? requestedKind as ObservedProcessKind : 'other';
    const label = (purpose?.label ?? context.label ?? labels[kind]).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120) || labels[kind];
    const entry: Entry = { launch, record: { id: randomUUID(), kind, label,
      featureRequestKey: context.featureRequestKey ?? null, sessionId: context.sessionId ?? null, taskId: context.taskId ?? null, runId: context.runId ?? null,
      state: 'running', startedAt: new Date().toISOString(), endedAt: null, exitCode: null, measurement: null } };
    entries.push(entry);
    launch.child.once('error', () => { launch.failed = true; });
    launch.child.once('close', code => {
      entry.record.state = launch.failed || code !== 0 ? 'failed' : 'exited';
      entry.record.exitCode = code; entry.record.endedAt = new Date().toISOString();
      entry.launch = undefined;
      prune();
      if (!active().length && timer) { clearInterval(timer); timer = undefined; }
    });
    // A background sample does not keep an otherwise finished worker alive.
    timer ??= setInterval(() => { void sample(); }, 1000);
    timer.unref();
    if (Date.now() - sampledAt >= 1000) void sample();
  };
  const status = async (): Promise<ObservedProcessStatus> => {
    if (sampling) await sampling;
    if (Date.now() - sampledAt >= 1000 || active().some(entry => entry.record.measurement === null)) await sample();
    const processes = entries.map(entry => structuredClone(entry.record));
    const running = processes.filter(record => record.state === 'running');
    const measured = running.filter(record => record.measurement?.coverage === 'complete_group');
    const covered = measured.length, total = running.length;
    return { schemaVersion: 1, scope: 'worker_launched_finite_processes', capturedAt: new Date().toISOString(), sampleIntervalMs: 1000,
      retention: { limit: 100, scope: 'current_worker_process' }, processes,
      summary: { active: total, total: processes.length, activeGroups: total, measuredGroups: covered,
        rssBytes: covered || !total ? measured.reduce((sum, record) => sum + record.measurement!.rssBytes!, 0) : null,
        cpuTotalMicros: covered || !total ? measured.reduce((sum, record) => sum + record.measurement!.cpuTotalMicros!, 0) : null,
        coverage: covered === total ? 'complete' : covered ? 'partial' : 'unavailable' } };
  };
  return { run(context, operation) {
    const identity = { ...context };
    return withProcessObserver((launch, purpose) => observe(identity, launch, purpose), operation);
  }, status };
}
