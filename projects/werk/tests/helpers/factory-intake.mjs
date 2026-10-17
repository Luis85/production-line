/** @returns {import('../../src/shared/factory.ts').ProductionLine} */
export function productionLine(url, tokenEnv = 'LINE') {
  return { id: 'line', name: 'Fixture line', factoryId: 'factory', orchestratorUrl: url, webviewUrl: url, tokenEnv };
}

/** @returns {import('../../src/factory/application/intake.ts').IntakeTask} */
export function intakeTask(id = 'request') {
  return { id, factoryId: 'factory', task: { project: 'demo', title: 'Fixture task', criteria: ['Accepted'], wikilinks: [], provider: 'auto', priority: 1 }, lineId: null,
    status: 'queued', reason: '', destination: null, deliveryTask: null, deliveryPath: '/v1/tasks', remoteTaskId: null, createdAt: 1, updatedAt: 1 };
}
