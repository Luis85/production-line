import { inputError } from '../config.mjs';
import { toolAccessBody } from './worker-commands.mjs';
import { object, identifier, text } from '../../../src/worker/dist/shared/contracts.js';
import { validateSharedIntakeConfig } from '../../../src/worker/dist/worker/application/shared-feature-state.js';

/** @typedef {(method: string, path: string, body?: unknown) => Promise<unknown>} SetupCall */
/** @param {unknown} value */
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw inputError('The worker returned an invalid setup response.');
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {unknown} input */
function configuration(input) {
  const value = object(input, 'Shared setup', ['expectedRevision', 'repositoryId', 'discoveryId', 'provider', 'intake', 'toolAccess', 'resume']);
  if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0) throw inputError('Use expectedRevision from shared status.');
  if ((value.repositoryId === undefined) === (value.discoveryId === undefined)) throw inputError('Choose exactly one repositoryId or inspected discoveryId.');
  const repositoryId = value.repositoryId === undefined ? undefined : identifier(value.repositoryId, 'Repository ID');
  const discoveryId = value.discoveryId === undefined ? undefined : text(value.discoveryId, 'Discovery ID', 64);
  if (discoveryId !== undefined && !/^[a-f0-9]{64}$/.test(discoveryId)) throw inputError('Use the current discoveryId from repository status.');
  const provider = object(value.provider, 'Local provider', ['id', 'executable', 'model']);
  if (!['codex-cli', 'claude-cli'].includes(String(provider.id))) throw inputError('Shared setup requires a local codex-cli or claude-cli provider.');
  if (provider.executable !== undefined && (typeof provider.executable !== 'string' || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(provider.executable) || /[\x00-\x1f\x7f]/.test(provider.executable))) throw inputError('Provider executable must be an absolute path on the worker machine.');
  if (provider.model !== undefined && (typeof provider.model !== 'string' || provider.model.length > 200 || /[\x00-\x1f\x7f]/.test(provider.model))) throw inputError('Provider model must be a bounded string.');
  const intake = object(value.intake, 'Shared binding', ['remote', 'branch', 'workflowPath', 'pollMs']);
  const binding = validateSharedIntakeConfig({ enabled: true, repositoryId: repositoryId ?? 'detected-project', ...intake });
  if (typeof value.resume !== 'boolean') throw inputError('Set resume explicitly to true or false.');
  const toolAccess = value.toolAccess === undefined ? undefined : toolAccessBody(value.toolAccess);
  return { expectedRevision: Number(value.expectedRevision), repositoryId, discoveryId, provider, binding, toolAccess, resume: value.resume };
}

/**
 * A recoverable sequence of existing guarded APIs, not a second configuration store.
 * No automatic retries: a timed-out write may still complete on the worker.
 * @param {unknown} input
 * @param {SetupCall} call
 * @param {{dryRun?: boolean}} [options]
 */
