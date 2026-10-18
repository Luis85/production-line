import { providerIds, type ProviderId } from './application/provider-contract.js';
import { validateRepositoryConfiguration } from './application/repositories.js';
import { DEFAULT_MAX_RUNTIME_MS, MAX_MAX_RUNTIME_MS } from './application/execution-policy.js';
import { chatConfiguration } from './status/workspace.js';
import { codexConfiguration } from './infrastructure/codex-adapter.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { object, profiles, workerPolicy } from '../shared/contracts.js';
import { ValidationError } from '../shared/errors.js';
import { resolve } from 'node:path';
import { integer } from '../shared/cli.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const defaultPrompt = 'Implement the assigned feature in the project context. Follow the factory policy and report evidence honestly.';

function section(raw: Record<string, unknown>, key: string, fields: string[]): Record<string, unknown> {
  const value = object(raw[key] === undefined ? {} : raw[key], `${key} configuration`, fields);
  if (Object.values(value).some(item => item === null)) throw new ValidationError(`Invalid ${key} configuration field`);
  return value;
}

/** Normalize external configuration once; the hash pins the effective execution policy. */
export async function configuration(options: Record<string, string>, document?: unknown) {
  let parsed: unknown = document ?? {};
  if (options.config) {
    const source = await readFile(options.config, 'utf8');
    if (Buffer.byteLength(source) > 65536) throw new ValidationError('Worker configuration limit: 64 KiB');
    try { parsed = JSON.parse(source); }
    catch { throw new ValidationError('Invalid worker configuration JSON'); }
  }
  const raw = object(parsed, 'Worker configuration', ['schemaVersion', 'scheduler', 'execution', 'systemPrompt', 'profiles', 'journal', 'chat', 'features', 'repositories']);
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) throw new ValidationError('Unknown worker configuration version');
  const repositories = validateRepositoryConfiguration(raw.repositories, path => resolve(options['project-dir'] ?? process.cwd(), path));
  const featuresRaw = section(raw, 'features', ['directory', 'provider', 'pollMs']);
  const directory = options['features-dir'] ?? featuresRaw.directory;
  if (directory !== undefined && (typeof directory !== 'string' || !directory.trim() || directory.length > 4096 || /[\x00-\x1f]/.test(directory))) throw new ValidationError('features.directory must be a folder path.');
  const provider = featuresRaw.provider ?? 'codex-cli';
  if (!providerIds.includes(provider as ProviderId)) throw new ValidationError('Invalid features.provider.');
  const features = directory === undefined ? undefined : { directory: resolve(options['project-dir'] ?? process.cwd(), directory as string), provider: String(provider), pollMs: integer(String(featuresRaw.pollMs ?? 1000), 'features.pollMs', 250, 30000) };
  const scheduler = section(raw, 'scheduler', ['maxParallel', 'order', 'pollMs', 'maxAttempts']);
  const execution = section(raw, 'execution', ['mode', 'timeoutMs', 'mockMs', 'codex']);
  const journal = section(raw, 'journal', ['retainedPairs']);
  if (journal.retainedPairs !== undefined && (typeof journal.retainedPairs !== 'number' || !Number.isSafeInteger(journal.retainedPairs)))
    throw new ValidationError('journal.retainedPairs must be an integer');
  const retainedPairs = integer(options['retain-acknowledged-pairs'] ?? String(journal.retainedPairs ?? 1000), 'retain-acknowledged-pairs', 0, 100000);
  const mode = execution.mode ?? 'mock';
  if (mode !== 'mock' && mode !== 'cli') throw new ValidationError('execution.mode: mock or cli');
  if (mode === 'cli' && process.platform !== 'linux') throw new ValidationError('Live Codex execution currently requires native Linux');
  if (mode === 'mock' && execution.codex !== undefined) throw new ValidationError('Codex configuration requires explicit cli mode');
  const codex = mode === 'cli' ? codexConfiguration(execution.codex) : undefined;
  if (mode === 'cli' && !codex?.repository && !repositories.items.length) throw new ValidationError('Live Codex requires execution.codex.repository or an assigned repository.');
  const chatExecutable = chatConfiguration(raw.chat) ?? codex?.executable;
  const systemPrompt = raw.systemPrompt === undefined ? defaultPrompt : raw.systemPrompt;
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim() || systemPrompt.length > 20000) {
    throw new ValidationError('systemPrompt must contain 1–20000 characters');
  }
  const defaults = mode === 'cli' ? [{ id: 'codex-live', provider: 'codex', mode: 'cli' }] : [
    { id: 'claude-1', provider: 'claude', mode: 'mock' },
    { id: 'codex-2', provider: 'codex', mode: 'mock' }
  ];
  const configuredProfiles = options.profiles
    ? options.profiles.split(',').map((provider, index) => ({ id: `${provider}-${index + 1}`, provider, mode }))
    : raw.profiles === undefined ? defaults : raw.profiles;
  const ps = profiles(configuredProfiles);
  if (ps.some(profile => profile.maxParallel !== 1)) throw new ValidationError('Each worker profile must have one execution slot');
  if (ps.some(profile => profile.mode !== mode)) throw new ValidationError('All profiles must match execution mode');
  if (Number(options.parallel ?? scheduler.maxParallel ?? 1) !== 1) throw new ValidationError('A worker has one profile execution slot at a time; parallel must be 1');
  const policy = workerPolicy({
    maxParallel: integer(options.parallel ?? String(scheduler.maxParallel ?? 1), 'parallel', 1, 1),
    order: scheduler.order ?? 'priority', maxAttempts: scheduler.maxAttempts ?? (mode === 'cli' ? 1 : 3), configHash: hash('pending')
  });
  if (mode === 'cli' && (policy.maxParallel !== 1 || policy.maxAttempts !== 1 || ps.length !== 1 || ps[0].maxParallel !== 1)) throw new ValidationError('Live Codex requires one profile, one slot and one attempt');
  const pollMs = integer(options['poll-ms'] ?? String(scheduler.pollMs ?? 1000), 'poll-ms', 100, 30000);
  const mockMs = integer(options['mock-ms'] ?? String(execution.mockMs ?? 3000), 'mock-ms', 1, 3600000);
  const timeoutMs = integer(options['timeout-ms'] ?? String(execution.timeoutMs ?? (mode === 'cli' ? DEFAULT_MAX_RUNTIME_MS : 60000)), 'timeout-ms', 50, MAX_MAX_RUNTIME_MS);
  const normalized = {
    schemaVersion: 1,
    scheduler: { ...policy, configHash: undefined, pollMs },
    execution: { mode, mockMs, timeoutMs, ...(codex ? { codex } : {}) },
    profiles: ps, systemPrompt
  };
  policy.configHash = hash(JSON.stringify(normalized));
  return { repositories, ...(features ? { features } : {}), ...(chatExecutable ? { chatExecutable } : {}), ...(codex ? { codex } : {}), profiles: ps, policy, pollMs, mockMs, timeoutMs, retainedPairs, systemPromptHash: hash(systemPrompt), systemPrompt };
}
