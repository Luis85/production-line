import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { identifier, taskInput } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import type { ContextManifest } from '../../shared/context.js';
import type { Task, TaskInput } from '../../shared/contracts.js';

export interface IterationRequest {
  project: string;
  iteration: string;
  branch: string;
  features: string;
  iterationPrUrl: string;
  vaultRoot?: string;
}

/** All reads refer to one immutable commit, even if the planning branch moves. */
export interface IterationSource {
  commit: string;
  files(folder: string): Promise<string[]>;
  read(path: string): Promise<string>;
}

export interface IterationTaskGateway {
  listTasks(): Promise<Task[]>;
  createTask(input: TaskInput, key: string): Promise<Task>;
}

export interface ReadyIteration {
  branch: string;
  commit: string;
  ready: TaskInput[];
}

export interface ImportResult {
  featureId: string;
  taskId: string;
  status: 'created' | 'unchanged' | 'revision_required';
}

export const IMPORT_LIMITS = Object.freeze({ files: 1000, fileBytes: 512 * 1024, totalBytes: 8 * 1024 * 1024, inventory: 10000, inventoryBytes: 16 * 1024 * 1024 });

const sha256 = (source: string) => createHash('sha256').update(source).digest('hex');

export async function collectIteration(source: IterationSource, request: IterationRequest): Promise<ReadyIteration> {
  const ready: TaskInput[] = [];
  const identifiers = new Set<string>();
  const paths = await source.files(request.features);
  if (paths.length > IMPORT_LIMITS.files) throw new DomainError('too_large', 'Iteration exceeds feature file count limit');
  let bytes = 0;
  for (const path of paths) {
    const content = await source.read(path);
    const size = Buffer.byteLength(content, 'utf8');
    if (size > IMPORT_LIMITS.fileBytes || (bytes += size) > IMPORT_LIMITS.totalBytes) throw new DomainError('too_large', 'Iteration exceeds file or total byte limit');
    const frontmatter = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!frontmatter) continue;
    const document = parseDocument(frontmatter[1], { uniqueKeys: true });
    if (document.errors.length) throw new DomainError('invalid_input', `Invalid YAML frontmatter: ${path}`);
    let metadata: Record<string, unknown>;
    try { metadata = document.toJS({ maxAliasCount: 50 }) as Record<string, unknown>; }
    catch { throw new DomainError('invalid_input', `Invalid YAML aliases: ${path}`); }
    if (!metadata || metadata.factory_status !== 'ready_for_implementation' || metadata.factory_iteration !== request.iteration) continue;
    const featureId = identifier(metadata.factory_id, 'factory_id');
    if (identifiers.has(featureId)) throw new DomainError('invalid_input', 'Duplicate feature ID: ' + featureId);
    identifiers.add(featureId);
    let requirementRef: string | undefined;
    if (request.vaultRoot !== undefined) {
      const prefix = request.vaultRoot === '.' ? '' : request.vaultRoot + '/';
      if (!path.startsWith(prefix) || !path.endsWith('.md')) throw new DomainError('invalid_input', 'Feature path must be within the selected vault');
      requirementRef = '[[' + path.slice(prefix.length, -3) + ']]';
    }
    ready.push(taskInput({
      ...(requirementRef ? { requirementRef } : {}),
      project: request.project,
      title: metadata.title,
      criteria: metadata.factory_acceptance,
      wikilinks: metadata.factory_context === undefined ? [] : metadata.factory_context,
      provider: metadata.factory_provider ?? 'auto',
      priority: metadata.factory_priority ?? 1,
      source: {
        featureId,
        iterationId: request.iteration,
        branch: request.branch,
        commit: source.commit,
        path,
        iterationPrUrl: request.iterationPrUrl,
        specSha256: sha256(content),
      },
    }));
  }
  return { branch: request.branch, commit: source.commit, ready };
}

function sameFeature(left: TaskInput, right: TaskInput): boolean {
  return left.project === right.project && left.source?.iterationId === right.source?.iterationId
    && left.source?.featureId === right.source?.featureId;
}

function describeExisting(item: TaskInput, prior: Task): ImportResult {
  const previous = prior.source!;
  const planned = item.source!;
  const unchanged = previous.specSha256 === planned.specSha256 && previous.branch === planned.branch
    && previous.path === planned.path && previous.iterationPrUrl === planned.iterationPrUrl
    && (!item.requirementRef || (prior.context?.commit === planned.commit && prior.context.featureId === planned.featureId
      && prior.context.path === planned.path && prior.requirementRef === item.requirementRef));
  return { featureId: planned.featureId, taskId: prior.id, status: unchanged ? 'unchanged' : 'revision_required' };
}

/** Application import policy; transport failures are translated by the gateway adapter. */
export async function submitIteration(iteration: ReadyIteration, gateway: IterationTaskGateway) {
  let existing = await gateway.listTasks();
  const results: ImportResult[] = [];
  for (const item of iteration.ready) {
    const prior = existing.find(task => sameFeature(task, item));
    if (prior) {
      results.push(describeExisting(item, prior));
      continue;
    }
    const source = item.source!;
    const key = 'iteration:' + sha256(`${item.project}:${source.iterationId}:${source.featureId}`);
    try {
      const task = await gateway.createTask(item, key);
      existing.push(task);
      results.push({ featureId: source.featureId, taskId: task.id, status: 'created' });
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'conflict') throw error;
      // Concurrent import can win after our initial listing; do not silently overwrite it.
      existing = await gateway.listTasks();
      const concurrent = existing.find(task => sameFeature(task, item));
      if (!concurrent) throw error;
      results.push(describeExisting(item, concurrent));
    }
  }
  return {
    mode: 'import' as const,
    branch: iteration.branch,
    commit: iteration.commit,
    results,
    requiresDecision: results.some(result => result.status === 'revision_required'),
  };
}

/** Compare client planning metadata with source independently read by the server's own binding. */
export async function assertPinnedIteration(input: TaskInput, manifest: ContextManifest): Promise<void> {
  const source = input.source;
  if (!source || !input.requirementRef || source.commit !== manifest.commit
    || source.featureId !== manifest.requirement.featureId || source.path !== manifest.requirement.path) {
    throw new DomainError('invalid_input', 'Iteration source does not match the server-pinned requirement');
  }
  const root = manifest.files.find(file => file.path === manifest.requirement.path);
  if (!root || root.sha256 !== source.specSha256) throw new DomainError('invalid_input', 'Iteration specification hash does not match committed content');
  const checked = await collectIteration({ commit: manifest.commit, files: async () => [root.path], read: async () => root.content }, {
    project: manifest.project, iteration: source.iterationId, branch: source.branch, features: root.path,
    iterationPrUrl: source.iterationPrUrl, vaultRoot: manifest.vaultRoot,
  });
  // Branch and PR URL are declared planning metadata, never a verified remote identity.
  if (checked.ready.length !== 1 || JSON.stringify(checked.ready[0]) !== JSON.stringify(input)) {
    throw new DomainError('invalid_input', 'Iteration input does not match committed readiness, scheduling or feature metadata');
  }
}
