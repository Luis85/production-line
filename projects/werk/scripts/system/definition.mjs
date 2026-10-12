import { normalizeExecution } from '../runtime/execution.mjs';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createRequire } from 'node:module';

const requireYaml = createRequire(new URL('../../src/orchestrator/dist/package.json', import.meta.url));
const MAX_BYTES = 64 * 1024;
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?![\s\S])/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const error = message => Object.assign(new Error(message), { code: 'INVALID_SYSTEM_DEFINITION', exitCode: 2 });

function object(value, keys, label, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw error(`${label}: expected an object.`);
  if (Object.keys(value).some(key => !keys.includes(key))) throw error(`${label}: unknown field; use the system definition schema. Secrets and tasks do not belong in this file.`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw error(`${label}.${key}: required field is missing.`);
  return value;
}
function slug(value, label) {
  if (typeof value !== 'string' || value.length > 63 || !SLUG.test(value) || RESERVED.test(value)) throw error(`${label}: use a lowercase slug of 1–63 characters, starting with a letter; reserved device names are not allowed.`);
  return value;
}
function name(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\x00-\x1f\x7f]/.test(value)) throw error(`${label}: use a nonempty name of at most 120 characters without control characters.`);
  return value.trim();
}
function port(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw error(`${label}: use an integer port from 1 to 65535.`);
  return value;
}
function environment(value) {
  if (!['native', 'docker'].includes(value)) throw error('environment: expected native or docker.');
  return value;
}
function webviewUrl(value, label) {
  if (typeof value !== 'string' || value.length > 2048 || !/^https:\/\/[^\s/@?#\\]+\/?$/.test(value) || /[^\x21-\x7e]/.test(value)) throw error(`${label}: use an HTTPS origin without credentials, path, query or fragment.`);
  let url;
  try { url = new URL(value); } catch { throw error(`${label}: invalid HTTPS origin.`); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw error(`${label}: use an HTTPS origin without credentials, path, query or fragment.`);
  return url.href;
}
/** Return a new object with stable field order, no unknown fields and no secrets. */
export function validateDefinition(value) {
  object(value, ['schemaVersion', 'id', 'environment', 'factory', 'productionLines'], 'system');
  if (value.schemaVersion !== 1) throw error('schemaVersion: expected 1.');
  const id = slug(value.id, 'id');
  const selected = environment(value.environment);
  object(value.factory, ['id', 'name', 'port', 'subFactories'], 'factory', ['id', 'name', 'port']);
  const factory = { id: slug(value.factory.id, 'factory.id'), name: name(value.factory.name, 'factory.name'), port: port(value.factory.port, 'factory.port') };
  const children = value.factory.subFactories === undefined ? [] : value.factory.subFactories;
  if (!Array.isArray(children) || children.length > 31) throw error('factory.subFactories: expected at most 31 subfactories (32 factories including the root).');
  const factories = new Map([[factory.id, factory]]);
  const unsorted = children.map((child, index) => {
    const label = `factory.subFactories[${index}]`;
    object(child, ['id', 'name', 'parentId'], label, ['id', 'name']);
    const normalized = { id: slug(child.id, `${label}.id`), name: name(child.name, `${label}.name`), parentId: child.parentId === undefined ? factory.id : slug(child.parentId, `${label}.parentId`) };
    if (factories.has(normalized.id)) throw error(`${label}.id: duplicate factory identifier or root listed as a child.`);
    factories.set(normalized.id, normalized);
    return normalized;
  });
  // Normalize parents before children so both provisioning adapters can use this order.
  const ordered = [], visiting = new Set(), visited = new Set([factory.id]);
  function visitFactory(child) {
    if (visited.has(child.id)) return;
    if (visiting.has(child.id)) throw error('factory.subFactories: parent cycle is not allowed.');
    if (!factories.has(child.parentId)) throw error('factory.subFactories: every parentId must identify the root or another subfactory.');
    visiting.add(child.id);
    visitFactory(factories.get(child.parentId));
    visiting.delete(child.id); visited.add(child.id); ordered.push(child);
  }
  for (const child of unsorted) visitFactory(child);
  factory.subFactories = ordered;
  if (!Array.isArray(value.productionLines) || value.productionLines.length < 1 || value.productionLines.length > 8) throw error('productionLines: expected 1–8 production lines.');
  const ids = new Set();
  const ports = new Map([[factory.port, 'factory.port']]);
  const reserve = (number, label) => {
    if (ports.has(number)) throw error(`${label}: port ${number} overlaps ${ports.get(number)}.`);
    ports.set(number, label);
  };
  const productionLines = value.productionLines.map((line, index) => {
    const label = `productionLines[${index}]`;
    object(line, ['id', 'name', 'factoryId', 'project', 'orchestrator', 'workers'], label, ['id', 'name', 'project', 'orchestrator', 'workers']);
    const factoryId = line.factoryId === undefined ? factory.id : slug(line.factoryId, `${label}.factoryId`);
    if (!factories.has(factoryId)) throw error(`${label}.factoryId: unknown factory identifier.`);
    const lineId = slug(line.id, `${label}.id`);
    if (ids.has(lineId)) throw error(`${label}.id: duplicate production line identifier.`);
    ids.add(lineId);
    if (typeof line.project !== 'string' || !/^[A-Za-z0-9_-]{1,100}(?![\s\S])/.test(line.project)) throw error(`${label}.project: use 1–100 letters, digits, underscores or hyphens.`);
    object(line.orchestrator, ['port', 'webviewUrl'], `${label}.orchestrator`, ['port']);
    const publicUrl = line.orchestrator.webviewUrl === undefined ? undefined : webviewUrl(line.orchestrator.webviewUrl, `${label}.orchestrator.webviewUrl`);
    object(line.workers, ['count', 'statusPort', 'execution'], `${label}.workers`, ['count', 'statusPort']);
    let execution;
    try { execution = normalizeExecution(line.workers.execution); } catch { throw error(`${label}.workers.execution: invalid live policy; use absolute Linux paths, bounded timeout and approved non-secret text paths.`); }
    if (execution && (selected !== 'native' || line.workers.count !== 1)) throw error(`${label}.workers.execution: live Codex requires native Linux with exactly one worker per line.`);
    const orchestratorPort = port(line.orchestrator.port, `${label}.orchestrator.port`);
    const statusPort = port(line.workers.statusPort, `${label}.workers.statusPort`);
    const count = line.workers.count;
    if (!Number.isInteger(count) || count < 1 || count > 8 || statusPort + count - 1 > 65535) throw error(`${label}.workers: count must be 1–8 and the status port range must fit within 1–65535.`);
    reserve(orchestratorPort, `${label}.orchestrator.port`);
    for (let worker = 0; worker < count; worker++) reserve(statusPort + worker, `${label}.workers[${worker}].statusPort`);
    return { id: lineId, name: name(line.name, `${label}.name`), factoryId, project: line.project, orchestrator: { port: orchestratorPort, ...(publicUrl ? { webviewUrl: publicUrl } : {}) }, workers: { count, statusPort, ...(execution ? { execution } : {}) } };
  });
  return { schemaVersion: 1, id, environment: selected, factory, productionLines };
}
async function readDefinition(file) {
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink()) throw error('System definition must be a regular file, not a symlink or special file.');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw error('System definition must be a regular file of at most 64 KiB.');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      offset += bytesRead;
      if (offset > MAX_BYTES) throw error('System definition exceeds 64 KiB.');
      if (!bytesRead) break;
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)); }
    catch { throw error('System definition must contain valid UTF-8.'); }
  } finally { await handle.close(); }
}
/** Read one bounded YAML 1.2 document using the dependency shipped with the orchestrator. */
export async function loadDefinition(file, { environment: override } = {}) {
  const source = await readDefinition(file);
  let YAML;
  try { YAML = requireYaml('./node_modules/yaml'); }
  catch { throw error('Bundled YAML runtime is missing. Use a complete Werk release, or run npm run build in the source checkout.'); }
  try {
    const documents = YAML.parseAllDocuments(source, { version: '1.2', schema: 'core', uniqueKeys: true, strict: true, merge: false });
    if (documents.length !== 1 || documents[0].errors.length || documents[0].warnings.length) throw error('System definition must be exactly one valid YAML document, with unique mapping keys and no unsupported tags.');
    const document = documents[0];
    if (document.directives?.yaml.version !== '1.2' || /^%TAG\s/m.test(source)) throw error('System definition supports YAML 1.2 without custom tag directives.');
    let nodes = 0;
    YAML.visit(document, (key, node, path) => {
      if (++nodes > 2048 || path.length > 24) throw error('System definition is too deeply nested or contains too many YAML nodes.');
      if (YAML.isAlias(node) || node?.anchor || node?.tag) throw error('YAML aliases, anchors and explicit tags are not supported in system definitions.');
      if (YAML.isMap(node)) for (const pair of node.items) if (!YAML.isScalar(pair.key) || typeof pair.key.value !== 'string') throw error('System definition mapping keys must be strings.');
    });
    const normalized = validateDefinition(document.toJS({ maxAliasCount: 0 }));
    if (override !== undefined) normalized.environment = environment(override);
    return validateDefinition(normalized);
  } catch (failure) {
    if (failure.code === 'INVALID_SYSTEM_DEFINITION') throw failure;
    throw error('System definition contains unsupported or excessively complex YAML.');
  }
}
/** A reviewable, secret-free deployment plan. This function performs no I/O. */
export function planDefinition(definition) {
  const normalized = validateDefinition(definition);
  const url = port => `http://127.0.0.1:${port}`;
  return {
    ...normalized,
    mode: normalized.productionLines.some(line => line.workers.execution) ? (normalized.productionLines.every(line => line.workers.execution) ? 'cli' : 'mixed') : 'mock',
    factory: { ...normalized.factory, url: url(normalized.factory.port) },
    productionLines: normalized.productionLines.map(line => {
      const statusPorts = Array.from({ length: line.workers.count }, (_, index) => line.workers.statusPort + index);
      return { ...line, orchestrator: { ...line.orchestrator, url: url(line.orchestrator.port) }, workers: { ...line.workers, statusPorts, urls: statusPorts.map(url) } };
    }),
    totals: { factories: 1 + normalized.factory.subFactories.length, productionLines: normalized.productionLines.length, workers: normalized.productionLines.reduce((sum, line) => sum + line.workers.count, 0) },
  };
}
