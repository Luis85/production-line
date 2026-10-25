import { providerAuthenticationEnvironment, requireProviderAuthentication, requireAuthenticationSelection } from './provider-authentication.js';
import { structuredProviderFailure } from './provider-failures.js';
import type { ProviderAuthenticationMode } from '../application/provider-capabilities.js';
import { cursorModel } from './cursor-cli.js';
import type { ModelEffort } from '../application/model-effort.js';
import { claudeSessionReply } from './claude-session.js';
import { withReplaySession } from './native-session.js';
import { apiReply } from './provider-api.js';
import { currentToolManifest, withProviderTools, type ProviderOptions } from './provider-tool-session.js';
import { withCliToolBridge, type CliToolBridge } from './cli-tool-bridge.js';
import type { ToolRuntime } from '../application/tool-runtime.js';
import { providerTransport } from './provider-transport.js';
import { providerUsage } from './provider-usage.js';
import type { ProviderUsage } from '../application/run-evidence.js';
import { access, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { ChatMessage } from '../application/conversation.js';
import { legacyModelReply, observeModelInvocation, modelCapabilities, parseModelResult, ProviderModelError, requireModelRequest, type ModelRequest, type ModelInvocationControl, type ModelResult, type StructuredModel } from '../application/model-contract.js';
import { CodexConversationModel } from './conversation.js';
import { providerCommand, type ProviderToolEnvironment } from './provider-process.js';
import { ensureDirectory } from './journal/files.js';
import { providerReady, type ProviderConnection } from '../application/provider-contract.js';
export { providerIds, providerLabels, providerReady } from '../application/provider-contract.js';
export type { ProviderId, ProviderConnection } from '../application/provider-contract.js';
export async function findExecutable(name: string, search: { path?: string; platform?: NodeJS.Platform } = {}) {
  const platform = search.platform ?? process.platform;
  for (const entry of (search.path ?? process.env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)) {
    const directory = entry.startsWith('\"') && entry.endsWith('\"') ? entry.slice(1, -1) : entry;
    const path = join(directory, platform === 'win32' ? name + '.exe' : name);
    if (!isAbsolute(path)) continue;
    try { if (!(await stat(path)).isFile()) continue; await access(path, constants.X_OK); return path; } catch { /* Next PATH directory. */ }
  }
  return '';
}
export function modelFor(saved: ProviderConnection, directory: string, transport: typeof fetch = providerTransport, options: ProviderOptions = {}): StructuredModel | undefined {
  // Codex CLI conversations remain POSIX-only; Claude Code CLI also runs on native Windows.
  if (!providerReady(saved) || (process.platform === 'win32' && saved.id === 'codex-cli')) return;
  const connection = { ...saved };
  if (connection.id === 'codex-cli') return new CodexConversationModel(connection.executable, directory, connection.instruction, connection.model, options.tools, options.session, connection.effort, connection);
  if (connection.id === 'cursor-cli') return cursorModel(connection, directory, options);
  const model: StructuredModel = {
    ...(options.session ? { sessionBinding: structuredClone(options.session.binding) } : {}),
    configuration: Object.freeze({ id: connection.id, model: connection.model, instruction: connection.instruction ?? '', ...(connection.authenticationMode ? { authenticationMode: connection.authenticationMode } : {}), ...(connection.effort === undefined ? {} : { effort: connection.effort }) }),
    get toolManifest() { return currentToolManifest(options.tools); },
    toolManifestFor(policy) { return currentToolManifest(options.tools, policy); },
    get capabilities() { return { ...modelCapabilities, ...(options.session && connection.id === 'claude-cli' ? { continuation: 'provider_session' as const, nativeResume: true } : {}), tools: currentToolManifest(options.tools) ? 'granted' as const : 'none' as const }; },
    reply(messages: ChatMessage[], signal: AbortSignal, onUsage?: (usage: ProviderUsage) => void) { return legacyModelReply(model, messages, signal, onUsage); },
    async execute(request: ModelRequest, signal: AbortSignal, onUsage?: (usage: ProviderUsage) => void, control?: ModelInvocationControl): Promise<ModelResult> {
      requireModelRequest(request, connection.id);
      requireAuthenticationSelection(connection, request.provider.authenticationMode);
      await requireProviderAuthentication(connection, signal);
      return observeModelInvocation(signal, onUsage, observe => withProviderTools(request, signal, options.tools, (runtime, bounded) => connection.id === 'claude-cli'
        ? request.schemaVersion === 2
          ? claudeSessionReply(connection, directory, request, bounded, options.session!, claudeArguments, observe, runtime, control)
          : claudeReply(connection, directory, request, bounded, observe, runtime, control)
        : withReplaySession(request, options.session, '', bounded, control, guarded => apiReply(connection, request, bounded, transport, observe, runtime, guarded)), control));
    }
  };
  return model;
}
/** Keep Claude's MCP client wait aligned with the invocation budget; the worker still enforces every deadline. */
export const claudeToolEnvironment = (bridge?: Pick<CliToolBridge, 'toolTimeoutMs'>): ProviderToolEnvironment => bridge ? { MCP_TOOL_TIMEOUT: String(bridge.toolTimeoutMs) } : {};
/** Native tools stay disabled. Explicit MCP grants use separate hook, memory and configuration controls. */
export function claudeArguments(model: string, promptFile: string, bridge?: CliToolBridge, effort?: ModelEffort, authenticationMode?: ProviderAuthenticationMode) {
  return ['--print', '--output-format', 'json', ...(!bridge ? ['--safe-mode'] : []), '--settings', JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false, enabledPlugins: {}, ...(authenticationMode === 'cli-account' ? { forceLoginMethod: 'claudeai' } : {}) }), '--restricted', '--tools', '', '--strict-mcp-config', '--mcp-config', bridge?.configFile ?? '{"mcpServers":{}}', ...(bridge ? ['--allowedTools', ...bridge.toolNames.map(name => 'mcp__werk__' + name)] : []), '--setting-sources', '', '--no-session-persistence', '--disable-slash-commands', ...(model ? ['--model', model] : []), ...(effort && effort !== 'default' ? ['--effort', effort] : []), '--system-prompt-file', promptFile];
}
async function claudeReply(connection: ProviderConnection, directory: string, request: ModelRequest, signal: AbortSignal, onUsage?: (usage: ProviderUsage) => void, runtime?: ToolRuntime, control?: ModelInvocationControl) {
  const workspace = join(directory, 'chat-workspace'); await ensureDirectory(workspace);
  // Instructions can exceed one argument (Linux) or the whole command line (Windows); pass them as a private file.
  const promptDirectory = await mkdtemp(join(tmpdir(), 'werk-claude-prompt-'));
  const cwd = runtime ? promptDirectory : workspace;
  let result: Buffer;
  try {
    const promptFile = join(promptDirectory, 'system-prompt.md');
    await writeFile(promptFile, request.protocolInstructions, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    result = await withCliToolBridge(runtime, signal, bridge => {
      control?.beforeCall();
      return providerCommand(connection.executable, claudeArguments(request.provider.model, promptFile, bridge, request.provider.effort, connection.authenticationMode), cwd, signal, JSON.stringify(request.messages.map(({ role, text }) => ({ role, content: text }))), true, 'claude', output => {
      let response; try { response = JSON.parse(output.toString('utf8')); } catch { return; }
      if (response?.type === 'result') onUsage?.(providerUsage('claude', response));
      }, { ...claudeToolEnvironment(bridge), ...providerAuthenticationEnvironment(connection) });
    });
  } finally { await rm(promptDirectory, { recursive: true, force: true }); }
  let value; try { value = JSON.parse(result.toString('utf8')); } catch { throw new ProviderModelError('protocol'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderModelError('protocol');
  const failure = structuredProviderFailure(value); if (failure) throw failure;
  if (typeof value.result !== 'string') throw new ProviderModelError('protocol');
  return parseModelResult(value.result);
}
