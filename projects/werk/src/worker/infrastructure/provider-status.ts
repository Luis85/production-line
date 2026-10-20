import { providerCapabilities, type ProviderCapabilities, type ProviderAuthenticationMode } from '../application/provider-capabilities.js';
import { providerAuthenticationEnvironment } from './provider-authentication.js';
import { parseProviderAccount } from './provider-account.js';
import { claudeVersion, minimumClaudeVersion } from './provider-version.js';
import { providerProbeKey, runProviderProbe } from './provider-process.js';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { providerReady, type ProviderConnection, type ProviderId } from '../application/provider-contract.js';
export interface ProviderStatus {
  id: ProviderId; configured: boolean; available: boolean;
  authentication: 'authenticated' | 'signed-out' | 'unknown' | 'unavailable' | 'not-verified';
  message: string; checkedAt: string;
  authenticationMode?: ProviderAuthenticationMode; capabilities?: ProviderCapabilities;
  minimumVersion?: string; version?: string; compatibility?: 'minimum_met' | 'unsupported' | 'unknown';
}
async function statusCommand(connection: ProviderConnection, signal: AbortSignal, args = connection.id === 'codex-cli' ? ['login', 'status'] : connection.id === 'cursor-cli' ? ['status'] : ['auth', 'status']): Promise<{ code: number | null; output: string }> {
  // Claude's machine-readable stdout must remain separate from startup diagnostics.
  // Codex reports login status on stderr; both streams always count toward the limit.
  try {
    const result = await runProviderProbe(connection.executable, connection.id === 'codex-cli' ? 'codex' : connection.id === 'cursor-cli' ? 'cursor' : 'claude', args, { signal, timeoutMs: 5000, maxOutputBytes: 65536 }, providerAuthenticationEnvironment(connection));
    return { code: result.exitCode, output: Buffer.concat([result.stdout, result.stderr]).toString('utf8') };
  } catch { throw Error('Provider status unavailable'); }
}
/** A bounded per-provider single-flight cache prevents repeated clicks from spawning unbounded processes. */
export class ProviderStatusChecks {
  private controller = new AbortController();
  private pending = new Map<ProviderId, { key: string; operation: Promise<ProviderStatus> }>();
  private cached = new Map<ProviderId, { key: string; until: number; value: ProviderStatus }>();
  async check(connection: ProviderConnection): Promise<ProviderStatus> {
    if (this.controller.signal.aborted) return { id: connection.id, configured: providerReady(connection), available: false, authentication: 'unavailable', checkedAt: new Date().toISOString(), message: 'The worker is stopping.' };
    const key = providerProbeKey(connection);
    const cached = this.cached.get(connection.id);
    if (cached && cached.key === key && cached.until > Date.now()) return cached.value;
    const pending = this.pending.get(connection.id);
    if (pending) { if (pending.key === key) return pending.operation; await pending.operation; return this.check(connection); }
    const operation = this.inspect({ ...connection }).then(value => { if (!this.controller.signal.aborted) this.cached.set(connection.id, { key, until: Date.now() + 5000, value }); return value; }).finally(() => this.pending.delete(connection.id));
    this.pending.set(connection.id, { key, operation }); return operation;
  }
  private async inspect(connection: ProviderConnection): Promise<ProviderStatus> {
    const base = { id: connection.id, authenticationMode: connection.authenticationMode ?? 'legacy' as const, capabilities: providerCapabilities(connection.id), configured: providerReady(connection), available: false, checkedAt: new Date().toISOString() };
    if (connection.authenticationMode === 'legacy') return { ...base, authentication: 'unknown', message: 'Choose provider account/subscription or API-key billing in Settings before running work. Existing credentials were not changed.' };
    if (!connection.id.endsWith('-cli')) return { ...base, available: base.configured, authentication: 'not-verified', message: base.configured ? 'API key and model are saved. A task will verify provider access; this check makes no API request.' : 'Save an API key and model to connect this provider.' };
    if (process.platform === 'win32' && connection.id === 'codex-cli') return { ...base, authentication: 'unavailable', message: 'Codex CLI execution needs a native Linux or macOS worker. Use Claude Code CLI or an API provider on Windows.' };
    if (connection.authenticationMode === 'api-key' && !connection.apiKey) return { ...base, authentication: 'not-verified', message: 'Save an API key for the selected API-key mode. Account fallback is disabled.' };
    if (!connection.executable) return { ...base, authentication: 'unavailable', message: 'Install the provider CLI and save its absolute executable path.' };
    try { await access(connection.executable, constants.X_OK); } catch { return { ...base, authentication: 'unavailable', message: 'The saved CLI executable cannot be run by the worker account.' }; }
    let available: Omit<ProviderStatus, 'authentication' | 'message'> = { ...base, available: true };
    try {
      if (connection.id === 'claude-cli') {
        const version = await statusCommand(connection, this.controller.signal, ['--version']);
        const parsed = claudeVersion(version.output, version.code);
        available = { ...available, minimumVersion: minimumClaudeVersion, ...(parsed.version ? { version: parsed.version } : {}), compatibility: parsed.compatibility };
        if (parsed.compatibility !== 'minimum_met') return { ...available, available: false, authentication: 'unknown', message: 'Claude Code ' + minimumClaudeVersion + ' or later is required. Update the CLI and check again so this worker can verify isolated feature-request sessions. No model request was made.' };
      }
      if (connection.id === 'cursor-cli' || connection.id === 'codex-cli') {
        const version = await statusCommand(connection, this.controller.signal, ['--version']);
        const parsed = version.code === 0 ? /\b(\d{4}\.\d{2}\.\d{2}(?:-[a-zA-Z0-9]+)?|\d+\.\d+\.\d+)\b/.exec(version.output)?.[1] : undefined;
        if (parsed) available = { ...available, version: parsed };
      }
      if (connection.authenticationMode === 'api-key') return { ...available, available: base.configured, authentication: 'not-verified', message: base.configured ? 'Explicit API-key mode is configured. Access and metered billing will be checked by the next task; account fallback is disabled.' : 'Save an API key for the selected API-key mode. Account fallback is disabled.' };
      const result = await statusCommand(connection, this.controller.signal);
      if (connection.id === 'cursor-cli') {
        const account = parseProviderAccount('cursor-cli', result.code, result.output);
        return { ...available, authentication: account.signedIn === true ? 'authenticated' : account.signedIn === false ? 'signed-out' : 'unknown',
          message: account.message + ' Cursor owns native permissions, hooks and subagents; Werk tool grants do not restrict them.' };
      }
      if (connection.id === 'codex-cli') {
        if (connection.authenticationMode === 'cli-account' && result.code === 0 && !/not logged in|not authenticated/i.test(result.output) && !/^Logged in using ChatGPT(?:\s|$)/im.test(result.output)) return { ...available, available: false, authentication: 'unknown', message: 'The CLI did not confirm the selected ChatGPT account mode. Sign in with that account or explicitly choose API-key billing.' };
        if (/not logged in|not authenticated/i.test(result.output)) return { ...available, authentication: 'signed-out', message: 'Run codex login in a terminal as the worker account, then check again.' };
        if (result.code === 0 && /^Logged in(?: using\b|$)/im.test(result.output)) return { ...available, authentication: 'authenticated', message: 'Codex reports a signed-in account. No model request was made.' };
      } else {
        try {
          const value = JSON.parse(result.output);
          if (value.loggedIn === true && connection.authenticationMode === 'cli-account' && !['claude.ai', 'oauth_token'].includes(value.authMethod)) return { ...available, available: false, authentication: 'unknown', message: 'Claude Code did not confirm a Claude account/subscription login. Sign in with that account or explicitly choose API-key billing.' };
          if (value.loggedIn === true && result.code === 0) return { ...available, authentication: 'authenticated', message: 'Claude Code reports a signed-in account. No model request was made.' };
          if (value.loggedIn === false) return { ...available, authentication: 'signed-out', message: 'Run claude auth login in a terminal as the worker account, then check again.' };
        } catch { /* Older CLI versions may not provide a machine-readable status. */ }
      }
      return { ...available, authentication: 'unknown', message: 'The CLI could not confirm login. Check its status in the worker account terminal; updating the CLI may be needed.' };
    } catch { return { ...available, ...(connection.id === 'claude-cli' && available.compatibility !== 'minimum_met' ? { available: false, minimumVersion: minimumClaudeVersion, compatibility: 'unknown' as const } : {}), authentication: 'unknown', message: 'The CLI status check failed or timed out. Check the installation and login in the worker account terminal.' }; }
  }
  async close() { this.controller.abort(); await Promise.allSettled([...this.pending.values()].map(item => item.operation)); this.cached.clear(); }
}
