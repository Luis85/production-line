import { readFile, readdir } from 'node:fs/promises';
import { endianness } from 'node:os';
import type { ProcessMeasurement } from '../../application/process-supervision.js';

let dimensions: { ticks: number; pageSize: number } | undefined;
async function kernelDimensions(signal: AbortSignal) {
  if (dimensions) return dimensions;
  // Linux publishes the actual clock frequency and page size in its auxiliary vector.
  // Do not assume either the common 100 ticks/s or 4096-byte page size.
  const aux = await readFile('/proc/self/auxv', { signal });
  const width = ['ia32', 'arm', 'mips', 'mipsel', 'ppc'].includes(process.arch) ? 4 : 8;
  const little = endianness() === 'LE';
  const word = (offset: number) => width === 8 ? Number(little ? aux.readBigUInt64LE(offset) : aux.readBigUInt64BE(offset)) : little ? aux.readUInt32LE(offset) : aux.readUInt32BE(offset);
  let ticks = 0, pageSize = 0;
  for (let offset = 0; offset + width * 2 <= aux.length; offset += width * 2) { const key = word(offset), value = word(offset + width); if (key === 17) ticks = value; if (key === 6) pageSize = value; if (key === 0) break; }
  if (!Number.isSafeInteger(ticks) || ticks <= 0 || !Number.isSafeInteger(pageSize) || pageSize <= 0) throw Error('Kernel measurement dimensions are unavailable.');
  return dimensions = { ticks, pageSize };
}
interface ProcessAccountingSource {
  platform: string;
  dimensions(signal: AbortSignal): Promise<{ ticks: number; pageSize: number }>;
  entries(): Promise<string[]>;
  stat(name: string, signal: AbortSignal): Promise<string>;
}
/** Read-only accounting with a five-second read budget; incomplete scans never publish partial totals. */
export async function sampleOwnedProcessGroup(groupId: number, signal?: AbortSignal, options: { source?: ProcessAccountingSource; timeoutMs?: number } = {}): Promise<ProcessMeasurement> {
  const source = options.source ?? systemAccounting;
  const timeoutMs = options.timeoutMs ?? 5000;
  const base: ProcessMeasurement = { scope: 'owned_service_process_group', platform: source.platform, capturedAt: new Date().toISOString(), cpuTotalMicros: null, rssBytes: null, processCount: null, coverage: 'unavailable', unavailableReason: null };
  if (source.platform !== 'linux') return { ...base, unavailableReason: 'Process-group CPU and memory sampling is available on Linux; lifecycle supervision remains active.' };
  if (!Number.isSafeInteger(groupId) || groupId <= 0) return { ...base, unavailableReason: 'The owned process group has no live identity.' };
  const bounded = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  try {
    bounded.throwIfAborted();
    const { ticks, pageSize } = await source.dimensions(bounded);
    bounded.throwIfAborted();
    const entries = await source.entries();
    bounded.throwIfAborted();
    let cpuTicks = 0, pages = 0, count = 0;
    for (const name of entries) {
      bounded.throwIfAborted();
      if (!/^\d+$/.test(name)) continue;
      let stat: string;
      try { stat = await source.stat(name, bounded); } catch (error) { if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; throw error; }
      bounded.throwIfAborted();
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (Number(fields[2]) !== groupId || fields[0] === 'Z') continue;
      const user = Number(fields[11]), system = Number(fields[12]), rss = Number(fields[21]);
      if (![user, system, rss].every(value => Number.isFinite(value) && value >= 0)) throw Error('Incomplete process accounting.');
      cpuTicks += user + system; pages += rss; count += 1;
    }
    bounded.throwIfAborted();
    if (!count) return { ...base, unavailableReason: 'The owned process group has exited or is not visible.' };
    return { ...base, capturedAt: new Date().toISOString(), cpuTotalMicros: Math.round(cpuTicks / ticks * 1000000), rssBytes: pages * pageSize, processCount: count, coverage: 'complete_group', unavailableReason: null };
  } catch { return { ...base, unavailableReason: bounded.aborted ? 'Process-group sampling was cancelled or exceeded its read budget.' : 'The operating system did not provide complete process-group counters.' }; }
}
const systemAccounting: ProcessAccountingSource = {
  platform: process.platform, dimensions: kernelDimensions, entries: () => readdir('/proc'),
  stat: (name, signal) => readFile('/proc/' + name + '/stat', { encoding: 'utf8', signal }),
};
