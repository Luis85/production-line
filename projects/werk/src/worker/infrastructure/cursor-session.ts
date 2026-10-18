import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseModelResult, ProviderModelError, type ModelInvocationControl, type ModelRequest } from '../application/model-contract.js';
import type { ModelSessionAccess } from '../application/model-session.js';
import type { ProviderConnection } from '../application/provider-contract.js';
import { unknownUsage, type ProviderUsage } from '../application/run-evidence.js';
import type { ToolRuntime } from '../application/tool-runtime.js';
import { withCliToolBridge, type CliToolBridge } from './cli-tool-bridge.js';
import { openProviderSession } from './native-session.js';
import { providerCommand } from './provider-process.js';

const chatId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
/** Invocation-local plugin: no repository/user Cursor configuration or approval is rewritten. */
async function withCursorPlugin<T>(bridge: CliToolBridge | undefined, run: (directory?: string) => Promise<T>) {
  if (!bridge) return run();
  const directory = await mkdtemp(join(tmpdir(), 'werk-cursor-plugin-'));
  try {
    await mkdir(join(directory, '.cursor-plugin'), { mode: 0o700 });
    await writeFile(join(directory, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name: 'werk-worker', version: '1.0.0', mcpServers: 'mcp.json' }), { mode: 0o600, flag: 'wx' });
    await writeFile(join(directory, 'mcp.json'), JSON.stringify({ mcpServers: { werk: { command: bridge.command, args: bridge.args } } }), { mode: 0o600, flag: 'wx' });
    return await run(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export async function cursorReply(connection: ProviderConnection, workspace: string, request: ModelRequest, signal: AbortSignal,
  access: ModelSessionAccess | undefined, observe: (usage: ProviderUsage) => void, runtime?: ToolRuntime, control?: ModelInvocationControl) {
  if (request.policy.tools !== 'provider_native' || request.provider.effort && request.provider.effort !== 'default') throw new ProviderModelError('invalid_request');
  const session = request.schemaVersion === 2 ? await openProviderSession(access, request, connection.executable) : undefined;
  const environment = connection.apiKey ? { CURSOR_API_KEY: connection.apiKey } : {};
  try {
    let nativeId = session?.nativeId;
    if (!nativeId) {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
      let output: Buffer;
      try { output = await providerCommand(connection.executable, ['create-chat'], workspace, bounded, undefined, true, 'cursor', undefined, environment); }
      catch { throw new ProviderModelError(signal.aborted ? 'cancelled' : 'unavailable'); }
      nativeId = output.toString('utf8').trim();
    }
    if (!chatId(nativeId)) throw new ProviderModelError('protocol');
    const id = nativeId;
    const output = await withCliToolBridge(request.toolManifest && runtime?.manifest.tools.length ? runtime : undefined, signal, bridge => withCursorPlugin(bridge, async plugin => {
      const args = ['--print', '--output-format', 'json', '--resume', id, ...(request.provider.model ? ['--model', request.provider.model] : []),
        ...(!request.policy.development ? ['--mode', 'ask'] : []), ...(plugin ? ['--plugin-dir', plugin] : [])];
      await session?.begin(id);
      control?.beforeCall();
      session?.markDispatched();
      // No documented CLI token/cost counters: this remains unknown even when a future output resembles another provider.
      observe(unknownUsage('Cursor CLI does not expose documented token or cost counters. Native subagent usage is also unavailable.'));
      const prompt = request.protocolInstructions + '\nConversation JSON:\n' + (session?.input ?? JSON.stringify(request.messages.map(({ role, text }) => ({ role, content: text }))));
      return providerCommand(connection.executable, args, workspace, signal, prompt, true, 'cursor', undefined, environment);
    }));
    let response: unknown; try { response = JSON.parse(output.toString('utf8')); } catch { throw new ProviderModelError('protocol'); }
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new ProviderModelError('protocol');
    const value = response as Record<string, unknown>;
    if (value.type !== 'result' || value.subtype !== 'success' || value.is_error !== false || value.session_id !== id || typeof value.result !== 'string') throw new ProviderModelError('protocol');
    const result = parseModelResult(value.result);
    signal.throwIfAborted();
    await session?.complete(result);
    return result;
  } catch (error) { await session?.interrupted(); throw error; }
}
