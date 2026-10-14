import { open } from 'node:fs/promises';
import { inputError } from '../config.mjs';
export function workerCommands(catalog) {
  for (const name of ['get', 'plan', 'set']) catalog['feature folder ' + name] = { local: true, required: name === 'get' ? [] : ['path'], options: ['project-dir'], mutating: name === 'set', description: name === 'set' ? 'Persist a project folder change and move requests/results. Stop the worker first; destination must be new.' : 'Inspect or preview the saved project feature-folder path, without a running worker.' };
  const action = (path, action, required = ['id'], body = false, options = [], fields = {}) => ({ method: 'POST', path, action, required, body, options, fields });
  for (const name of ['get', 'validate', 'submit', 'cancel', 'retry', 'archive', 'restore', 'delete', 'result']) catalog['feature ' + name] = action('/api/features', name, ['name', ...(['get', 'validate', 'result'].includes(name) ? [] : ['if-match'])], false, [], { name: 'name', 'if-match': 'revision' });
  for (const name of ['create', 'edit']) catalog['feature ' + name] = { ...action('/api/features', name, ['name', 'markdown', ...(name === 'edit' ? ['if-match'] : [])], false, [], { name: 'name', 'if-match': 'revision' }), input: 'Frontmatter + Markdown from --markdown PATH or - (stdin), at most 64 KiB; status: draft.' };
  catalog['task retry'] = action('/api/tasks', 'retry');
  for (const name of ['rename', 'archive', 'restore', 'delete']) catalog['task ' + name] = action('/api/sessions', name, ['id', ...(name === 'rename' ? ['title'] : [])], false, [], { title: 'title' });
  catalog['session list'] = { method: 'GET', path: '/api/sessions' };
  catalog['session get'] = action('/api/tasks', 'get');
  for (const name of ['rename', 'archive', 'restore', 'delete', 'select']) catalog['session ' + name] = action('/api/sessions', name, ['id', ...(name === 'rename' ? ['title'] : [])], false, [], { title: 'title' });
  for (const name of ['cancel', 'retry', 'archive', 'restore', 'delete', 'priority']) catalog['file-task ' + name] = action('/api/taskboard/action', name, ['id', ...(name === 'priority' ? ['priority'] : [])], false, [], { priority: 'priority' });
  catalog['queue get'] = { method: 'GET', path: '/api/sessions', description: 'Serial executor and all session states. queue settings includes capacity and intake settings.' };
  catalog['queue settings'] = { method: 'GET', path: '/api/settings' };
  for (const name of ['pause', 'resume']) catalog['queue ' + name] = { method: 'POST', path: '/api/settings', fixedBody: { board: { paused: name === 'pause' } }, description: 'Pause/resume execution and new orchestrator claims; running work finishes. Queued work is retained.' };
  catalog['queue configure'] = { method: 'POST', path: '/api/settings', body: true, example: { board: { queueCapacity: 16, order: 'fifo', orchestratorQueue: 4 } } };
  catalog['task wait'] = { ...action('/api/tasks', 'get'), wait: 'task', options: ['timeout-ms'] };
  catalog['file-task wait'] = { ...action('/api/taskboard/detail', undefined), wait: 'file-task', options: ['timeout-ms'] };
  catalog['feature wait'] = { ...catalog['feature result'], wait: 'feature', options: ['timeout-ms'] };
  for (const [name, item] of Object.entries(catalog)) {
    if (['task list', 'session list', 'file-task list', 'feature list'].includes(name)) item.options = ['status', 'archived'];
    if (item.method === 'POST') { item.mutating = !item.wait && !['get', 'validate', 'result'].includes(item.action) && !name.endsWith(' get'); item.destructive = item.action === 'delete'; }
  }
  return catalog;
}
export async function workerBody(command, body, options) {
  if (command.fixedBody) return command.fixedBody;
  if (command.wait === 'file-task') return { id: options.id };
  if (!command.action) return body;
  if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body))) throw inputError('Command input must be an object.');
  if (body && ('action' in body || 'id' in body)) throw inputError('Action and target come from the command.');
  const result = { ...body, action: command.action, ...(options.id ? { id: options.id } : {}) };
  for (const [option, field] of Object.entries(command.fields ?? {})) if (options[option] !== undefined) result[field] = options[option];
  if (options.markdown) result.markdown = await readMarkdown(options.markdown);
  return result;
}
export function filterWorkerResult(result, options) {
  if (options.archived !== undefined && !['true', 'false'].includes(options.archived)) throw inputError('--archived must be true or false.');
  if (options.status === undefined && options.archived === undefined) return result;
  const filter = rows => rows.filter(row => (options.status === undefined || row.status === options.status) && (options.archived === undefined || !!row.archived === (options.archived === 'true')));
  return { ...result, ...(result.records ? { records: filter(result.records) } : {}), ...(result.tasks ? { tasks: filter(result.tasks) } : {}), ...(result.files ? { files: filter(result.files) } : {}) };
}
async function readMarkdown(path) {
  let handle; const chunks = []; let size = 0;
  try {
    if (path !== '-') { handle = await open(path, 'r'); if (!(await handle.stat()).isFile()) throw inputError('Markdown input must be a regular file.'); }
    for await (const chunk of handle ? handle.createReadStream() : process.stdin) { size += chunk.length; if (size > 65536) throw inputError('Markdown input exceeds 64 KiB.'); chunks.push(chunk); }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { await handle?.close(); }
}

export async function waitForWorker(request, kind, timeoutValue = '60000') {
  const timeout = Number(timeoutValue);
  if (!/^\d+$/.test(timeoutValue) || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 86400000) throw inputError('--timeout-ms must be 1–86400000.');
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await request();
    const state = kind === 'task' ? result.session?.status : kind === 'file-task' ? result.status : result.execution?.status ?? result.record?.status;
    if (['completed', 'review', 'failed', 'cancelled', 'unavailable'].includes(state)) return result;
    if (Date.now() >= deadline) throw Error('Wait timed out; task continues. Inspect it or cancel explicitly.');
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
  }
}
