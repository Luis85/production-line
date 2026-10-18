import { ProviderModelError } from '../application/model-contract.js';
import { MAX_MAX_RUNTIME_MS } from '../application/execution-policy.js';
import { ProcessRunError, runProcess,                } from '../../shared/process/launcher.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const windowsEnvironment = ['SystemRoot', 'windir', 'SystemDrive', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'CLAUDE_CODE_GIT_BASH_PATH'];
/** Provider diagnostics never become logs/evidence; operator authentication is inherited, never copied. */
export function providerEnvironment(provider = 'codex')                    {
    const env                    = {};
    for (const key of ['PATH', 'HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'LANG', 'LC_ALL']) if (process.env[key]) env[key] = process.env[key];
    // Windows CLIs locate the OS account's profile, login and temporary files through these.
    if (process.platform === 'win32') for (const key of windowsEnvironment) if (process.env[key]) env[key] = process.env[key];
    // Preserve managed-runtime policy/auth routing; never copy these values to task evidence.
    for (const key of Object.keys(process.env)) if (provider === 'codex' && key.startsWith('CODEX_') && process.env[key]) env[key] = process.env[key];
    return { ...env, ...(provider === 'claude' ? { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0' } : {}), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
}
/** Only the worker-derived MCP wait may augment the provider environment. */
                                                                       
/** Contained, bounded provider invocation; the shared launcher stops its whole process tree on cancellation. */
export async function providerCommand(executable        , args          , cwd        , signal             , input         , capture = true, provider = 'codex', observeOutput                           , environment                          = {})                  {
    signal.throwIfAborted();
    const env = providerEnvironment(provider);
    if (provider === 'claude' && environment.MCP_TOOL_TIMEOUT !== undefined) {
        const timeout = Number(environment.MCP_TOOL_TIMEOUT);
        if (!/^\d+$/.test(environment.MCP_TOOL_TIMEOUT) || !Number.isSafeInteger(timeout) || timeout < 1000 || timeout > MAX_MAX_RUNTIME_MS) throw new ProviderModelError('tool_access');
        env.MCP_TOOL_TIMEOUT = String(timeout);
    }
    let result           , failed = false;
    try { result = await runProcess(executable, args, { cwd, env, mode: 'contained', signal, input, maxOutputBytes: 4 * 1024 * 1024, captureStdout: capture }); }
    catch (error) { if (!(error instanceof ProcessRunError)) throw error; result = error.result; failed = true; }
    // Numeric telemetry may exist even when execution fails; diagnostics never leave this callback.
    try { observeOutput?.(result.stdout); } catch { /* Telemetry must not mask process cleanup or outcome. */ }
    if (failed || signal.aborted) throw new ProviderModelError(signal.aborted ? 'cancelled' : 'unavailable');
    return result.stdout;
}

/** One read-only CLI probe owns a private cwd and a contained process, including cleanup on cancellation. */
export async function runProviderProbe(executable        , provider                    , args          , options   
                                                                   
 )                     {
    options.signal.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), 'werk-provider-probe-'));
    try {
        return await runProcess(executable, args, { ...options, cwd: directory, env: providerEnvironment(provider),
            mode: 'contained', graceMs: 0, captureStderr: provider === 'codex', allowNonZeroExit: true });
    } finally { await rm(directory, { recursive: true, force: true }).catch(() => {}); }
}
