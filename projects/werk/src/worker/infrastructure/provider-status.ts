import { runProcess } from '../../shared/process/launcher.js';
import { constants } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { providerEnvironment } from './codex-adapter.js';
import { providerReady, type ProviderConnection, type ProviderId } from './providers.js';
export interface ProviderStatus {
  id: ProviderId; configured: boolean; available: boolean;
  authentication: 'authenticated' | 'signed-out' | 'unknown' | 'unavailable' | 'not-verified';
  message: string; checkedAt: string;
  minimumVersion?: string; version?: string; compatibility?: 'minimum_met' | 'unsupported' | 'unknown';
}
async function statusCommand(connection: ProviderConnection, cwd: string, args = connection.id === 'codex-cli' ? ['login', 'status'] : ['auth', 'status']): Promise<{ code: number | null; output: string }> {
  // Claude's machine-readable stdout must remain separate from startup diagnostics.
  // Codex reports login status on stderr; both streams always count toward the limit.
  try {
    const result = await runProcess(connection.executable, args, { cwd, env: providerEnvironment(connection.id === 'codex-cli' ? 'codex' : 'claude'), mode: 'contained', timeoutMs: 5000, maxOutputBytes: 65536, graceMs: 0, captureStderr: connection.id === 'codex-cli', allowNonZeroExit: true });
    return { code: result.exitCode, output: Buffer.concat([result.stdout, result.stderr]).toString('utf8') };
  } catch { throw Error('Provider status unavailable'); }
}
/** A bounded per-provider single-flight cache prevents repeated clicks from spawning unbounded processes. */
export class ProviderStatusChecks {
  private pending = new Map<ProviderId, { key: string; operation: Promise<ProviderStatus> }>();
  private cached = new Map<ProviderId, { key: string; until: number; value: ProviderStatus }>();
  async check(connection: ProviderConnection): Promise<ProviderStatus> {
    const key = JSON.stringify([connection.executable, connection.model, !!connection.apiKey]);
    const cached = this.cached.get(connection.id);
    if (cached && cached.key === key && cached.until > Date.now()) return cached.value;
    const pending = this.pending.get(connection.id);
    if (pending) { if (pending.key === key) return pending.operation; await pending.operation; return this.check(connection); }
    const operation = this.inspect({ ...connection }).then(value => { this.cached.set(connection.id, { key, until: Date.now() + 5000, value }); return value; }).finally(() => this.pending.delete(connection.id));
    this.pending.set(connection.id, { key, operation }); return operation;
  }
  private async inspect(connection: ProviderConnection): Promise<ProviderStatus> {
    const base = { id: connection.id, configured: providerReady(connection), available: false, checkedAt: new Date().toISOString() };
    if (!connection.id.endsWith('-cli')) return { ...base, available: base.configured, authentication: 'not-verified', message: base.configured ? 'API key and model are saved. A task will verify provider access; this check makes no API request.' : 'Save an API key and model to connect this provider.' };
    if (process.platform === 'win32' && connection.id === 'codex-cli') return { ...base, authentication: 'unavailable', message: 'Codex CLI execution needs a native Linux or macOS worker. Use Claude Code CLI or an API provider on Windows.' };
    if (!connection.executable) return { ...base, authentication: 'unavailable', message: 'Install the provider CLI and save its absolute executable path.' };
    try { await access(connection.executable, constants.X_OK); } catch { return { ...base, authentication: 'unavailable', message: 'The saved CLI executable cannot be run by the worker account.' }; }
    let available: Omit<ProviderStatus, 'authentication' | 'message'> = { ...base, available: true };
    const directory = await mkdtemp(join(tmpdir(), 'werk-provider-status-'));
    try {
      if (connection.id === 'claude-cli') {
        const version = await statusCommand(connection, directory, ['--version']);
        const matched = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,6})(?:\s|\(|$)/m.exec(version.output);
        const parts = matched?.slice(1).map(Number);
        const minimumMet = !!parts && (parts[0] > 2 || parts[0] === 2 && (parts[1] > 1 || parts[1] === 1 && parts[2] >= 248));
        available = { ...available, minimumVersion: '2.1.248', ...(matched && version.code === 0 ? { version: matched.slice(1).join('.'), compatibility: minimumMet ? 'minimum_met' : 'unsupported' } : { compatibility: 'unknown' }) };
        if (available.compatibility === 'unsupported') return { ...available, available: false, authentication: 'unknown', message: 'Upgrade Claude Code to 2.1.248 or later. This worker requires --restricted and keeps all no-tools isolation flags enabled. No model request was made.' };
      }
      const result = await statusCommand(connection, directory);
      if (connection.id === 'codex-cli') {
        if (/not logged in|not authenticated/i.test(result.output)) return { ...available, authentication: 'signed-out', message: 'Run codex login in a terminal as the worker account, then check again.' };
        if (result.code === 0 && /^Logged in(?: using\b|$)/im.test(result.output)) return { ...available, authentication: 'authenticated', message: 'Codex reports a signed-in account. No model request was made.' };
      } else {
        try {
          const value = JSON.parse(result.output);
          if (value.loggedIn === true && result.code === 0) return { ...available, authentication: 'authenticated', message: 'Claude Code reports a signed-in account. No model request was made.' + (available.compatibility === 'unknown' ? ' The CLI version could not be verified; this worker requires Claude Code 2.1.248 or later.' : '') };
          if (value.loggedIn === false) return { ...available, authentication: 'signed-out', message: 'Run claude auth login in a terminal as the worker account, then check again.' };
        } catch { /* Older CLI versions may not provide a machine-readable status. */ }
      }
      return { ...available, authentication: 'unknown', message: 'The CLI could not confirm login. Check its status in the worker account terminal; updating the CLI may be needed.' };
    } catch { return { ...available, authentication: 'unknown', message: 'The CLI status check failed or timed out. Check the installation and login in the worker account terminal.' }; }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}
