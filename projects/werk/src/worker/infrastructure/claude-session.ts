import { providerAuthenticationEnvironment } from './provider-authentication.js';
import { structuredProviderFailure } from './provider-failures.js';
import type { ProviderAuthenticationMode } from '../application/provider-capabilities.js';
import type { ModelEffort } from '../application/model-effort.js';
import { claudeVersion, minimumClaudeVersion } from './provider-version.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseModelResult, ProviderModelError, type ModelInvocationControl, type ModelRequest } from '../application/model-contract.js';
import type { ModelSessionAccess } from '../application/model-session.js';
import { sessionDigest } from '../application/model-session.js';
import type { ProviderConnection } from '../application/provider-contract.js';
import type { ProviderUsage } from '../application/run-evidence.js';
import type { ToolRuntime } from '../application/tool-runtime.js';
import { withCliToolBridge, type CliToolBridge } from './cli-tool-bridge.js';
import { openProviderSession } from './native-session.js';
import { providerCommand, runProviderProbe } from './provider-process.js';
import { providerUsage, claudeSessionUsage } from './provider-usage.js';
import { ensureDirectory } from './journal/files.js';

/** Native prompt refresh requires 2.1.257; resumed cost became cumulative in 2.1.277. */
async function costScope(executable: string, signal: AbortSignal): Promise<'invocation' | 'session'> {
  try {
    const result = await runProviderProbe(executable, 'claude', ['--version'], { signal, timeoutMs: 5000, maxOutputBytes: 4096 });
    const version = claudeVersion(result.stdout.toString('utf8'), result.exitCode);
    if (version.compatibility === 'minimum_met' && version.costScope) return version.costScope;
  } catch { /* Unsupported or unreadable versions cannot prove native prompt-refresh support. */ }
  if (signal.aborted) throw new ProviderModelError('cancelled');
  const error = new ProviderModelError('invalid_request');
  error.message = 'Claude Code ' + minimumClaudeVersion + ' or later is required for this feature-request session. Update Claude Code, check the connection, then resume.';
  throw error;
}
export async function claudeSessionReply(connection: ProviderConnection, directory: string, request: ModelRequest, signal: AbortSignal,
  access: ModelSessionAccess, argumentsFor: (model: string, promptFile: string, bridge?: CliToolBridge, effort?: ModelEffort, authenticationMode?: ProviderAuthenticationMode) => string[],
  observe: (usage: ProviderUsage) => void, runtime?: ToolRuntime, control?: ModelInvocationControl) {
  const session = await openProviderSession(access, request, connection.executable), resumed = !!session.nativeId;
  const nativeId = session.nativeId ?? randomUUID();
  // Stable private cwd makes native transcript lookup independent of a temporary MCP bridge directory.
  const cwd = join(directory, 'model-workspaces', sessionDigest(access.binding)); await ensureDirectory(cwd);
  const promptDirectory = await mkdtemp(join(tmpdir(), 'werk-claude-prompt-'));
  let total: number | null | undefined;
  try {
    const scope = await costScope(connection.executable, signal), promptFile = join(promptDirectory, 'system-prompt.md');
    await writeFile(promptFile, request.protocolInstructions, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const output = await withCliToolBridge(runtime, signal, async bridge => {
      const args = argumentsFor(request.provider.model, promptFile, bridge, request.provider.effort, connection.authenticationMode).filter(arg => arg !== '--no-session-persistence');
      args.push('--system-prompt-snapshot', 'off', resumed ? '--resume' : '--session-id', nativeId);
      await session.begin(nativeId);
      control?.beforeCall();
      session.markDispatched();
      return providerCommand(connection.executable, args, cwd, signal, session.input, true, 'claude', buffer => {
        let response; try { response = JSON.parse(buffer.toString('utf8')); } catch { return; }
        if (response?.type !== 'result' || response.session_id !== nativeId) return;
        total = providerUsage('claude', response).providerReportedCostUsd;
        observe(claudeSessionUsage(response, resumed, scope, session.checkpoint.cumulativeCostUsd));
      }, { ...(bridge ? { MCP_TOOL_TIMEOUT: String(bridge.toolTimeoutMs) } : {}), ...providerAuthenticationEnvironment(connection) });
    });
    let response; try { response = JSON.parse(output.toString('utf8')); } catch { throw new ProviderModelError('protocol'); }
    const failure = structuredProviderFailure(response); if (failure) throw failure;
    if (!response || response.type !== 'result' || response.session_id !== nativeId || typeof response.result !== 'string') throw new ProviderModelError('protocol');
    const result = parseModelResult(response.result);
    signal.throwIfAborted();
    await session.complete(result, { cumulativeCostUsd: scope === 'session' ? total ?? null : null });
    return result;
  } catch (error) {
    await session.interrupted();
    throw error;
  } finally { await rm(promptDirectory, { recursive: true, force: true }); }
}
