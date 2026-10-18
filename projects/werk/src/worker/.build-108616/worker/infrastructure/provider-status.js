import { claudeVersion, minimumClaudeVersion } from './provider-version.js';
import { runProviderProbe } from './provider-process.js';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { providerReady,                                          } from '../application/provider-contract.js';
                                 
                                                          
                                                                                              
                                     
                                                                                                       
 
async function statusCommand(connection                    , signal             , args = connection.id === 'codex-cli' ? ['login', 'status'] : ['auth', 'status'])                                                   {
  // Claude's machine-readable stdout must remain separate from startup diagnostics.
  // Codex reports login status on stderr; both streams always count toward the limit.
  try {
    const result = await runProviderProbe(connection.executable, connection.id === 'codex-cli' ? 'codex' : 'claude', args, { signal, timeoutMs: 5000, maxOutputBytes: 65536 });
    return { code: result.exitCode, output: Buffer.concat([result.stdout, result.stderr]).toString('utf8') };
  } catch { throw Error('Provider status unavailable'); }
}
/** A bounded per-provider single-flight cache prevents repeated clicks from spawning unbounded processes. */
export class ProviderStatusChecks {
          controller = new AbortController();
          pending = new Map                                                                 ();
          cached = new Map                                                                   ();
  async check(connection                    )                          {
    if (this.controller.signal.aborted) return { id: connection.id, configured: providerReady(connection), available: false, authentication: 'unavailable', checkedAt: new Date().toISOString(), message: 'The worker is stopping.' };
    const key = JSON.stringify([connection.executable, connection.model, !!connection.apiKey]);
    const cached = this.cached.get(connection.id);
    if (cached && cached.key === key && cached.until > Date.now()) return cached.value;
    const pending = this.pending.get(connection.id);
    if (pending) { if (pending.key === key) return pending.operation; await pending.operation; return this.check(connection); }
    const operation = this.inspect({ ...connection }).then(value => { if (!this.controller.signal.aborted) this.cached.set(connection.id, { key, until: Date.now() + 5000, value }); return value; }).finally(() => this.pending.delete(connection.id));
    this.pending.set(connection.id, { key, operation }); return operation;
  }
          async inspect(connection                    )                          {
    const base = { id: connection.id, configured: providerReady(connection), available: false, checkedAt: new Date().toISOString() };
    if (!connection.id.endsWith('-cli')) return { ...base, available: base.configured, authentication: 'not-verified', message: base.configured ? 'API key and model are saved. A task will verify provider access; this check makes no API request.' : 'Save an API key and model to connect this provider.' };
    if (process.platform === 'win32' && connection.id === 'codex-cli') return { ...base, authentication: 'unavailable', message: 'Codex CLI execution needs a native Linux or macOS worker. Use Claude Code CLI or an API provider on Windows.' };
    if (!connection.executable) return { ...base, authentication: 'unavailable', message: 'Install the provider CLI and save its absolute executable path.' };
    try { await access(connection.executable, constants.X_OK); } catch { return { ...base, authentication: 'unavailable', message: 'The saved CLI executable cannot be run by the worker account.' }; }
    let available                                                     = { ...base, available: true };
    try {
      if (connection.id === 'claude-cli') {
        const version = await statusCommand(connection, this.controller.signal, ['--version']);
        const parsed = claudeVersion(version.output, version.code);
        available = { ...available, minimumVersion: minimumClaudeVersion, ...(parsed.version ? { version: parsed.version } : {}), compatibility: parsed.compatibility };
        if (parsed.compatibility !== 'minimum_met') return { ...available, available: false, authentication: 'unknown', message: 'Claude Code ' + minimumClaudeVersion + ' or later is required. Update the CLI and check again so this worker can verify isolated feature-request sessions. No model request was made.' };
      }
      const result = await statusCommand(connection, this.controller.signal);
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
    } catch { return { ...available, ...(connection.id === 'claude-cli' && available.compatibility !== 'minimum_met' ? { available: false, minimumVersion: minimumClaudeVersion, compatibility: 'unknown'          } : {}), authentication: 'unknown', message: 'The CLI status check failed or timed out. Check the installation and login in the worker account terminal.' }; }
  }
  async close() { this.controller.abort(); await Promise.allSettled([...this.pending.values()].map(item => item.operation)); this.cached.clear(); }
}
