import { request } from '../http/client.js';
import { ValidationError } from '../errors.js';
import { ApiError } from '../http/errors.js';
import { taskInput } from '../validation.js';

                                              
                         
                          
                       
                    
                                      
                      
                                 
                 
                   
                     
                     
                   
                   
                   
                    
 
                                 
               
                      
                      
                                                                                                                    
 
                                                                                                                                                                                                                   
const str = (maxLength = 200)         => ({ type: 'string', minLength: 1, maxLength });
const id         = { ...str(100), pattern: '^[A-Za-z0-9_-]+$' };
const key         = { ...str(128), pattern: '^[A-Za-z0-9._:-]+$' };
const object = (properties                         = {}, required           = [])         => ({ type: 'object', properties, required, additionalProperties: false });
const nullableId         = { ...id, type: ['string', 'null'] };
const factoryFields = { id, name: str(120), parentId: nullableId };
const lineFields = { id, name: str(120), factoryId: id, orchestratorUrl: str(2000), webviewUrl: str(2000), tokenEnv: { ...str(128), pattern: '^WERK_LINE_[A-Z0-9_]+_TOKEN$' } };

export function validateArguments(value         , schema        , path = 'arguments')       {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (!types.includes(type) && !(types.includes('integer') && typeof value === 'number' && Number.isSafeInteger(value))) throw Error(`${path}: invalid type`);
  if (schema.enum && !schema.enum.includes(value)) throw Error(`${path}: unsupported value`);
  if (typeof value === 'string') {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value))) throw Error(`${path}: invalid string`);
  }
  if (typeof value === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) throw Error(`${path}: out of range`);
  if (Array.isArray(value)) {
    if (value.length > (schema.maxItems ?? 1000)) throw Error(`${path}: too many values`);
    if (schema.items) value.forEach(item => validateArguments(item, schema.items , path));
  } else if (value !== null && typeof value === 'object') {
    const record = value                           ;
    for (const field of schema.required ?? []) if (!Object.hasOwn(record, field)) throw Error(`${path}.${field}: required`);
    for (const [field, item] of Object.entries(record)) {
      const child = schema.properties?.[field];
      if (!child && schema.additionalProperties === false) throw Error(`${path}: unknown field`);
      if (child) validateArguments(item, child, `${path}.${field}`);
    }
  }
}

function operation(name        , description        , schema        , method        , path                   , body                    )            {
  const readOnly = method === 'GET';
  return { definition: { name, description, inputSchema: schema, annotations: { readOnlyHint: readOnly, destructiveHint: method === 'DELETE' || method === 'PATCH', idempotentHint: readOnly || schema.required?.includes('idempotencyKey') === true, openWorldHint: false } }, method, path, body };
}

const pageFields = {
  limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100, description: 'Maximum items in this page; default 100. Lower the limit if the response exceeds the MCP byte cap.' }          ,
  cursor: { ...str(1024), pattern: '^[A-Za-z0-9_-]+$', description: 'Opaque nextCursor from this same collection; omit only for the first page.' },
};
function paged(name        , description        , collection                                      , root                   , fields                         = {}, required           = [])            {
  return { ...operation(name, description + ' Returns hasMore and nextCursor. Continue with that cursor while hasMore is true; this page is not a complete inventory.',
    object({ ...fields, ...pageFields }, required), 'GET', args => {
      const query = new URLSearchParams({ limit: String(args.limit ?? 100) });
      if (args.cursor !== undefined) query.set('cursor', String(args.cursor));
      return root(args) + '?' + query;
    }), collection };
}
/** Fail closed if an older or invalid service omits continuation metadata. */
function validatePage(value         , collection                                      , args                         )       {
  const page = value && typeof value === 'object' && !Array.isArray(value) ? value                            : {};
  const items = page[collection], cursor = page.nextCursor;
  if (!Array.isArray(items) || items.length > Number(args.limit ?? 100) || typeof page.hasMore !== 'boolean' ||
      (page.hasMore ? !items.length || typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(cursor) || cursor === args.cursor : cursor !== null)) {
    throw new ApiError(502, 'Invalid paginated collection response');
  }
}

