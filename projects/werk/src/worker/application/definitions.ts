import { SerializedOperations } from '../../shared/serialized-operations.js';
import { createHash, randomUUID } from 'node:crypto';
import { parseDocument, isAlias, isCollection, isPair, isScalar, visit } from 'yaml';
import { DomainError } from '../../shared/errors.js';
import { object, text, identifier } from '../../shared/contracts.js';
import type { DefinitionStorage } from './workspace-ports.js';
import { providerSupportsDefinition, type ProviderConnection } from './provider-contract.js';
export interface DefinitionAgent { name: string; description: string; instruction: string; model: string; provider: 'openai' | 'anthropic' | ''; unsupported: string[]; requiresAdaptation: boolean; }
/** `ref` is an operator-assigned stable name, unique per worker, that committed requests can use instead of the generated id. */
export interface AgentDefinition { id: string; ref?: string; name: string; digest: string; createdAt: string; updatedAt?: string; agents: DefinitionAgent[]; }
/** Bind an update to its reviewed definition and reference as well as its name and YAML content. */
export function definitionRevision(definition: Pick<AgentDefinition, 'id' | 'ref' | 'name' | 'digest'>): string { return createHash('sha256').update(JSON.stringify([definition.id, definition.ref ?? null, definition.name, definition.digest])).digest('hex'); }
const agentFields = ['description', 'instruction', 'model', 'provider', 'unsupported'] as const;
/** Summarize what an update changes without exposing more than the definition view already does. */
function definitionChanges(before: AgentDefinition, after: Pick<AgentDefinition, 'name' | 'digest' | 'agents'>) {
  const names = (value: Pick<AgentDefinition, 'agents'>) => value.agents.map(agent => agent.name);
  const changed = after.agents.flatMap(agent => {
    const previous = before.agents.find(item => item.name === agent.name);
    const fields = previous ? agentFields.filter(field => JSON.stringify(previous[field]) !== JSON.stringify(agent[field])) : [];
    return fields.length ? [{ name: agent.name, fields: [...fields] }] : [];
  });
  return {
    unchanged: before.name === after.name && before.digest === after.digest,
    name: before.name === after.name ? null : { from: before.name, to: after.name },
    digest: { from: before.digest, to: after.digest },
    agents: { added: names(after).filter(name => !names(before).includes(name)), removed: names(before).filter(name => !names(after).includes(name)), changed },
  };
}
export type DefinitionChanges = ReturnType<typeof definitionChanges>;
export interface DefinitionUpdateReceipt { id: string; ref?: string; revision: string; changes: DefinitionChanges; }
/** `warnings` is present only when an agent requires adaptation, so the caller sees it before any task waits. */
export interface DefinitionPreview { compatibility: 'instruction-profile'; agents: DefinitionAgent[]; warnings?: string[]; }
export interface DefinitionUpdatePreview extends DefinitionPreview {
  dryRun: true;
  definition: { id: string; ref: string; name: string; revision: string; nextRevision: string };
  changes: DefinitionChanges;
}
export interface DefinitionCatalog {
  compatibility: 'instruction-profile';
  definitions: (AgentDefinition & { revision: string })[];
  warnings?: string[];
}
export type DefinitionActionResult = DefinitionPreview | DefinitionUpdatePreview | DefinitionCatalog | (DefinitionCatalog & { updated: DefinitionUpdateReceipt });
/** Bounded so the remedies that follow survive the 500-character request error limit. */
function unsupportedList(items: string[]) {
  const shown: string[] = []; let length = 0;
  for (const item of items) { if (shown.length && length + item.length > 180) break; shown.push(item.slice(0, 160)); length += item.length + 2; }
  return shown.join(', ') + (items.length > shown.length ? ` and ${items.length - shown.length} more` : '');
}
function adaptationWarnings(agents: DefinitionAgent[]): string[] {
  return agents.filter(agent => agent.requiresAdaptation).map(agent => `Agent ${agent.name} requires adaptation: ${unsupportedList(agent.unsupported)}. Requests that select it need useInstructionsOnly: true, or fix the profile and run definition update.`);
}
function withWarnings<T extends object>(result: T, agents: DefinitionAgent[]): T & { warnings?: string[] } {
  const warnings = adaptationWarnings(agents);
  return warnings.length ? { ...result, warnings } : result;
}
export interface DefinitionSnapshot { definitionId: string; ref?: string; name: string; digest: string; agent: string; instruction: string; model: string; provider: DefinitionAgent['provider']; unsupported: string[]; adapted: boolean; }
function invalid(message: string): never { throw new DomainError('invalid_input', message); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const safeKey = (value: string) => /^[a-zA-Z0-9_-]{1,80}$/.test(value);
export const definitionReference = /^[a-z0-9][a-z0-9-]{0,79}$/;
function reference(value: unknown, name: string): string {
  if (typeof value !== 'string' || !definitionReference.test(value)) invalid(`${name} must use 1–80 lowercase letters, digits or hyphens, starting with a letter or digit.`);
  return value;
}
/** Validate selector syntax even when an existing task can reuse its frozen snapshot. */
export function definitionSelection(input: Record<string, unknown>): { definitionId?: string; definitionRef?: string } {
  const byId = input.definitionId !== undefined && input.definitionId !== '', byRef = input.definitionRef !== undefined && input.definitionRef !== '';
  if (byId && byRef) invalid('Choose a definition by definitionId or definitionRef, not both.');
  return byRef ? { definitionRef: reference(input.definitionRef, 'definitionRef') } : byId ? { definitionId: identifier(input.definitionId, 'definitionId') } : {};
}
const sensitiveKey = /^(?:api[_-]?key|api[_-]?token|access[_-]?token|password|secret|authorization|credentials|headers|env|environment|env_file)$/i;
const secretLiteral = /(?:\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9_.-]{16,})/i;
/** Parse data only. No includes, interpolation, tools, credentials or Docker process are evaluated. */
export function previewDefinition(source: unknown) {
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > 65536) invalid('Paste one Docker Agent YAML document, at most 64 KiB.');
  if (/\$\{/.test(source)) invalid('Resolve environment and file templates before importing; definitions never expand variables.');
  if (secretLiteral.test(source)) invalid('Remove credentials and private keys from the definition before importing. Configure provider credentials in Worker settings.');
  let document;
  try { document = parseDocument(source, { uniqueKeys: true, prettyErrors: false }); } catch { invalid('Invalid Docker Agent YAML.'); }
  if (document.errors.length || document.warnings.length) invalid('Invalid YAML: use one document without duplicate keys or custom tags.');
  let nodes = 0;
  visit(document, (_key, node, path) => {
    if (++nodes > 4000 || path.length > 24 || isAlias(node) || (record(node) && node.anchor) || (record(node) && node.tag)) invalid('Definition is too complex. YAML aliases, anchors and custom tags are not supported.');
    if (isPair(node) && isScalar(node.key) && (sensitiveKey.test(String(node.key.value)) || ['__proto__', 'constructor', 'prototype'].includes(String(node.key.value)))) invalid('Remove credential and environment fields before importing. Configure provider credentials in Worker settings.');
    if (isCollection(node) && node.items.length > 200) invalid('Definition contains too many entries.');
  });
  let value: unknown; try { value = document.toJS({ maxAliasCount: 0 }); } catch { invalid('Invalid Docker Agent YAML.'); }
  if (!record(value) || !record(value.agents) || !Object.keys(value.agents).length || Object.keys(value.agents).length > 24) invalid('A Docker Agent definition needs an agents mapping with 1–24 named agents.');
  const topUnsupported = Object.keys(value).filter(key => !['agents', 'models', 'version'].includes(key)).map(key => `document.${key}`);
  if (value.version !== undefined && !Array.from({ length: 17 }, (_, index) => String(index)).includes(String(value.version))) topUnsupported.push(`document.version "${String(value.version).replace(/[^a-zA-Z0-9_.+-]/g, '').slice(0, 40)}" (supported: 0–16)`);
  if (value.models !== undefined && !record(value.models)) invalid('models must be a mapping of names to model configurations.');
  const models = record(value.models) ? value.models : {};
  const agents: DefinitionAgent[] = [];
  for (const [name, raw] of Object.entries(value.agents)) {
    if (!safeKey(name) || !record(raw)) invalid('Agent names must use 1–80 letters, digits, underscores or hyphens.');
    if (Array.isArray(raw.instruction) && (raw.instruction.length > 100 || raw.instruction.some(item => typeof item !== 'string'))) invalid('Agent instruction list must contain up to 100 strings.');
    const instruction = text(Array.isArray(raw.instruction) ? raw.instruction.join('\n\n') : raw.instruction, 'Agent instruction', 16000);
    const description = raw.description === undefined ? '' : text(raw.description, 'Agent description', 1000);
    const unsupported = [...topUnsupported, ...Object.keys(raw).filter(key => !['instruction', 'description', 'model'].includes(key)).map(key => `agents.${name}.${key}`)];
    let model = '', provider: DefinitionAgent['provider'] = '';
    if (raw.model !== undefined) {
      if (typeof raw.model !== 'string' || raw.model.length > 200 || /[\x00-\x1f]/.test(raw.model)) invalid('Agent model must be a model name or named model reference.');
      const configured = Object.hasOwn(models, raw.model) ? models[raw.model] : raw.model;
      let modelName = '', providerName = '';
      if (typeof configured === 'string') {
        const slash = configured.indexOf('/');
        if (slash > 0) { providerName = configured.slice(0, slash); modelName = configured.slice(slash + 1); }
        else unsupported.push(`agents.${name}.model (unresolved provider)`);
      } else if (record(configured)) {
        if (configured.provider !== undefined && typeof configured.provider !== 'string') invalid('Named model provider must be a string.');
        if (configured.model !== undefined && typeof configured.model !== 'string') invalid('Named model name must be a string.');
        if (typeof configured.provider === 'string') providerName = configured.provider;
        if (typeof configured.model === 'string') modelName = configured.model;
        unsupported.push(...Object.keys(configured).filter(key => !['provider', 'model'].includes(key)).map(key => `models.${raw.model}.${key}`));
      } else invalid('Named models must be strings or model configuration mappings.');
      if (providerName === 'openai' || providerName === 'anthropic') {
        if (!modelName || modelName.length > 200 || /[\x00-\x1f]/.test(modelName)) invalid('The selected model needs a valid model name.');
        model = modelName; provider = providerName;
      } else if (!providerName) unsupported.push(`agents.${name}.model (unresolved provider)`);
      else if (providerName) unsupported.push(`agents.${name}.model (provider ${providerName.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)} is unavailable)`);
    }
    agents.push({ name, description, instruction, model, provider, unsupported: [...new Set(unsupported)], requiresAdaptation: unsupported.length > 0 });
  }
  if (agents.some(agent => agent.unsupported.length > 500 || agent.unsupported.some(path => path.length > 300))) invalid('Definition contains too many unsupported fields or long field names.');
  return { compatibility: 'instruction-profile' as const, agents };
}
export function validateSnapshot(value: unknown): asserts value is DefinitionSnapshot {
  if (!record(value)
    || typeof value.definitionId !== 'string' || !safeKey(value.definitionId)
    || (value.ref !== undefined && (typeof value.ref !== 'string' || !definitionReference.test(value.ref)))
    || typeof value.agent !== 'string' || !safeKey(value.agent)
    || typeof value.name !== 'string' || !value.name || value.name.length > 120
    || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)
    || typeof value.instruction !== 'string' || !value.instruction.trim() || value.instruction.length > 16000
    || typeof value.model !== 'string' || value.model.length > 200
    || typeof value.provider !== 'string' || !['', 'openai', 'anthropic'].includes(value.provider)
    || typeof value.adapted !== 'boolean'
    || !Array.isArray(value.unsupported) || value.unsupported.length > 500
    || value.unsupported.some(item => typeof item !== 'string' || item.length > 300)
    || (value.unsupported.length && !value.adapted)) invalid('Invalid saved agent definition snapshot.');
}
/** Validate persisted data before reading nested fields or restoring any catalog entry. */
function validateSavedDefinition(value: unknown): asserts value is AgentDefinition {
  if (!record(value) || !Array.isArray(value.agents) || !value.agents.length || value.agents.length > 24
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || (value.updatedAt !== undefined && (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))))) invalid('Invalid saved agent definitions.');
  for (const agent of value.agents) {
    if (!record(agent) || typeof agent.description !== 'string' || agent.description.length > 1000 || typeof agent.requiresAdaptation !== 'boolean') invalid('Invalid saved agent definition.');
    const snapshot = { definitionId: value.id, ref: value.ref, name: value.name, digest: value.digest, agent: agent.name, instruction: agent.instruction, model: agent.model, provider: agent.provider, unsupported: agent.unsupported, adapted: agent.requiresAdaptation };
    validateSnapshot(snapshot);
    if (agent.requiresAdaptation !== (snapshot.unsupported.length > 0)) invalid('Invalid saved agent definition.');
  }
  if (new Set(value.agents.map(agent => agent.name)).size !== value.agents.length) invalid('Invalid saved agent definitions.');
}
export function definitionConnection(connection: ProviderConnection, definition?: DefinitionSnapshot): ProviderConnection {
  if (!definition) return connection;
  validateSnapshot(definition);
  if (!providerSupportsDefinition(connection.id, definition.provider)) invalid(`This definition uses ${definition.provider}. Choose a matching worker provider.`);
  return { ...connection, model: definition.model || connection.model, instruction: definition.instruction };
}
export class WorkerDefinitions {
  private storage: DefinitionStorage; private definitions: AgentDefinition[] = []; private readonly writes = new SerializedOperations();
  constructor(storage: DefinitionStorage) { this.storage = storage; }
  async init() {
    const saved = await this.storage.read();
    if (saved !== undefined) {
      const value: unknown = JSON.parse(saved);
      if (!Array.isArray(value) || value.length > 32) invalid('Invalid saved agent definitions.');
      const definitions: AgentDefinition[] = [];
      for (const definition of value) { validateSavedDefinition(definition); definitions.push(definition); }
      if (new Set(definitions.map(item => item.id)).size !== definitions.length) invalid('Invalid saved agent definitions.');
      const refs = definitions.flatMap(item => item.ref === undefined ? [] : [item.ref]);
      if (new Set(refs).size !== refs.length) invalid('Invalid saved agent definition references.');
      this.definitions = definitions;
    }
  }
  view() { return { compatibility: 'instruction-profile' as const, definitions: this.definitions.map(item => ({ ...structuredClone(item), revision: definitionRevision(item) })) }; }
  /** Resolve once at task creation; the returned copy is what the task keeps, even if the reference later moves. */
  select(input: Record<string, unknown>): DefinitionSnapshot | undefined {
    const selection = definitionSelection(input);
    if (!selection.definitionId && !selection.definitionRef) {
      if (input.agent !== undefined && input.agent !== '') invalid('Choose a definition before selecting an agent.');
      return;
    }
    const definition = selection.definitionRef
      ? this.definitions.find(item => item.ref === selection.definitionRef)
      : this.definitions.find(item => item.id === selection.definitionId);
    if (!definition) throw new DomainError('not_found', selection.definitionRef ? `No agent definition on this worker uses the reference ${String(input.definitionRef)}. Import the shared profile with definition import --ref ${String(input.definitionRef)}, or assign it to an imported definition with definition ref.` : `Agent definition not found: no definition on this worker has the id ${String(selection.definitionId)}. Read current ids with definition list, or select a shared profile with definitionRef.`);
    const agent = definition.agents.find(item => item.name === (input.agent ?? 'root'));
    if (!agent) invalid('Choose an agent from the selected definition.');
    if (agent.requiresAdaptation && input.useInstructionsOnly !== true) invalid(`Agent ${agent.name} includes unsupported features: ${unsupportedList(agent.unsupported)}. Fix the profile and run definition update${definition.ref ? ' --ref ' + definition.ref : ''}, or set useInstructionsOnly: true in the request (Use instructions only) to run only its instructions.`);
    return { definitionId: definition.id, ...(definition.ref ? { ref: definition.ref } : {}), name: definition.name, digest: definition.digest, agent: agent.name, instruction: agent.instruction, model: agent.model, provider: agent.provider, unsupported: [...agent.unsupported], adapted: agent.requiresAdaptation };
  }
  async action(input: unknown): Promise<DefinitionActionResult> {
    const body = object(input, 'Agent definition', ['action', 'yaml', 'name', 'id', 'ref', 'revision', 'dryRun']);
    if (body.action === 'preview') { const preview = previewDefinition(body.yaml); return withWarnings(preview, preview.agents); }
    if (body.action === 'update' && body.dryRun === true) { const { preview } = this.update(this.definitions, body); return withWarnings(preview, preview.agents); }
    if (body.dryRun !== undefined && (body.action !== 'update' || body.dryRun !== false)) invalid('dryRun is supported only by definition update and must be true or false.');
    if (body.revision !== undefined && body.action !== 'update') invalid('A definition revision guards only definition update.');
    let updated: DefinitionUpdateReceipt | undefined, written: DefinitionAgent[] = [];
    const operation = this.writes.run(async () => {
      let next = structuredClone(this.definitions);
      if (body.action === 'import') {
        if (next.length >= 32) throw new DomainError('conflict', 'Delete an unused definition before importing another (limit 32).');
        const parsed = previewDefinition(body.yaml), name = text(body.name, 'Definition name', 120);
        const ref = body.ref === undefined || body.ref === '' ? undefined : reference(body.ref, 'Definition reference');
        const holder = ref && next.find(item => item.ref === ref);
        if (holder) throw new DomainError('conflict', `Definition reference ${ref} already selects ${holder.name}. Import without a reference, then move it with definition ref.`);
        written = parsed.agents;
        next.push({ id: randomUUID(), ...(ref ? { ref } : {}), name, digest: createHash('sha256').update(String(body.yaml)).digest('hex'), createdAt: new Date().toISOString(), agents: parsed.agents });
      } else if (body.action === 'ref') {
        // Moving a reference only affects tasks created afterwards; existing tasks keep their snapshots.
        const id = identifier(body.id, 'Definition id'), target = next.find(item => item.id === id);
        if (!target) throw new DomainError('not_found', 'Agent definition not found.');
        if (body.ref === '' || body.ref === null) delete target.ref;
        else {
          const ref = reference(body.ref, 'Definition reference');
          for (const item of next) if (item.ref === ref) delete item.ref;
          target.ref = ref;
        }
      } else if (body.action === 'update') {
        const { target, replacement, preview } = this.update(next, body);
        written = preview.agents;
        updated = { id: target.id, ref: preview.definition.ref, revision: preview.changes.unchanged ? preview.definition.revision : preview.definition.nextRevision, changes: preview.changes };
        if (preview.changes.unchanged) return;
        Object.assign(target, replacement);
      } else if (body.action === 'delete') {
        const id = identifier(body.id, 'Definition id'); if (!next.some(item => item.id === id)) throw new DomainError('not_found', 'Agent definition not found.');
        next = next.filter(item => item.id !== id);
      } else invalid('Definition action: preview|import|ref|update|delete.');
      const saved = JSON.stringify(next); if (Buffer.byteLength(saved) > 2097152) throw new DomainError('conflict', 'Definition storage is full. Delete an unused definition.');
      await this.storage.write(saved); this.definitions = next;
    });
    await operation; return withWarnings(updated ? { ...this.view(), updated } : this.view(), written);
  }
  /**
   * Replace the content behind a stable reference while keeping its id and reference.
   * Tasks already created keep their accepted snapshot; only later selections see the update.
   */
  private update(definitions: AgentDefinition[], body: Record<string, unknown>) {
    const ref = reference(body.ref, 'Definition reference'), target = definitions.find(item => item.ref === ref);
    if (!target) throw new DomainError('not_found', `No agent definition on this worker uses the reference ${ref}. Import it with that reference first.`);
    const revision = definitionRevision(target);
    if (body.revision !== undefined || body.dryRun !== true) {
      if (typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision)) invalid('Use the current definition revision from definition list or a definition update dry run.');
      if (body.revision !== revision) throw new DomainError('conflict', `Definition ${ref} changed. Read its current revision and review the update again.`);
    }
    const parsed = previewDefinition(body.yaml);
    const replacement = { name: body.name === undefined ? target.name : text(body.name, 'Definition name', 120), digest: createHash('sha256').update(String(body.yaml)).digest('hex'), agents: parsed.agents, updatedAt: new Date().toISOString() };
    const changes = definitionChanges(target, replacement);
    return { target, replacement, preview: { compatibility: 'instruction-profile' as const, dryRun: true as const, definition: { id: target.id, ref, name: replacement.name, revision, nextRevision: definitionRevision({ ...target, ...replacement }) }, changes, agents: parsed.agents } };
  }
}
