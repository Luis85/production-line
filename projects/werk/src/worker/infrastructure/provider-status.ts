import { spawn } from 'node:child_process';
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
}
async function statusCommand(connection: ProviderConnection, cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(connection.executable, connection.id === 'codex-cli' ? ['login', 'status'] : ['auth', 'status'], { cwd, env: providerEnvironment(connection.id === 'codex-cli' ? 'codex' : 'claude'), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output: Buffer[] = []; let bytes = 0, failed = false;
    const kill = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { failed = true; kill(); }, 5000);
    const collect = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536) { failed = true; kill(); } else output.push(chunk); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', () => { failed = true; });
    child.once('close', code => { clearTimeout(timer); kill(); if (failed) reject(Error('Provider status unavailable')); else resolve({ code, output: Buffer.concat(output).toString('utf8') }); });
  });
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
    if (process.platform === 'win32') return { ...base, authentication: 'unavailable', message: 'Subscription CLI execution needs a native Linux or macOS worker. Use an API provider on Windows.' };
    if (!connection.executable) return { ...base, authentication: 'unavailable', message: 'Install the provider CLI and save its absolute executable path.' };
    try { await access(connection.executable, constants.X_OK); } catch { return { ...base, authentication: 'unavailable', message: 'The saved CLI executable cannot be run by the worker account.' }; }
    const available = { ...base, available: true };
    const directory = await mkdtemp(join(tmpdir(), 'werk-provider-status-'));
    try {
      const result = await statusCommand(connection, directory);
      if (connection.id === 'codex-cli') {
        if (/not logged in|not authenticated/i.test(result.output)) return { ...available, authentication: 'signed-out', message: 'Run codex login in a terminal as the worker account, then check again.' };
        if (result.code === 0 && /^Logged in(?: using\b|$)/im.test(result.output)) return { ...available, authentication: 'authenticated', message: 'Codex reports a signed-in account. No model request was made.' };
      } else {
        try {
          const value = JSON.parse(result.output);
          if (value.loggedIn === true && result.code === 0) return { ...available, authentication: 'authenticated', message: 'Claude Code reports a signed-in account. No model request was made.' };
          if (value.loggedIn === false) return { ...available, authentication: 'signed-out', message: 'Run claude auth login in a terminal as the worker account, then check again.' };
        } catch { /* Older CLI versions may not provide a machine-readable status. */ }
      }
      return { ...available, authentication: 'unknown', message: 'The CLI could not confirm login. Check its status in the worker account terminal; updating the CLI may be needed.' };
    } catch { return { ...available, authentication: 'unknown', message: 'The CLI status check failed or timed out. Check the installation and login in the worker account terminal.' }; }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}
