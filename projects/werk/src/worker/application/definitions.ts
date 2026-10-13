import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseDocument, isAlias, isCollection, isPair, isScalar, visit } from 'yaml';
import { DomainError } from '../../shared/errors.js';
import { object, text, identifier } from '../../shared/contracts.js';
import { atomicWrite, readBoundedFile } from '../infrastructure/journal/files.js';
import type { ProviderConnection } from '../infrastructure/providers.js';
export interface DefinitionAgent { name: string; description: string; instruction: string; model: string; provider: 'openai' | 'anthropic' | ''; unsupported: string[]; requiresAdaptation: boolean; }
export interface AgentDefinition { id: string; name: string; digest: string; createdAt: string; agents: DefinitionAgent[]; }
export interface DefinitionSnapshot { definitionId: string; name: string; digest: string; agent: string; instruction: string; model: string; provider: DefinitionAgent['provider']; unsupported: string[]; adapted: boolean; }
function invalid(message: string): never { throw new DomainError('invalid_input', message); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const safeKey = (value: string) => /^[a-zA-Z0-9_-]{1,80}$/.test(value);
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
  if (value.version !== undefined && !Array.from({ length: 17 }, (_, index) => String(index)).includes(String(value.version))) topUnsupported.push('document.version');
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
  if (!record(value) || typeof value.definitionId !== 'string' || !safeKey(value.definitionId) || typeof value.agent !== 'string' || !safeKey(value.agent) || typeof value.name !== 'string' || !value.name || value.name.length > 120 || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest) || typeof value.instruction !== 'string' || !value.instruction.trim() || value.instruction.length > 16000 || typeof value.model !== 'string' || value.model.length > 200 || !['', 'openai', 'anthropic'].includes(String(value.provider)) || typeof value.adapted !== 'boolean' || !Array.isArray(value.unsupported) || value.unsupported.length > 500 || value.unsupported.some(item => typeof item !== 'string' || item.length > 300) || (value.unsupported.length && !value.adapted)) invalid('Invalid saved agent definition snapshot.');
}
export function definitionConnection(connection: ProviderConnection, definition?: DefinitionSnapshot): ProviderConnection {
  if (!definition) return connection;
  validateSnapshot(definition);
  const family = connection.id === 'codex-cli' || connection.id === 'openai-api' ? 'openai' : 'anthropic';
  if (definition.provider && definition.provider !== family) invalid(`This definition uses ${definition.provider}. Choose a matching worker provider.`);
  return { ...connection, model: definition.model || connection.model, instruction: definition.instruction };
}
export class WorkerDefinitions {
  private directory: string; private definitions: AgentDefinition[] = []; private writes = Promise.resolve();
  constructor(directory: string) { this.directory = directory; }
  async init() {
    try {
      const value = JSON.parse(await readBoundedFile(join(this.directory, 'agent-definitions.json'), 2097152));
      if (!Array.isArray(value) || value.length > 32 || new Set(value.map(item => item.id)).size !== value.length) invalid('Invalid saved agent definitions.');
      for (const definition of value) {
        if (!Array.isArray(definition.agents) || !definition.agents.length || definition.agents.length > 24 || new Set(definition.agents.map((agent: DefinitionAgent) => agent.name)).size !== definition.agents.length || !Number.isFinite(Date.parse(definition.createdAt))) invalid('Invalid saved agent definitions.');
        for (const agent of definition.agents) { if (typeof agent.description !== 'string' || agent.description.length > 1000 || typeof agent.requiresAdaptation !== 'boolean' || agent.requiresAdaptation !== (agent.unsupported?.length > 0)) invalid('Invalid saved agent definition.'); validateSnapshot({ definitionId: definition.id, name: definition.name, digest: definition.digest, agent: agent.name, instruction: agent.instruction, model: agent.model, provider: agent.provider, unsupported: agent.unsupported, adapted: agent.requiresAdaptation }); }
      }
      this.definitions = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  view() { return { compatibility: 'instruction-profile' as const, definitions: structuredClone(this.definitions) }; }
  select(input: Record<string, unknown>): DefinitionSnapshot | undefined {
    if (input.definitionId === undefined || input.definitionId === '') {
      if (input.agent !== undefined && input.agent !== '') invalid('Choose a definition before selecting an agent.');
      return;
    }
    const definition = this.definitions.find(item => item.id === identifier(input.definitionId, 'definitionId'));
    if (!definition) throw new DomainError('not_found', 'Agent definition not found.');
    const agent = definition.agents.find(item => item.name === (input.agent ?? 'root'));
    if (!agent) invalid('Choose an agent from the selected definition.');
    if (agent.requiresAdaptation && input.useInstructionsOnly !== true) invalid('This definition includes unsupported features. Review them and explicitly choose Use instructions only before creating the task.');
    return { definitionId: definition.id, name: definition.name, digest: definition.digest, agent: agent.name, instruction: agent.instruction, model: agent.model, provider: agent.provider, unsupported: [...agent.unsupported], adapted: agent.requiresAdaptation };
  }
  async action(input: unknown) {
    const body = object(input, 'Agent definition', ['action', 'yaml', 'name', 'id']);
    if (body.action === 'preview') return previewDefinition(body.yaml);
    const operation = this.writes.catch(() => {}).then(async () => {
      let next = structuredClone(this.definitions);
      if (body.action === 'import') {
        if (next.length >= 32) throw new DomainError('conflict', 'Delete an unused definition before importing another (limit 32).');
        const parsed = previewDefinition(body.yaml), name = text(body.name, 'Definition name', 120);
        next.push({ id: randomUUID(), name, digest: createHash('sha256').update(String(body.yaml)).digest('hex'), createdAt: new Date().toISOString(), agents: parsed.agents });
      } else if (body.action === 'delete') {
        const id = identifier(body.id, 'Definition id'); if (!next.some(item => item.id === id)) throw new DomainError('not_found', 'Agent definition not found.');
        next = next.filter(item => item.id !== id);
      } else invalid('Definition action: preview|import|delete.');
      const saved = JSON.stringify(next); if (Buffer.byteLength(saved) > 2097152) throw new DomainError('conflict', 'Definition storage is full. Delete an unused definition.');
      await atomicWrite(join(this.directory, 'agent-definitions.json'), saved); this.definitions = next;
    });
    this.writes = operation; await operation; return this.view();
  }
}