export async function setupSharedIntake(input, call, options = {}) {
  const setup = configuration(input);
  const [shared, repositories, settings, tools] = await Promise.all([
    call('GET', '/api/shared-intake').then(record), call('GET', '/api/repositories').then(record),
    call('GET', '/api/settings').then(record),
    setup.toolAccess === undefined ? undefined : call('GET', '/api/tool-access').then(record),
  ]);
  if (shared.revision !== setup.expectedRevision) throw inputError('Shared intake changed. Read shared status and update expectedRevision before setup.');
  if (tools && tools.revision !== setup.toolAccess.expectedRevision) throw inputError('Tool access changed. Read tool-access get before setup.');
  const existing = Array.isArray(repositories.items) ? repositories.items.map(record).find(item => item.id === setup.repositoryId) : undefined;
  const discovery = setup.discoveryId === undefined ? undefined : record(repositories.discovery);
  if (setup.repositoryId && !existing) throw inputError('The repositoryId is not assigned. Inspect repository status; assign it explicitly or use its discoveryId.');
  if (discovery && discovery.id !== setup.discoveryId) throw inputError('The detected repository changed. Review repository status before accepting it.');
  const providers = Array.isArray(settings.providers) ? settings.providers.map(record) : [];
  const provider = providers.find(item => item.id === setup.provider.id);
  if (!provider || !(setup.provider.executable ?? provider.executable)) throw inputError('The selected local provider has no executable. Install/sign in to its CLI and supply its absolute executable path.');
  const operations = ['pause', 'idle', ...(Object.keys(setup.provider).length > 1 ? ['provider'] : []), 'provider_check', ...(discovery ? ['repository_accept'] : []), ...(setup.toolAccess ? ['tool_access'] : []), 'shared_configure', 'shared_sync', ...(setup.resume ? ['resume'] : [])];
  const plan = { schemaVersion: 1, repository: { id: setup.repositoryId ?? discovery?.repositoryId ?? null, path: existing?.path ?? discovery?.path, ...(setup.discoveryId ? { discoveryId: setup.discoveryId } : {}) }, providerId: setup.provider.id, intake: { ...setup.binding, repositoryId: setup.repositoryId ?? discovery?.repositoryId ?? null }, operations,
    warnings: ['Only committed and pushed requests are admitted. Request provider fields select the model; confirm the committed template names this provider.', 'Provider login, Git connectivity and the committed workflow are checked during apply. Tool access changes only when supplied explicitly.'] };
  if (options.dryRun) return { ...plan, dryRun: true };
  const completed = [];
  let step = 'pause', paused = false;
  /** @param {string} name @param {string} method @param {string} path @param {unknown} [body] */
  const run = async (name, method, path, body) => {
    step = name;
    const value = record(await call(method, path, body));
    completed.push(name);
    return value;
  };
  try {
    await run('pause', 'POST', '/api/settings', { board: { paused: true } }); paused = true;
    const idle = await run('idle', 'GET', '/api/shared-intake');
    if (idle.canEdit !== true) throw inputError(typeof idle.blockedReason === 'string' ? idle.blockedReason : 'Finish or cancel queued work and active replies before setup.');
    if (Object.keys(setup.provider).length > 1) await run('provider', 'POST', '/api/settings', { provider: setup.provider });
    const checked = await run('provider_check', 'POST', '/api/providers/check', { id: setup.provider.id });
    if (checked.available !== true || checked.authentication !== 'authenticated') throw inputError(typeof checked.message === 'string' ? checked.message : 'Sign in to the selected CLI as the worker account, then retry setup.');
    let repositoryId = setup.repositoryId;
    if (discovery) {
      const accepted = await run('repository_accept', 'POST', '/api/repositories', { action: 'accept', discoveryId: setup.discoveryId });
      const selected = record(accepted.discovery);
      if (selected.id !== setup.discoveryId || selected.decision !== 'accepted') throw inputError('Repository acceptance was not confirmed. Inspect repository status.');
      repositoryId = identifier(selected.repositoryId, 'Accepted repository ID');
    }
    if (setup.toolAccess) await run('tool_access', 'POST', '/api/tool-access', setup.toolAccess);
    const config = validateSharedIntakeConfig({ ...setup.binding, repositoryId });
    await run('shared_configure', 'POST', '/api/shared-intake', { action: 'configure', expectedRevision: setup.expectedRevision, config });
    const synchronized = await run('shared_sync', 'POST', '/api/shared-intake', { action: 'sync' });
    if (synchronized.error || !synchronized.workflow) throw inputError(typeof synchronized.error === 'string' ? synchronized.error : 'The committed workflow was not loaded. Commit and push the authoring kit, then inspect shared status.');
    if (setup.resume) { await run('resume', 'POST', '/api/settings', { board: { paused: false } }); paused = false; }
    return { ...plan, dryRun: false, configured: true, paused, completed, repository: { ...plan.repository, id: repositoryId }, intake: config, revision: synchronized.revision, workflow: synchronized.workflow };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Operation failed';
    const state = paused && step !== 'resume' ? 'New starts remain paused.' : 'Pause state is unconfirmed; inspect queue settings.';
    const details = error && typeof error === 'object' ? error : {};
    const status = 'status' in details && typeof details.status === 'number' && Number.isInteger(details.status) ? details.status : undefined;
    const exitCode = 'exitCode' in details && details.exitCode === 2 || status !== undefined && status >= 400 && status < 500 ? 2 : 1;
    throw Object.assign(new Error(`Shared setup stopped at ${step}: ${message} ${state} Completed steps: ${completed.join(', ') || 'none'}. Inspect shared status and tool-access get before retrying; earlier writes are retained.`, { cause: error }), { exitCode, ...(status === undefined ? {} : { status }) });
  }
}
