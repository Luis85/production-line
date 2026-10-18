import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { inputError, readPrivate } from '../config.mjs';

const limit = 65536;
const runFile = promisify(execFile);
const definitions = {
  worker: {
    options: { WERK_WORKER_STATE_DIR: 'state-dir', WERK_WORKER_HOST: 'host', WERK_WORKER_PORT: 'port', WERK_WORKER_CONFIG: 'config', WERK_WORKER_ORCHESTRATOR_URL: 'url' },
    extra: ['WERK_WORKER_TOKEN', 'WERK_ENROLLMENT_TOKEN', 'WERK_WORKER_MAX_RUNTIME_MS'],
    tokens: ['WERK_WORKER_TOKEN', 'WERK_ENROLLMENT_TOKEN'],
    generated: ['WERK_WORKER_TOKEN'],
    defaults: { 'state-dir': '.werk/worker', host: '127.0.0.1', port: '4100' },
  },
  factory: {
    options: { WERK_FACTORY_STATE_DIR: 'state-dir', WERK_FACTORY_HOST: 'host', WERK_FACTORY_PORT: 'port' },
    extra: ['WERK_FACTORY_ADMIN_TOKEN'], tokens: ['WERK_FACTORY_ADMIN_TOKEN'], generated: ['WERK_FACTORY_ADMIN_TOKEN'],
    defaults: { 'state-dir': '.werk/factory', host: '127.0.0.1', port: '3100' },
  },
  orchestrator: {
    options: { WERK_ORCHESTRATOR_STATE_DIR: 'state-dir', WERK_ORCHESTRATOR_HOST: 'host', WERK_ORCHESTRATOR_PORT: 'port', WERK_ORCHESTRATOR_PROJECT: 'project' },
    extra: ['WERK_ADMIN_TOKEN', 'WERK_ENROLLMENT_TOKEN'], tokens: ['WERK_ADMIN_TOKEN', 'WERK_ENROLLMENT_TOKEN'], generated: ['WERK_ADMIN_TOKEN', 'WERK_ENROLLMENT_TOKEN'],
    defaults: { 'state-dir': '.werk/orchestrator', host: '127.0.0.1', port: '3000', project: 'demo' },
  },
};
function definition(kind) { const value = definitions[kind]; if (!value) throw inputError('Unknown environment application.'); return value; }
function supported(kind) { const value = definition(kind); return new Set([...Object.keys(value.options), ...value.extra]); }
const syntaxError = key => inputError('Invalid .env value for ' + key + '. Use a single assignment with optional quotes and comments.');

