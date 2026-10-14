import { legacyModelReply, modelCapabilities, parseModelResult, ProviderModelError, requireModelRequest, type ModelRequest, type StructuredModel } from '../application/model-contract.js';
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
  readonly capabilities = modelCapabilities;
  readonly configuration;
  private executable: string; private directory: string;
  constructor(executable: string, directory: string, instruction = '', model = '') { this.executable = executable; this.directory = directory; this.configuration = Object.freeze({ id: 'codex-cli', model, instruction }); }
  reply(messages: ChatMessage[], signal: AbortSignal, onUsage?: (usage: ProviderUsage) => void) { return legacyModelReply(this, messages, signal, onUsage); }
  async execute(request: ModelRequest, signal: AbortSignal, onUsage?: (usage: ProviderUsage) => void) {
    requireModelRequest(request, 'codex-cli');
    const cwd = join(resolve(this.directory), 'chat-workspace');
    await ensureDirectory(cwd);
    const output = await providerCommand(this.executable, ['exec', ...(request.provider.model ? ['--model', request.provider.model] : []), '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'code_mode', '--disable', 'multi_agent', '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0', '-c', 'shell_environment_policy.inherit="none"', '-C', cwd, '-'], cwd, signal, request.renderedPrompt, true, 'codex', output => codexUsage(output, onUsage));
    const replies: string[] = [];
    for (const line of output.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let event; try { event = JSON.parse(line); } catch { throw new ProviderModelError('protocol'); }
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new ProviderModelError('protocol');
      if (event.type === 'error' || event.type === 'turn.failed') throw new ProviderModelError('unavailable');
      if (event.item && ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(event.item.type)) throw new ProviderModelError('protocol');
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') replies.push(event.item.text);
    }
    return parseModelResult(replies.join('\n\n'));
  }
}