function operations(role      )              {
  const result              = [];
  if (role === 'factory') {
    const receipt = ' Stable idempotencyKey is scoped to the Factory registry database. The same key and intent replay the original result across restarts; different intent conflicts.';
    for (const [name, route, fields, required] of [
      ['factory', 'factories', factoryFields, ['id', 'name']],
      ['line', 'lines', lineFields, ['id', 'name', 'factoryId', 'orchestratorUrl', 'webviewUrl', 'tokenEnv']]
    ]         ) {
      const root = `/v1/${route}`;
      result.push(operation(`werk_${name}_list`, `List registered ${route}.`, object(), 'GET', () => root));
      result.push(operation(`werk_${name}_get`, `Read one registered ${name}.`, object({ id }, ['id']), 'GET', args => `${root}/${args.id}`));
      result.push(operation(`werk_${name}_create`, `Register a ${name}. Explicit stable ID required.` + receipt, object({ [name]: object(fields, [...required]), idempotencyKey: key }, [name, 'idempotencyKey']), 'POST', () => root, args => args[name]));
      const { id: _id, ...changes } = fields;
      result.push(operation(`werk_${name}_update`, `Update a registered ${name}; changes do not launch any service.` + receipt, object({ id, changes: object(changes), idempotencyKey: key }, ['id', 'changes', 'idempotencyKey']), 'PATCH', args => `${root}/${args.id}`, args => args.changes));
      result.push(operation(`werk_${name}_delete`, `Unregister a ${name}; factories must be empty. Does not stop processes.` + receipt, object({ id, idempotencyKey: key }, ['id', 'idempotencyKey']), 'DELETE', args => `${root}/${args.id}`));
    }
    result.push(operation('werk_factory_overview', 'Read hierarchy and production-line portfolio health; partial failures remain explicit.', object({ factoryId: id }), 'GET', args => '/v1/overview' + (args.factoryId ? `?factoryId=${args.factoryId}` : '')));
  } else {
    const taskSchema = object({ project: id, repository: { ...id, description: 'Optional worker repository assignment ID; defaults to the project ID. The production-line project remains unchanged.' }, requirementRef: str(500), title: str(200), criteria: { type: 'array', items: str(2000), maxItems: 30 }, wikilinks: { type: 'array', items: str(500), maxItems: 12 }, provider: { type: 'string', enum: ['auto', 'claude', 'codex'] }, executionMode: { type: 'string', enum: ['mock', 'cli'] }, priority: { type: 'integer', enum: [1, 2] }, source: { type: 'object' } }, ['project']);
    result.push(operation('werk_task_create', 'Submit a task using project + requirementRef (Obsidian wikilink), or an explicit feature payload. Stable idempotencyKey required. An operator-configured server binding may pin requirement context; Execution defaults to mock; explicit cli mode requires Codex and an operator-configured live worker. Live changes require manual review.', object({ task: taskSchema, idempotencyKey: key }, ['task', 'idempotencyKey']), 'POST', () => '/v1/tasks', args => { taskInput(args.task); return args.task; }));
    result.push(paged('werk_task_list', 'Read one bounded taskboard page (100 items by default).', 'tasks', () => '/v1/tasks'));
    result.push(operation('werk_task_get', 'Read one task.', object({ id }, ['id']), 'GET', args => `/v1/tasks/${args.id}`));
    result.push(paged('werk_task_events', 'Read one bounded lifecycle-event page for a task (100 items by default).', 'events', args => `/v1/tasks/${args.id}/events`, { id }, ['id']));
    result.push(paged('werk_workers_list', 'Read one bounded worker-capacity page without credentials (100 items by default).', 'workers', () => '/v1/workers'));
    result.push(operation('werk_snapshots_list', 'Read worker snapshots with cursor pagination; unknown cost remains null.', object({ project: id, worker: id, task: id, order: { type: 'string', enum: ['asc', 'desc'] }, after: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, before: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, limit: { type: 'integer', minimum: 1, maximum: 500 } }), 'GET', args => {
      if (args.after !== undefined && args.before !== undefined) throw Error('Use after or before, not both');
      if (args.before !== undefined && args.order !== 'desc') throw Error('before requires descending order');
      if (args.after !== undefined && args.order === 'desc') throw Error('after requires ascending order');
      const query = new URLSearchParams();for (const [key, value] of Object.entries(args)) query.set(key, String(value));
      return '/v1/snapshots?' + query;
    }));
    result.push(operation('werk_orchestrator_overview', 'Read production-line totals and health.', object(), 'GET', () => '/v1/overview'));
  }
  result.push(operation(`werk_${role}_health`, 'Read process health, which does not prove provider authentication or availability.', object(), 'GET', () => '/healthz'));
  return result;
}

export class ToolCatalog {
           definitions                  ;
          operations                        ;
          base        ;
          token        ;

  constructor(role      , base        , token        , allowWrites = false) {
    let url     ;
    try { url = new URL(base); } catch { throw new ValidationError('Invalid configured MCP API endpoint'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ValidationError('Invalid configured MCP API endpoint');
    if (token.length < 24 || /[\r\n]/.test(token)) throw new ValidationError('Configured MCP admin token is missing or invalid');
    this.base = base;this.token = token;
    const enabled = operations(role).filter(op => allowWrites || op.method === 'GET');
    this.operations = new Map(enabled.map(op => [op.definition.name, op]));
    this.definitions = enabled.map(op => op.definition);
  }

  has(name        )          { return this.operations.has(name); }

  async call(name        , args         )                   {
    const op = this.operations.get(name);
    if (!op) throw Error('Unknown or disabled tool');
    validateArguments(args, op.definition.inputSchema);
    const input = args                           ;
    try {
      const data = await request(this.base, op.path(input), this.token, op.method, op.body?.(input), input.idempotencyKey                      );
      if (op.collection) validatePage(data, op.collection, input);
      return this.redact(data);
    } catch (error) {
      // Never reflect a server message: it may echo Authorization or deployment secrets.
      if (error instanceof ApiError) throw Error(`Werk API request failed (HTTP ${error.status}). Check service authorization and input; no mutation is retried automatically.`);
      throw Error('Werk API operation failed. Check service availability and input; no mutation is retried automatically.');
    }
  }

          redact(value         )          {
    if (typeof value === 'string') return value.split(this.token).join('[REDACTED]');
    if (Array.isArray(value)) return value.map(item => this.redact(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.split(this.token).join('[REDACTED]'), /^(token|accessToken|refreshToken|password|secret|authorization|credentials)$/i.test(key) ? '[REDACTED]' : this.redact(item)]));
    return value;
  }
}
