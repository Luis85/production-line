import { prepareProcessRuntime } from '../../shared/process/launcher.js';
import type { ProviderAuthenticationMode } from '../application/provider-capabilities.js';
import type { ProviderConnection } from '../application/provider-contract.js';
import { ProviderModelError } from '../application/model-result.js';
import { runProviderProbe, type ProviderToolEnvironment } from './provider-process.js';

/** Typed invocation settings carry private keys only to the provider's environment, never argv or evidence. */
export function providerAuthenticationEnvironment(connection: ProviderConnection): ProviderToolEnvironment {
  const mode = connection.authenticationMode;
  if (mode === 'legacy' || mode === 'api-key' && !connection.apiKey) throw new ProviderModelError('authentication');
  const environment: ProviderToolEnvironment = mode ? { authenticationMode: mode } : {};
  if (mode === 'api-key' || mode === undefined && connection.id === 'cursor-cli' && connection.apiKey) {
    if (connection.id === 'claude-cli') environment.ANTHROPIC_API_KEY = connection.apiKey;
    else if (connection.id === 'codex-cli') environment.CODEX_API_KEY = connection.apiKey;
    else if (connection.id === 'cursor-cli') environment.CURSOR_API_KEY = connection.apiKey;
  }
  return environment;
}
export function requireAuthenticationSelection(connection: ProviderConnection, accepted: ProviderAuthenticationMode | undefined): void {
  const apiMode = connection.id.endsWith('-api') ? 'api-key' : undefined;
  if ((accepted ?? apiMode) !== (connection.authenticationMode ?? apiMode)) throw new ProviderModelError('authentication');
}
/** Prepare native execution, then confirm account billing without inference or credential-store access. */
export async function requireProviderAuthentication(connection: ProviderConnection, signal: AbortSignal): Promise<void> {
  const environment = providerAuthenticationEnvironment(connection);
  if (connection.id.endsWith('-cli')) {
    try { await prepareProcessRuntime(process.cwd(), signal); }
    catch { throw new ProviderModelError(signal.aborted ? 'cancelled' : 'unavailable'); }
  }
  if (connection.authenticationMode !== 'cli-account' || connection.id === 'cursor-cli') return;
  const claude = connection.id === 'claude-cli';
  if (!claude && connection.id !== 'codex-cli') return;
  try {
    const result = await runProviderProbe(connection.executable, claude ? 'claude' : 'codex', claude ? ['auth', 'status'] : ['login', 'status'],
      { signal, timeoutMs: 5000, maxOutputBytes: 16384 }, environment);
    if (result.exitCode === 0) {
      if (claude) {
        const value = JSON.parse(result.stdout.toString('utf8'));
        if (value?.loggedIn === true && ['claude.ai', 'oauth_token'].includes(value.authMethod)) return;
      } else if (/^Logged in using ChatGPT(?:\s|$)/im.test(Buffer.concat([result.stdout, result.stderr]).toString('utf8'))) return;
    }
  } catch { /* Unknown or mismatched authentication must not switch billing methods. */ }
  throw new ProviderModelError(signal.aborted ? 'cancelled' : 'authentication');
}
