import { processRuntimePreparing } from '../../shared/process/launcher.js';
import { providerAuthenticationEnvironment } from './provider-authentication.js';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { providerProbeKey, runProviderProbe } from './provider-process.js';
import type { ProviderConnection, ProviderId } from '../application/provider-contract.js';
import type { ProviderAccountStatus } from '../application/provider-account.js';

const identity = () => ({ account: null, email: null, organization: null, subscription: null, authMethod: null });
function safeText(value: unknown, max = 160): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > max || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(text) || /(?:\bBearer\s|\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{12}|\bgh[pousr]_[A-Za-z0-9]{12}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.)/.test(text)) return null;
  return text;
}
/** Whitelist structured status fields; credentials and arbitrary CLI diagnostics never leave this parser. */
export function parseProviderAccount(id: ProviderId, exitCode: number | null, stdout: string, stderr = '', checkedAt = new Date().toISOString()): ProviderAccountStatus {
  const base: ProviderAccountStatus = { id, signedIn: 'unknown', ...identity(), checkedAt, message: 'The CLI did not expose a supported account status. Update the CLI or inspect its status in the worker account terminal.' };
  if (id === 'codex-cli') {
    const output = stdout + '\n' + stderr;
    if (/not logged in|not authenticated/i.test(output)) return { ...base, signedIn: false, message: 'Codex reports no signed-in account for the worker process owner.' };
    if (exitCode === 0 && /^Logged in(?: using\b|$)/im.test(output)) {
      const authMethod = /^Logged in using ChatGPT(?:\s|$)/im.test(output) ? 'ChatGPT' : /^Logged in using (?:an? )?API key(?:\s|$)/im.test(output) ? 'API key' : null;
      return { ...base, signedIn: true, authMethod, message: 'Codex reports a signed-in account. Account identity and subscription details are unavailable from this CLI status command.' };
    }
    return base;
  }
  if (id === 'cursor-cli') {
    // The CLI has no documented JSON status contract; accept only narrow status lines and safe email.
    const output = (stdout + '\n' + stderr).replace(/\x1b\[[0-9;]*m/g, '');
    if (/^(?:[✓✔]\s*)?(?:Not authenticated|Not logged in|Logged out)[.!]?\s*$/im.test(output)) return { ...base, signedIn: false, message: 'Cursor reports no signed-in account. Run agent login as the worker account.' };
    const match = /^(?:[✓✔]\s*)?(?:Logged in|Authenticated)(?: as ([^\s@]+@[^\s@]+\.[^\s@]+))?[.!]?\s*$/im.exec(output);
    if (exitCode === 0 && match) return { ...base, signedIn: true, email: safeText(match[1], 254), message: 'Cursor reports a signed-in account. Subscription, quota and model access were not checked.' };
    return { ...base, message: 'Cursor did not expose a recognized status line. Run agent status as the worker account; no model request was made.' };
  }
  if (id !== 'claude-cli') return { ...base, message: 'Account identity is unavailable for API-key connections. No provider request was made.' };
  let value: Record<string, unknown>;
  try { const parsed: unknown = JSON.parse(stdout); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base; value = parsed as Record<string, unknown>; } catch { return base; }
  if (value.loggedIn === false) return { ...base, signedIn: false, message: 'Claude Code reports no signed-in account for the worker process owner.' };
  if (value.loggedIn !== true || exitCode !== 0) return base;
  const method = safeText(value.authMethod, 80);
  const authMethod = method && ['claude.ai', 'oauth', 'oauth_token', 'api_key', 'api-key', 'console', 'bedrock', 'vertex'].includes(method) ? method : null;
  const email = safeText(value.email, 254);
  return { ...base, signedIn: true, account: safeText(value.accountName ?? value.displayName), email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null, organization: safeText(value.orgName ?? value.organization), subscription: safeText(value.subscriptionType), authMethod, message: 'Claude Code reported these account details. Subscription quota and model access were not checked.' };
}
/** Read-only probes are bounded, single-flight per provider, cached for five seconds and cancellable on shutdown. */
export class ProviderAccountChecks {
  private pending = new Map<ProviderId, { key: string; operation: Promise<ProviderAccountStatus> }>();
  private cached = new Map<ProviderId, { key: string; until: number; value: ProviderAccountStatus }>();
  private controller = new AbortController();
  async check(connection: ProviderConnection): Promise<ProviderAccountStatus> {
    if (this.controller.signal.aborted) return this.unavailable(connection.id, 'The worker is stopping.');
    const key = providerProbeKey(connection);
    const cached = this.cached.get(connection.id);
    if (cached && cached.key === key && cached.until > Date.now()) return structuredClone(cached.value);
    const pending = this.pending.get(connection.id);
    if (pending) { if (pending.key === key) return pending.operation.then(value => structuredClone(value)); await pending.operation; return this.check(connection); }
    const operation = this.inspect({ ...connection }).then(value => { if (!this.controller.signal.aborted) this.cached.set(connection.id, { key, until: Date.now() + 5000, value }); return value; }).finally(() => this.pending.delete(connection.id));
    this.pending.set(connection.id, { key, operation }); return operation.then(value => structuredClone(value));
  }
  private unavailable(id: ProviderId, message: string): ProviderAccountStatus { return { id, signedIn: 'unknown', ...identity(), checkedAt: new Date().toISOString(), message }; }
  private async inspect(connection: ProviderConnection): Promise<ProviderAccountStatus> {
    if (connection.authenticationMode === 'legacy') return this.unavailable(connection.id, 'Choose authentication and billing in Settings before checking this provider.');
    if (connection.authenticationMode === 'api-key') return this.unavailable(connection.id, 'Explicit API-key billing is selected. Account identity is unavailable; no provider request was made.');
    if (!connection.id.endsWith('-cli')) return this.unavailable(connection.id, 'Account identity is unavailable for API-key connections. No provider request was made.');
    if (process.platform === 'win32' && connection.id === 'codex-cli') return this.unavailable(connection.id, 'Codex CLI account checks require a native Linux or macOS worker.');
    if (!connection.executable) return this.unavailable(connection.id, 'Save the provider CLI executable before checking its account.');
    try { await access(connection.executable, constants.X_OK); } catch { return this.unavailable(connection.id, 'The saved CLI executable cannot be run by the worker account.'); }
    try {
      const args = connection.id === 'codex-cli' ? ['login', 'status'] : connection.id === 'cursor-cli' ? ['status'] : ['auth', 'status'];
      const result = await runProviderProbe(connection.executable, connection.id === 'codex-cli' ? 'codex' : connection.id === 'cursor-cli' ? 'cursor' : 'claude', args, { signal: this.controller.signal, timeoutMs: 5000, maxOutputBytes: 16384 }, providerAuthenticationEnvironment(connection));
      return parseProviderAccount(connection.id, result.exitCode, result.stdout.toString('utf8'), result.stderr.toString('utf8'));
    } catch { return this.unavailable(connection.id, processRuntimePreparing() ? 'The Windows command runtime is preparing. Retry shortly; no account identity was confirmed.' : 'The account check failed, timed out or returned too much output. Retry after checking the CLI installation.'); }
  }
  async close() { this.controller.abort(); await Promise.allSettled([...this.pending.values()].map(item => item.operation)); this.cached.clear(); }
}
