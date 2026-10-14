import { workerCommands } from './worker-commands.mjs';
// This catalog is both the command dispatcher and the automation discovery contract.
const op = (method, path, body = false, required = [], example) => ({ method, path, body, required, ...(example ? { example } : {}) });
export function commands(kind) {
  const common = { health: op('GET', '/healthz'), monitoring: op('GET', kind === 'worker' ? '/monitoring' : '/v1/monitoring') };
  if (kind === 'worker') return workerCommands({ ...common,
    'feature list': op('GET', '/api/features'),
    'settings get': op('GET', '/api/settings'), 'settings set': op('POST', '/api/settings', true, [], { board: { paused: true, queueCapacity: 16 } }),
    'definition list': op('GET', '/api/definitions'),
    'definition preview': op('POST', '/api/definitions', true, [], { yaml: 'agents:\n  root:\n    model: openai/gpt-4.1\n    instruction: Review the task and explain the next step.\n' }),
    'definition import': op('POST', '/api/definitions', true, [], { name: 'Project reviewer', yaml: 'agents:\n  root:\n    model: openai/gpt-4.1\n    instruction: Review the task and explain the next step.\n' }),
    'definition delete': op('POST', '/api/definitions', false, ['id']),
    'provider check': op('POST', '/api/providers/check', false, ['id']),
    'task list': op('GET', '/api/sessions'),
    'task create': op('POST', '/api/tasks', true, [], { id: 'ci-task-001', title: 'Plan a search page', provider: 'codex-cli', message: 'Draft acceptance criteria for a search page with filtering.' }),
    'task send': op('POST', '/api/tasks', true, ['id'], { message: 'Explain the next step.' }),
    'task get': op('POST', '/api/tasks', false, ['id']), 'task cancel': op('POST', '/api/tasks', false, ['id']),
    'session action': op('POST', '/api/sessions', true, [], { action: 'rename', id: 'ci-task-001', title: 'Architecture overview' }),
    'file-task create': op('POST', '/api/taskboard', true, [], { title: 'Explain a rule', instruction: 'Add a comment explaining the rule.', provider: 'codex-cli', repository: '/absolute/project', paths: ['acceptance.txt'] }), 'file-task list': op('GET', '/api/taskboard'),
    'file-task get': op('POST', '/api/taskboard/detail', false, ['id']), 'file-task action': op('POST', '/api/taskboard/action', true),
    environment: op('GET', '/api/environment'), history: op('GET', '/api/history') });
  const catalog = { ...common, overview: op('GET', '/v1/overview'),
    'routing get': op('GET', kind === 'factory' ? '/v1/factories/:id/routing' : '/v1/routing', false, kind === 'factory' ? ['id'] : []),
    'routing set': op('PUT', kind === 'factory' ? '/v1/factories/:id/routing' : '/v1/routing', true, kind === 'factory' ? ['id'] : []) };
  if (kind === 'factory') {
    for (const entity of ['factory', 'line']) {
      const path = '/v1/' + (entity === 'factory' ? 'factories' : 'lines');
      Object.assign(catalog, { [`${entity} list`]: op('GET', path), [`${entity} get`]: op('GET', path + '/:id', false, ['id']), [`${entity} create`]: op('POST', path, true, ['key']), [`${entity} update`]: op('PATCH', path + '/:id', true, ['id', 'key']), [`${entity} delete`]: op('DELETE', path + '/:id', false, ['id', 'key']) });
    }
    Object.assign(catalog, { 'intake list': op('GET', '/v1/intake'), 'intake create': op('POST', '/v1/intake', true, ['key']), 'intake route': op('PUT', '/v1/intake/:id/routing', true, ['id']), 'line interact': op('POST', '/v1/lines/:id/interaction', true, ['id']) });
  } else Object.assign(catalog, { 'task create': op('POST', '/v1/tasks', true, ['key']), 'task list': op('GET', '/v1/tasks'), 'task get': op('GET', '/v1/tasks/:id', false, ['id']), 'task events': op('GET', '/v1/tasks/:id/events', false, ['id']), 'task route': op('PUT', '/v1/tasks/:id/routing', true, ['id']), 'workers list': op('GET', '/v1/workers'), interact: op('POST', '/v1/interaction', true) });
  const task = { project: 'demo', title: 'Implement the requirement', criteria: ['Record evidence'], wikilinks: [], provider: 'codex' };
  catalog['routing set'].example = kind === 'factory' ? { mode: 'auto', lineId: null, paused: false } : { mode: 'auto', workerId: null, order: 'fifo' };
  if (kind === 'factory') {
    catalog['factory create'].example = { id: 'main', name: 'Project factory', parentId: null };
    catalog['line create'].example = { id: 'alpha', name: 'Alpha', factoryId: 'main', orchestratorUrl: 'http://127.0.0.1:3000', webviewUrl: 'http://127.0.0.1:3000', tokenEnv: 'WERK_LINE_ALPHA_TOKEN' };
    catalog['intake create'].example = { factoryId: 'main', task, lineId: null };
    catalog['intake route'].example = { lineId: 'alpha' };
  } else { catalog['task create'].example = task; catalog['task route'].example = { workerId: null }; }
  return catalog;
}
