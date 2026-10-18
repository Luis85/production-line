import { claudeSessionReply } from './claude-session.js';
import { withReplaySession } from './native-session.js';
import { apiReply } from './provider-api.js';
import { currentToolManifest, withProviderTools,                      } from './provider-tool-session.js';
import { withCliToolBridge,                    } from './cli-tool-bridge.js';
                                                                  
import { providerTransport } from './provider-transport.js';
import { providerUsage } from './provider-usage.js';
                                                                    
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
                                                                  
import { legacyModelReply, observeModelInvocation, modelCapabilities, parseModelResult, ProviderModelError, requireModelRequest,                                                                                        } from '../application/model-contract.js';
import { CodexConversationModel } from './conversation.js';
import { providerCommand,                              } from './provider-process.js';
import { ensureDirectory } from './journal/files.js';
import { providerReady,                         } from '../application/provider-contract.js';
export { providerIds, providerLabels, providerReady } from '../application/provider-contract.js';
                                                                                          
export async function findExecutable(name        ) {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const path = join(directory, process.platform === 'win32' ? name + '.exe' : name);
    if (!isAbsolute(path)) continue;
    try { await access(path, constants.X_OK); return path; } catch { /* Next PATH directory. */ }
  }
  return '';
}
export function modelFor(saved                    , directory        , transport               = providerTransport, options                  = {})                              {
  // Codex CLI conversations remain POSIX-only; Claude Code CLI also runs on native Windows.
  if (!providerReady(saved) || (process.platform === 'win32' && saved.id === 'codex-cli')) return;
  const connection = { ...saved };
  if (connection.id === 'codex-cli') return new CodexConversationModel(connection.executable, directory, connection.instruction, connection.model, options.tools, options.session);
  const model                  = {
    ...(options.session ? { sessionBinding: structuredClone(options.session.binding) } : {}),
    configuration: Object.freeze({ id: connection.id, model: connection.model, instruction: connection.instruction ?? '' }),
    get toolManifest() { return currentToolManifest(options.tools); },
    toolManifestFor(policy) { return currentToolManifest(options.tools, policy); },
    get capabilities() { return { ...modelCapabilities, ...(options.session && connection.id === 'claude-cli' ? { continuation: 'provider_session'         , nativeResume: true } : {}), tools: currentToolManifest(options.tools) ? 'granted'          : 'none'          }; },
    reply(messages               , signal             , onUsage                                 ) { return legacyModelReply(model, messages, signal, onUsage); },
    async execute(request              , signal             , onUsage                                 , control                         )                       {
      requireModelRequest(request, connection.id);
      return observeModelInvocation(signal, onUsage, observe => withProviderTools(request, signal, options.tools, (runtime, bounded) => connection.id === 'claude-cli'
        ? request.schemaVersion === 2
          ? claudeSessionReply(connection, directory, request, bounded, options.session , claudeArguments, observe, runtime, control)
          : claudeReply(connection, directory, request, bounded, observe, runtime, control)
        : withReplaySession(request, options.session, '', bounded, control, guarded => apiReply(connection, request, bounded, transport, observe, runtime, guarded)), control));
    }
  };
  return model;
}
/** Keep Claude's MCP client wait aligned with the invocation budget; the worker still enforces every deadline. */
export const claudeToolEnvironment = (bridge                                       )                          => bridge ? { MCP_TOOL_TIMEOUT: String(bridge.toolTimeoutMs) } : {};
/** Native tools stay disabled. Explicit MCP grants use separate hook, memory and configuration controls. */
export function claudeArguments(model        , promptFile        , bridge                ) {
  return ['--print', '--output-format', 'json', ...(!bridge ? ['--safe-mode'] : []), '--settings', JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false, enabledPlugins: {} }), '--restricted', '--tools', '', '--strict-mcp-config', '--mcp-config', bridge?.configFile ?? '{"mcpServers":{}}', ...(bridge ? ['--allowedTools', ...bridge.toolNames.map(name => 'mcp__werk__' + name)] : []), '--setting-sources', '', '--no-session-persistence', '--disable-slash-commands', ...(model ? ['--model', model] : []), '--system-prompt-file', promptFile];
}
async function claudeReply(connection                    , directory        , request              , signal             , onUsage                                 , runtime              , control                         ) {
  const workspace = join(directory, 'chat-workspace'); await ensureDirectory(workspace);
  // Instructions can exceed one argument (Linux) or the whole command line (Windows); pass them as a private file.
  const promptDirectory = await mkdtemp(join(tmpdir(), 'werk-claude-prompt-'));
  const cwd = runtime ? promptDirectory : workspace;
  let result        ;
  try {
    const promptFile = join(promptDirectory, 'system-prompt.md');
    await writeFile(promptFile, request.protocolInstructions, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    result = await withCliToolBridge(runtime, signal, bridge => {
      control?.beforeCall();
      return providerCommand(connection.executable, claudeArguments(request.provider.model, promptFile, bridge), cwd, signal, JSON.stringify(request.messages.map(({ role, text }) => ({ role, content: text }))), true, 'claude', output => {
      let response; try { response = JSON.parse(output.toString('utf8')); } catch { return; }
      if (response?.type === 'result') onUsage?.(providerUsage('claude', response));
      }, claudeToolEnvironment(bridge));
    });
  } finally { await rm(promptDirectory, { recursive: true, force: true }); }
  let value; try { value = JSON.parse(result.toString('utf8')); } catch { throw new ProviderModelError('protocol'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderModelError('protocol');
  if (value.is_error) throw new ProviderModelError('unavailable');
  if (typeof value.result !== 'string') throw new ProviderModelError('protocol');
  return parseModelResult(value.result);
}
