import { readFile, readdir } from 'node:fs/promises';
import { endianness } from 'node:os';
import type { ProcessMeasurement } from '../../application/process-supervision.js';

let dimensions: Promise<{ ticks: number; pageSize: number }> | undefined;
async function kernelDimensions() {
  // Linux publishes the actual clock frequency and page size in its auxiliary vector.
  // Do not assume either the common 100 ticks/s or 4096-byte page size.
  const aux = await readFile('/proc/self/auxv');
  const width = ['ia32', 'arm', 'mips', 'mipsel', 'ppc'].includes(process.arch) ? 4 : 8;
  const little = endianness() === 'LE';
  const word = (offset: number) => width === 8 ? Number(little ? aux.readBigUInt64LE(offset) : aux.readBigUInt64BE(offset)) : little ? aux.readUInt32LE(offset) : aux.readUInt32BE(offset);
  let ticks = 0, pageSize = 0;
  for (let offset = 0; offset + width * 2 <= aux.length; offset += width * 2) { const key = word(offset), value = word(offset + width); if (key === 17) ticks = value; if (key === 6) pageSize = value; if (key === 0) break; }
  if (!Number.isSafeInteger(ticks) || ticks <= 0 || !Number.isSafeInteger(pageSize) || pageSize <= 0) throw Error('Kernel measurement dimensions are unavailable.');
  return { ticks, pageSize };
}
/** Read-only group accounting. Caller must retain live ownership of this group leader. */
export async function sampleOwnedProcessGroup(groupId: number): Promise<ProcessMeasurement> {
  const base: ProcessMeasurement = { scope: 'owned_service_process_group', platform: process.platform, capturedAt: new Date().toISOString(), cpuTotalMicros: null, rssBytes: null, processCount: null, coverage: 'unavailable', unavailableReason: null };
  if (process.platform !== 'linux') return { ...base, unavailableReason: 'Process-group CPU and memory sampling is available on Linux; lifecycle supervision remains active.' };
  if (!Number.isSafeInteger(groupId) || groupId <= 0) return { ...base, unavailableReason: 'The owned process group has no live identity.' };
  try {
    const { ticks, pageSize } = await (dimensions ??= kernelDimensions());
    let cpuTicks = 0, pages = 0, count = 0;
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      let stat: string;
      try { stat = await readFile('/proc/' + name + '/stat', 'utf8'); } catch (error) { if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; throw error; }
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (Number(fields[2]) !== groupId || fields[0] === 'Z') continue;
      const user = Number(fields[11]), system = Number(fields[12]), rss = Number(fields[21]);
      if (![user, system, rss].every(value => Number.isFinite(value) && value >= 0)) throw Error('Incomplete process accounting.');
      cpuTicks += user + system; pages += rss; count += 1;
    }
    if (!count) return { ...base, unavailableReason: 'The owned process group has exited or is not visible.' };
    return { ...base, capturedAt: new Date().toISOString(), cpuTotalMicros: Math.round(cpuTicks / ticks * 1000000), rssBytes: pages * pageSize, processCount: count, coverage: 'complete_group', unavailableReason: null };
  } catch { return { ...base, unavailableReason: 'The operating system did not provide complete process-group counters.' }; }
}