/** Only supported Werk keys are interpreted. Shell substitutions are literal strings. */
export function parseEnvironment(kind, source) {
  const allowed = supported(kind), result = Object.create(null);
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) {
      const name = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)/.exec(line)?.[1];
      if (allowed.has(name)) throw syntaxError(name);
      continue;
    }
    const [, key, raw] = match, value = raw.trimStart(), quote = ['"', "'", '`'].includes(value[0]) ? value[0] : undefined;
    let record = line;
    if (quote) {
      let tail = value.slice(1), end = tail.indexOf(quote), next = index;
      while (end < 0 && next + 1 < lines.length) { tail += '\n' + lines[++next]; end = tail.indexOf(quote); }
      if (end >= 0) {
        record = lines.slice(index, next + 1).join('\n'); index = next;
        if (allowed.has(key) && !/^\s*(?:#.*)?$/.test(tail.slice(end + 1))) throw syntaxError(key);
      } else if (allowed.has(key)) throw syntaxError(key);
    }
    if (!allowed.has(key)) continue;
    if (Object.hasOwn(result, key)) throw inputError('Duplicate .env assignment for ' + key + '. Keep one value.');
    const parsed = parseEnv(record)[key];
    if (typeof parsed !== 'string' || /[\0\r\n]/.test(parsed)) throw syntaxError(key);
    result[key] = parsed;
  }
  return result;
}
async function readText(path) {
  const before = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!before) return undefined;
  if (!before.isFile() || before.isSymbolicLink()) throw inputError('Environment setup files must be regular files, not links.');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > limit) throw inputError('Environment setup files must be stable regular files of at most 64 KiB.');
    const buffer = Buffer.alloc(limit + 1); let offset = 0;
    while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    if (offset > limit) throw inputError('Environment setup file exceeds 64 KiB.');
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)); }
    catch { throw inputError('Environment setup file must contain valid UTF-8.'); }
    return { content, stat };
  } finally { await handle.close(); }
}
function validateTokens(kind, values) {
  for (const key of definition(kind).tokens) {
    const value = values[key];
    if (value === undefined) continue;
    if (kind === 'worker' && key === 'WERK_ENROLLMENT_TOKEN') {
      if (value === '') continue;
      if (typeof value !== 'string' || value.length < 24 || value.length > 4096 || /[\0\r\n]/.test(value)) throw inputError('WERK_ENROLLMENT_TOKEN must contain 24–4096 characters without line breaks.');
    } else if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw inputError(key + ' must contain exactly 64 lowercase hexadecimal characters.');
  }
  if (kind === 'orchestrator' && values.WERK_ADMIN_TOKEN !== undefined && values.WERK_ADMIN_TOKEN === values.WERK_ENROLLMENT_TOKEN) throw inputError('Component admin and enrollment tokens must be distinct.');
}
/** @param {string} kind @param {string} directory @param {Record<string, string | undefined>} [environment] */
export async function loadEnvironment(kind, directory, environment = process.env) {
  const path = join(await realpath(resolve(directory)), '.env'), file = await readText(path);
  const values = file ? parseEnvironment(kind, file.content) : {};
  if (file && process.platform !== 'win32' && file.stat.mode & 0o077 && definition(kind).tokens.some(key => values[key] !== undefined)) throw inputError('The project .env contains credentials and must be private (0600). Run env init to secure an untracked file, or correct its permissions.');
  const merged = { ...values, ...Object.fromEntries([...supported(kind)].filter(key => environment[key] !== undefined).map(key => [key, environment[key]])) };
  validateTokens(kind, merged);
  const loaded = [];
  for (const [key, value] of Object.entries(values)) if (environment[key] === undefined) { environment[key] = value; loaded.push(key); }
  return { path, present: Boolean(file), loaded };
}
export function environmentDefaults(kind, environment, directory) {
  const result = {};
  for (const [key, option] of Object.entries(definition(kind).options)) {
    const value = environment[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) throw inputError('Invalid environment option ' + key + '.');
    result[option] = ['state-dir', 'config'].includes(option) && !isAbsolute(value) ? resolve(directory, value) : value;
  }
  return result;
}
export function environmentExample(kind) {
  const config = definition(kind);
  return '# Werk ' + kind + ' environment\n# Process environment overrides this file; command options override environment defaults.\n'
    + config.tokens.map(key => '# ' + key + (kind === 'worker' && key === 'WERK_ENROLLMENT_TOKEN' ? '=<24–4096 characters, no line breaks>' : '=<64 lowercase hexadecimal characters>')).join('\n') + '\n'
    + Object.entries(config.options).filter(([, option]) => config.defaults[option] !== undefined).map(([key, option]) => key + '=' + config.defaults[option]).join('\n') + '\n'
    + (kind === 'worker' ? '# WERK_WORKER_CONFIG=.werk/worker.json\n# WERK_WORKER_ORCHESTRATOR_URL=http://127.0.0.1:3000\n# WERK_WORKER_MAX_RUNTIME_MS=21600000\n' : '');
}
async function tracked(directory, filename) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(environment, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
  try {
    const result = await runFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', directory, 'ls-files', '-z', '--', filename], { env: environment, timeout: 5000, maxBuffer: 65536, windowsHide: true });
    return Boolean(result.stdout.length);
  } catch (error) {
    // A project without a Git checkout is supported; a broken checkout must not receive generated secrets.
    let ancestor = directory;
    for (;;) {
      if (await lstat(join(ancestor, '.git')).catch(failure => { if (failure.code !== 'ENOENT') throw failure; })) throw inputError('Could not verify whether .env is tracked. Repair Git access before initializing environment secrets.');
      const parent = resolve(ancestor, '..'); if (parent === ancestor) return false; ancestor = parent;
    }
  }
}
async function savedTokens(kind, stateDirectory) {
  if (!stateDirectory) return {};
  if (kind === 'worker') {
    const file = await readText(join(stateDirectory, 'webview-token'));
    if (!file) return {};
    if (process.platform !== 'win32' && file.stat.mode & 0o077) throw inputError('Saved worker token must be private before initializing .env.');
    return { WERK_WORKER_TOKEN: file.content.trim() };
  }
  const state = await readPrivate(join(stateDirectory, 'component.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (state === undefined) return {};
  if (state === null || typeof state !== 'object' || Array.isArray(state) || state.schemaVersion !== 1 || state.kind !== kind
    || typeof state.project !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(state.project)
    || typeof state.adminToken !== 'string' || !/^[a-f0-9]{64}$/.test(state.adminToken)
    || typeof state.enrollmentToken !== 'string' || !/^[a-f0-9]{64}$/.test(state.enrollmentToken)
    || state.adminToken === state.enrollmentToken) throw inputError('Invalid saved component identity. Restore component.json from a trusted backup before initializing .env.');
  return kind === 'factory' ? { WERK_FACTORY_ADMIN_TOKEN: state.adminToken } : { WERK_ADMIN_TOKEN: state.adminToken, WERK_ENROLLMENT_TOKEN: state.enrollmentToken };
}
function appended(previous, block) {
  const newline = previous.includes('\r\n') ? '\r\n' : '\n';
  return previous + (previous && !previous.endsWith('\n') ? newline : '') + block.replaceAll('\n', newline);
}
async function appendFile(path, previous, content, privateFile = false) {
  if (Buffer.byteLength(content) > limit) throw inputError('Environment setup file would exceed 64 KiB.');
  if (previous?.content === content && !(privateFile && process.platform !== 'win32' && previous.stat.mode & 0o077)) return;
  const flags = previous ? constants.O_RDWR | constants.O_APPEND : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
  const handle = await open(path, flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), privateFile ? 0o600 : 0o644);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || previous && (stat.dev !== previous.stat.dev || stat.ino !== previous.stat.ino)) throw inputError('Environment setup file changed or is linked. Retry after inspecting it.');
    if (previous && (await handle.readFile('utf8')) !== previous.content) throw inputError('Environment setup file changed. Retry after inspecting it.');
    if (privateFile && process.platform !== 'win32') await handle.chmod(0o600);
    await handle.writeFile(previous ? content.slice(previous.content.length) : content);
    await handle.sync();
  } finally { await handle.close(); }
}
/** @param {string} kind @param {string} directory @param {{stateDirectory?: string, defaults?: Record<string, unknown>, fallbacks?: Record<string, unknown>, environment?: Record<string, string | undefined>}} [options] */
export async function seedEnvironment(kind, directory, { stateDirectory, defaults = {}, fallbacks = {}, environment = process.env } = {}) {
  const config = definition(kind), project = await realpath(resolve(directory));
  const path = join(project, '.env'), examplePath = join(project, '.env.example'), gitignorePath = join(project, '.gitignore');
  const current = await readText(path), example = await readText(examplePath), ignore = await readText(gitignorePath);
  for (const file of [current, example, ignore]) if (file && file.stat.nlink !== 1) throw inputError('Environment setup files must not have hard links.');
  const values = parseEnvironment(kind, current?.content ?? '');
  validateTokens(kind, values); validateTokens(kind, environment);
  const effectiveDefaults = environmentDefaults(kind, { ...values, ...Object.fromEntries([...supported(kind)].filter(key => environment[key] !== undefined).map(key => [key, environment[key]])) }, project);
  const state = resolve(project, stateDirectory ?? defaults['state-dir'] ?? effectiveDefaults['state-dir'] ?? fallbacks['state-dir'] ?? config.defaults['state-dir']);
  const saved = await savedTokens(kind, state); validateTokens(kind, saved);
  const additions = {};
  for (const key of config.generated) if (values[key] === undefined) additions[key] = environment[key] ?? saved[key] ?? randomBytes(32).toString('hex');
  for (const [key, option] of Object.entries(config.options)) {
    const value = defaults[option] ?? environment[key] ?? fallbacks[option] ?? config.defaults[option];
    if (values[key] === undefined && value !== undefined) additions[key] = String(value);
  }
  validateTokens(kind, { ...values, ...additions });
  validateTokens(kind, { ...values, ...additions, ...Object.fromEntries([...supported(kind)].filter(key => environment[key] !== undefined).map(key => [key, environment[key]])) });
  if ((Object.keys(additions).length || current && process.platform !== 'win32' && current.stat.mode & 0o077) && await tracked(project, '.env')) throw inputError('The project .env is tracked by Git. Untrack it before adding environment secrets.');
  const encoded = Object.entries(additions).map(([key, value]) => {
    if (/[\0\r\n]/.test(value)) throw inputError('Environment defaults must be single-line values.');
    // Select a representation only when Node's dotenv parser returns the exact value.
    for (const quote of ["'", '"', String.fromCharCode(96), '']) {
      if (quote && value.includes(quote)) continue;
      const candidate = key + '=' + quote + value + quote;
      if (parseEnv(candidate)[key] === value) return candidate;
    }
    throw inputError('Environment defaults contain unsupported quote characters.');
  }).join('\n');
  const next = encoded ? appended(current?.content ?? '', encoded + '\n') : current?.content ?? '';
  const exampleBlock = environmentExample(kind), marker = '# Werk ' + kind + ' environment';
  const nextExample = example?.content.includes(marker) ? example.content : appended(example?.content ?? '', exampleBlock);
  // Add only missing rules, matched as trimmed exact lines, so a project's own .env rules are never duplicated.
  const ignoreLines = ['.env', '!.env.example'], header = '# Werk local environment';
  const present = (ignore?.content ?? '').split(/\r?\n/).map(line => line.trim()), ignoreAdded = ignoreLines.filter(line => !present.includes(line));
  const nextIgnore = ignoreAdded.length ? appended(ignore?.content ?? '', (present.includes(header) ? '' : header + '\n') + ignoreAdded.join('\n') + '\n') : ignore?.content ?? '';
  // Preflight every destination before writes. Ignore rules precede generated credentials.
  for (const content of [next, nextExample, nextIgnore]) if (Buffer.byteLength(content) > limit) throw inputError('Environment setup file would exceed 64 KiB.');
  await appendFile(gitignorePath, ignore, nextIgnore);
  await appendFile(examplePath, example, nextExample);
  await appendFile(path, current, next, true);
  return { path, examplePath, gitignorePath, stateDirectory: state, created: !current, added: Object.keys(additions), ignoreAdded };
}
