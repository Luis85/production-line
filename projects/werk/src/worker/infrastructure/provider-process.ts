import { cliFailure } from './provider-failures.js';
import type { ProviderAuthenticationMode } from '../application/provider-capabilities.js';
import { createHash } from 'node:crypto';
import type { ProviderConnection } from '../application/provider-contract.js';
import { ProviderModelError } from '../application/model-contract.js';
import { MAX_MAX_RUNTIME_MS } from '../application/execution-policy.js';
import { ProcessRunError, runProcess, type RunResult } from '../../shared/process/launcher.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Private cache identity changes when operator credentials change, without retaining raw keys. */
export function providerProbeKey(connection: ProviderConnection): string {
    const credentials = connection.id === 'cursor-cli' ? [connection.apiKey || process.env.CURSOR_API_KEY || '', process.env.CURSOR_AUTH_TOKEN ?? '', process.env.CURSOR_CONFIG_DIR ?? '', process.env.XDG_CONFIG_HOME ?? ''] : [connection.apiKey];
    return JSON.stringify([connection.executable, connection.model, connection.authenticationMode, createHash('sha256').update(JSON.stringify(credentials)).digest('hex')]);
}
const windowsEnvironment = ['SystemRoot', 'windir', 'SystemDrive', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'CLAUDE_CODE_GIT_BASH_PATH'];
/** Provider diagnostics never become logs/evidence; operator authentication is inherited, never copied. */
export function providerEnvironment(provider = 'codex'): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'LANG', 'LC_ALL']) if (process.env[key]) env[key] = process.env[key];
    // Windows CLIs locate the OS account's profile, login and temporary files through these.
    if (process.platform === 'win32') for (const key of windowsEnvironment) if (process.env[key]) env[key] = process.env[key];
    // Preserve managed-runtime policy/auth routing; never copy these values to task evidence.
    for (const key of Object.keys(process.env)) if (provider === 'codex' && key.startsWith('CODEX_') && process.env[key]) env[key] = process.env[key];
    if (provider === 'cursor') for (const key of ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN', 'CURSOR_CONFIG_DIR', 'XDG_CONFIG_HOME']) if (process.env[key]) env[key] = process.env[key];
    return { ...env, ...(provider === 'claude' ? { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0' } : {}), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
}
/** Only typed provider settings may augment the inherited environment; secrets never become argv/evidence. */
export interface ProviderToolEnvironment { MCP_TOOL_TIMEOUT?: string; CURSOR_API_KEY?: string; CODEX_API_KEY?: string; ANTHROPIC_API_KEY?: string; authenticationMode?: ProviderAuthenticationMode; }
function environmentFor(provider: string, settings: ProviderToolEnvironment) {
    const env = providerEnvironment(provider);
    if (settings.authenticationMode === 'legacy') throw new ProviderModelError('authentication');
    const key = provider === 'codex' ? 'CODEX_API_KEY' : provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'CURSOR_API_KEY';
    if (settings.authenticationMode !== undefined) {
        delete env[key];
        if (provider === 'codex') delete env.OPENAI_API_KEY;
        if (provider === 'cursor' && settings.authenticationMode === 'api-key') delete env.CURSOR_AUTH_TOKEN;
    }
    const value = settings[key];
    if (settings.authenticationMode === 'api-key' && !value) throw new ProviderModelError('authentication');
    if (value !== undefined && settings.authenticationMode !== 'cli-account') {
        if (!value || value.length > 8192 || /[\x00-\x1f]/.test(value)) throw new ProviderModelError('authentication');
        env[key] = value;
    }
    return env;
}
/** Contained, bounded provider invocation; the shared launcher stops its whole process tree on cancellation. */
export async function providerCommand(executable: string, args: string[], cwd: string, signal: AbortSignal, input?: string, capture = true, provider = 'codex', observeOutput?: (output: Buffer) => void, environment: ProviderToolEnvironment = {}): Promise<Buffer> {
    signal.throwIfAborted();
    const env = environmentFor(provider, environment);
    if (provider === 'claude' && environment.MCP_TOOL_TIMEOUT !== undefined) {
        const timeout = Number(environment.MCP_TOOL_TIMEOUT);
        if (!/^\d+$/.test(environment.MCP_TOOL_TIMEOUT) || !Number.isSafeInteger(timeout) || timeout < 1000 || timeout > MAX_MAX_RUNTIME_MS) throw new ProviderModelError('tool_access');
        env.MCP_TOOL_TIMEOUT = String(timeout);
    }
    let result: RunResult, failed = false;
    try { result = await runProcess(executable, args, { cwd, env, mode: 'contained', observation: { kind: 'provider', label: 'Model provider' }, signal, input, maxOutputBytes: 4 * 1024 * 1024, captureStdout: capture }); }
    catch (error) { if (!(error instanceof ProcessRunError)) throw error; result = error.result; failed = true; }
    // Numeric telemetry may exist even when execution fails; diagnostics never leave this callback.
    try { observeOutput?.(result.stdout); } catch { /* Telemetry must not mask process cleanup or outcome. */ }
    if (signal.aborted) throw new ProviderModelError('cancelled');
    if (failed) throw cliFailure(result.stdout);
    return result.stdout;
}

/** A cold Claude Code start takes ~4.4 s on a slow host, so read-only CLI probes get a generous deadline. */
export const providerProbeTimeoutMs = 15000;

/** One read-only CLI probe owns a private cwd and a contained process, including cleanup on cancellation. */
export async function runProviderProbe(executable: string, provider: 'codex' | 'claude' | 'cursor', args: string[], options: {
    signal: AbortSignal; timeoutMs: number; maxOutputBytes: number;
}, environment: ProviderToolEnvironment = {}): Promise<RunResult> {
    options.signal.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), 'werk-provider-probe-'));
    try {
        return await runProcess(executable, args, { ...options, cwd: directory, env: environmentFor(provider, environment),
            mode: 'contained', observation: 'ignore', graceMs: 0, captureStderr: provider !== 'claude', allowNonZeroExit: true });
    } finally { await rm(directory, { recursive: true, force: true }).catch(() => {}); }
}
