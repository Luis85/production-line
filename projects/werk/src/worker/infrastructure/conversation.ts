import { providerAuthenticationEnvironment, requireProviderAuthentication, requireAuthenticationSelection } from './provider-authentication.js';
import { structuredProviderFailure } from './provider-failures.js';
import type { ProviderConnection } from '../application/provider-contract.js';
import type { ModelEffort } from '../application/model-effort.js';
import type { ModelSessionAccess } from '../application/model-session.js';
import { withReplaySession } from './native-session.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { currentToolManifest, withProviderTools, type ToolRuntimeFactory } from './provider-tool-session.js';
import { withCliToolBridge } from './cli-tool-bridge.js';
import { legacyModelReply, observeModelInvocation, modelCapabilities, parseModelResult, ProviderModelError, requireModelRequest, type ModelRequest, type ModelInvocationControl, type StructuredModel } from '../application/model-contract.js';
import type { ProviderUsage } from '../application/run-evidence.js';
import { codexUsage } from './provider-usage.js';
import { join, resolve } from 'node:path';
import type { Conversation, ConversationStore, ChatMessage } from '../application/conversation.js';
import { atomicWrite, ensureDirectory, readBoundedFile } from './journal/files.js';
import { providerCommand } from './codex-adapter.js';
export class FileConversationStore implements ConversationStore {
  private directory: string;
  constructor(directory: string) { this.directory = directory; }
  async read(): Promise<Conversation> {
    try {
      const value = JSON.parse(await readBoundedFile(join(this.directory, 'conversation.json'), 524288));
      if (!value || !Array.isArray(value.messages) || value.messages.length > 60 || value.messages.some((item: ChatMessage) => !item || typeof item.id !== 'string' || !['user', 'assistant'].includes(item.role) || typeof item.text !== 'string' || item.text.length > 32000 || !['pending', 'complete', 'error', 'cancelled'].includes(item.state) || typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at)))) throw Error('Invalid saved conversation');
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { messages: [] }; throw error; }
  }
  write(value: Conversation) { return atomicWrite(join(this.directory, 'conversation.json'), JSON.stringify(value) + '\n'); }
}
export class CodexConversationModel implements StructuredModel {
  get capabilities() { return { ...modelCapabilities, tools: currentToolManifest(this.tools) ? 'granted' as const : 'none' as const }; }
  get toolManifest() { return currentToolManifest(this.tools); }
  toolManifestFor(policy: ModelRequest['policy']) { return currentToolManifest(this.tools, policy); }
  readonly configuration;
  readonly sessionBinding;
  private readonly session?: ModelSessionAccess;
  private readonly connection?: ProviderConnection;
  private executable: string; private directory: string; private readonly tools?: ToolRuntimeFactory;
  constructor(executable: string, directory: string, instruction = '', model = '', tools?: ToolRuntimeFactory, session?: ModelSessionAccess, effort?: ModelEffort, connection?: ProviderConnection) { this.connection = connection; this.session = session; this.sessionBinding = session ? structuredClone(session.binding) : undefined; this.executable = executable; this.directory = directory; this.tools = tools; this.configuration = Object.freeze({ id: 'codex-cli', model, instruction, ...(connection?.authenticationMode ? { authenticationMode: connection.authenticationMode } : {}), ...(effort === undefined ? {} : { effort }) }); }
  reply(messages: ChatMessage[], signal: AbortSignal, onUsage?: (usage: ProviderUsage) => void) { return legacyModelReply(this, messages, signal, onUsage); }
  async execute(request: ModelRequest, signal: AbortSignal, onUsage?: (usage: ProviderUsage) => void, control?: ModelInvocationControl) {
    requireModelRequest(request, 'codex-cli');
    if (this.connection) { requireAuthenticationSelection(this.connection, request.provider.authenticationMode); await requireProviderAuthentication(this.connection, signal); }
    return observeModelInvocation(signal, onUsage, observe => withProviderTools(request, signal, this.tools, (runtime, bounded) => withReplaySession(request, this.session, this.executable, bounded, control, async guarded => {
      const workspace = join(resolve(this.directory), 'chat-workspace');
      await ensureDirectory(workspace);
      const cwd = runtime ? await mkdtemp(join(tmpdir(), 'werk-codex-workspace-')) : workspace;
      try {
      const output = await withCliToolBridge(runtime, bounded, bridge => {
        guarded?.beforeCall();
        return providerCommand(this.executable, ['exec', ...(this.connection?.authenticationMode ? ['-c', 'forced_login_method=' + JSON.stringify(this.connection.authenticationMode === 'cli-account' ? 'chatgpt' : 'api')] : []), ...(request.provider.model ? ['--model', request.provider.model] : []), ...(request.provider.effort && request.provider.effort !== 'default' ? ['-c', 'model_reasoning_effort=' + JSON.stringify(request.provider.effort)] : []), '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'code_mode', '--disable', 'multi_agent', '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0', '-c', 'shell_environment_policy.inherit="none"', ...(bridge ? ['-c', bridge.codexConfig] : []), '-C', cwd, '-'], cwd, bounded, request.renderedPrompt, true, 'codex', output => codexUsage(output, observe), this.connection ? providerAuthenticationEnvironment(this.connection) : {});
      });
      const replies: string[] = [];
      for (const line of output.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let event; try { event = JSON.parse(line); } catch { throw new ProviderModelError('protocol'); }
        if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new ProviderModelError('protocol');
        const failure = structuredProviderFailure(event); if (failure) throw failure;
        if (!['thread.started', 'turn.started', 'turn.completed', 'item.started', 'item.updated', 'item.completed'].includes(event.type)) throw new ProviderModelError('protocol');
        // Unknown native capabilities stay forbidden; MCP events must name this worker bridge and an exposed tool.
        if (event.type.startsWith('item.')) {
          if (!event.item || typeof event.item !== 'object' || Array.isArray(event.item) || !['agent_message', 'reasoning', 'todo_list', ...(runtime ? ['mcp_tool_call'] : [])].includes(event.item.type)) throw new ProviderModelError('protocol');
          if (event.item.type === 'mcp_tool_call' && (event.item.server !== 'werk' || !runtime?.manifest.tools.some(tool => tool.name === event.item.tool))) throw new ProviderModelError('protocol');
          if (event.type === 'item.completed' && event.item.type === 'agent_message') {
            if (typeof event.item.text !== 'string') throw new ProviderModelError('protocol');
            replies.push(event.item.text);
          }
        } else if (event.item !== undefined) throw new ProviderModelError('protocol');
      }
      return parseModelResult(replies.join('\n\n'));
      } finally { if (runtime) await rm(cwd, { recursive: true, force: true }); }
    }), control));
  }
}
