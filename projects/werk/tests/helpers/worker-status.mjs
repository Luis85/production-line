/**
 * A complete worker status fixture. Individual tests override only the states
 * they exercise while retaining the public status contract.
 * @param {Partial<import('../../src/worker/status/monitoring.js').Status>} [overrides]
 * @returns {import('../../src/worker/status/monitoring.js').Status}
 */
export function workerStatus(overrides = {}) {
  return {
    workerId: null, project: null, mode: 'mock', state: 'standalone',
    taskId: null, attempt: null, profile: null, completedSimulations: 0,
    lastContact: null, lastError: null, updatedAt: '2026-10-17T00:00:00.000Z',
    profiles: [], heartbeatErrors: 0, maxParallel: 1, activeTasks: [],
    configurationHash: 'a'.repeat(64), lastSnapshot: null, ...overrides,
  };
}
