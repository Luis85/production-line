import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { immutableGitEnvironment } from '../infrastructure/git-environment.js';
import { gitContextSource } from '../context/git-source.js';
import { vaultRoot } from '../context/resolver.js';
import { identifier } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import { ApiError } from '../../shared/http/errors.js';
import { request } from '../../shared/http/client.js';
import type { Task } from '../../shared/contracts.js';
import type { TaskListResponse } from '../../shared/protocol.js';
import { collectIteration, submitIteration, IMPORT_LIMITS } from './iteration.js';
import type { IterationSource, IterationTaskGateway } from './iteration.js';

const exec = promisify(execFile);

async function gitSource(repo: string, branch: string): Promise<IterationSource> {
  const env = immutableGitEnvironment();
  const git = async (...args: string[]) => {
    try { return (await exec('git', ['--no-replace-objects', '--no-optional-locks', '-C', repo, '-c', 'core.fsmonitor=false', ...args], { env, maxBuffer: 4 * 1024 * 1024, timeout: 10000, killSignal: 'SIGKILL' })).stdout; }
    catch {
      throw new DomainError('invalid_input', `Cannot read iteration repository (${args[0]}): unavailable repository, timeout or output limit`);
    }
  };
  if (!branch || branch.length > 200 || /[\x00-\x20\x7f]/.test(branch) || branch.startsWith('-') || branch.includes('@{')) throw new DomainError('invalid_input', '--branch must name a local branch');
  await git('check-ref-format', 'refs/heads/' + branch);
  const commit = (await git('rev-parse', '--verify', '--end-of-options', 'refs/heads/' + branch + '^{commit}')).trim();
  const pinned = await gitContextSource(repo, commit);
  return {
    commit,
    files: async folder => pinned.files.filter(file => file.path.startsWith(folder + '/') && file.path.endsWith('.md')).map(file => file.path),
    read: async path => {
      const file = pinned.files.find(file => file.path === path);
      if (!file) throw new DomainError('invalid_input', 'Feature missing from pinned tree');
      try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await pinned.read(file)); }
      catch (error) { if (error instanceof DomainError) throw error; throw new DomainError('invalid_input', 'Feature note must be UTF-8'); }
    },
  };
}

function taskGateway(base: string, token: string, pinned: boolean): IterationTaskGateway {
  return {
    listTasks: async () => {
      const tasks: Task[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let bytes = 0;
      for (;;) {
        const query = new URLSearchParams({ limit: '100' });
        if (cursor !== undefined) query.set('cursor', cursor);
        const page = await request<TaskListResponse>(base, '/v1/tasks?' + query, token);
        if (!page || !Array.isArray(page.tasks) || page.tasks.some(task => !task || typeof task !== 'object' || Array.isArray(task) || typeof task.id !== 'string')
          || (page.hasMore === undefined ? page.nextCursor !== undefined
            : typeof page.hasMore !== 'boolean' || page.tasks.length > 100
              || (page.hasMore ? !page.tasks.length || typeof page.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(page.nextCursor) : page.nextCursor !== null))) {
          throw new ApiError(502, 'Invalid task page received during iteration import');
        }
        bytes += Buffer.byteLength(JSON.stringify(page.tasks), 'utf8');
        if (tasks.length + page.tasks.length > IMPORT_LIMITS.inventory || bytes > IMPORT_LIMITS.inventoryBytes) {
          throw new DomainError('too_large', 'Iteration inventory exceeds import limit; use a smaller line inventory');
        }
        tasks.push(...page.tasks);
        // Older servers omit page metadata and still return their complete inventory.
        if (page.hasMore !== true) return tasks;
        if (!page.tasks.length || typeof page.nextCursor !== 'string' || !page.nextCursor || cursors.has(page.nextCursor)) {
          throw new ApiError(502, 'Task pagination did not advance during iteration import');
        }
        cursor = page.nextCursor;
        cursors.add(cursor);
      }
    },
    createTask: async (input, key) => {
      try { return await request<Task>(base, pinned ? '/v1/iteration/tasks' : '/v1/tasks', token, 'POST', input, key); }
      catch (error) {
        if (error instanceof ApiError && error.status === 409) throw new DomainError('conflict', error.message);
        throw error;
      }
    },
  };
}

/** CLI composition boundary for local Git and remote task API adapters. */
export async function importIteration(options: Record<string, string>, token: string) {
  for (const key of ['repo', 'branch', 'project', 'iteration', 'iteration-pr']) {
    if (!options[key]) throw new DomainError('invalid_input', `--${key} required`);
  }
  if (options['dry-run'] !== undefined && !['true', 'false'].includes(options['dry-run'])) {
    throw new DomainError('invalid_input', '--dry-run must be true or false');
  }
  if (options.context !== undefined && options.context !== 'pinned') throw new DomainError('invalid_input', '--context only supports pinned; omit it for legacy import');
  if ((options.context === 'pinned') !== (options['vault-root'] !== undefined)) throw new DomainError('invalid_input', '--context pinned and --vault-root must be provided together');
  const root = options.context === 'pinned' ? (vaultRoot(options['vault-root']) || '.') : undefined;
  const project = identifier(options.project, 'project');
  const iteration = identifier(options.iteration, 'iteration');
  const features = options.features ?? 'docs/features';
  if (!features || features.length > 500 || features.startsWith('/') || features.split('/').some(part => !part || part === '..' || part === '.')
    || features.startsWith(':') || /[\\\x00-\x1f]/.test(features)) {
    throw new DomainError('invalid_input', '--features must be a literal repository-relative folder');
  }
  const source = await gitSource(options.repo, options.branch);
  const plan = await collectIteration(source, {
    project, iteration, branch: options.branch, features, iterationPrUrl: options['iteration-pr'], vaultRoot: root,
  });
  if (options['dry-run'] === 'true') return { mode: 'preview' as const, ...plan };
  const base = options.url ?? process.env.WERK_URL ?? 'http://127.0.0.1:3000';
  return submitIteration(plan, taskGateway(base, token, options.context === 'pinned'));
}
