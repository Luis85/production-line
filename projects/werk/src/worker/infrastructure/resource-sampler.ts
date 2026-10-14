import { statfs } from 'node:fs/promises';
import { availableParallelism, totalmem } from 'node:os';
import { getHeapStatistics } from 'node:v8';
import { randomUUID } from 'node:crypto';
import type { ResourceReading } from '../application/resources.js';

/** Process RSS/heap/CPU excludes provider subprocesses. Disk is only the configured state filesystem. */
export function resourceSampler(stateDirectory: string): () => Promise<ResourceReading> {
  const processStartId = randomUUID();
  return async () => {
    const unavailable: string[] = [], memory = process.memoryUsage(), cpu = process.cpuUsage(), monotonicMs = performance.now();
    let availableMemoryBytes: number | null = null, constrained: number | null = null;
    try { const value = process.availableMemory(); if (Number.isFinite(value) && value >= 0) availableMemoryBytes = value; } catch { /* Unsupported runtime measurement. */ }
    if (availableMemoryBytes === null) unavailable.push('available_memory');
    try { const value = process.constrainedMemory(); if (Number.isFinite(value) && value > 0) constrained = value; } catch { /* No known process constraint. */ }
    const hostTotal = totalmem(), effectiveMemoryLimitBytes = hostTotal > 0 ? Math.min(hostTotal, constrained ?? hostTotal) : constrained;
    if (effectiveMemoryLimitBytes === null) unavailable.push('memory_capacity');
    const disk = await statfs(stateDirectory).catch(() => null);
    if (!disk) unavailable.push('state_filesystem');
    return { processId: process.pid, processStartId, monotonicMs, cpuTotalMicros: cpu.user + cpu.system, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapLimitBytes: getHeapStatistics().heap_size_limit, effectiveMemoryLimitBytes, availableMemoryBytes, cpuCapacityCores: availableParallelism(), diskAvailableBytes: disk ? disk.bavail * disk.bsize : null, diskTotalBytes: disk ? disk.blocks * disk.bsize : null, unavailable };
  };
}
