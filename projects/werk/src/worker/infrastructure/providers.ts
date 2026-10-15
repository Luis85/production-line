import { providerTransport } from './provider-transport.js';
import { providerUsage } from './provider-usage.js';
import type { ProviderUsage } from '../application/run-evidence.js';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { ChatMessage } from '../application/conversation.js';
import { classifyProviderStatus, legacyModelReply, observeModelInvocation, modelCapabilities, parseModelResult, ProviderModelError, requireModelRequest, type ModelRequest, type ModelResult, type StructuredModel } from '../application/model-contract.js';
import { CodexConversationModel } from './conversation.js';
import { providerCommand } from './codex-adapter.js';
import { ensureDirectory } from './journal/files.js';
export type ProviderId = 'codex-cli' | 'claude-cli' | 'openai-api' | 'anthropic-api';
export interface ProviderConnection { id: ProviderId; executable: string; model: string; apiKey: string; instruction?: string; }
export const providerIds: ProviderId[] = ['codex-cli', 'claude-cli', 'openai-api', 'anthropic-api'];
export const providerLabels: Record<ProviderId, string> = { 'codex-cli': 'Codex CLI', 'claude-cli': 'Claude Code CLI', 'openai-api': 'OpenAI · API', 'anthropic-api': 'Claude · API' };
export async function findExecutable(name: string) {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const path = join(directory, process.platform === 'win32' ? name + '.exe' : name);
    if (!isAbsolute(path)) continue;
    try { await access(path, constants.X_OK); return path; } catch { /* Next PATH directory. */ }
  }
  return '';
}
export function providerReady(connection: ProviderConnection) { return connection.id.endsWith('-cli') ? !!connection.executable : !!connection.apiKey && !!connection.model; }
export function modelFor(saved: ProviderConnection, directory: string, transport: typeof fetch = providerTransport): StructuredModel | undefined {
  // Codex CLI conversations remain POSIX-only; Claude Code CLI also runs on native Windows.
  if (!providerReady(saved) || (process.platform === 'win32' && saved.id === 'codex-cli')) return;
  const connection = { ...saved };
  if (connection.id === 'codex-cli') return new CodexConversationModel(connection.executable, directory, connection.instruction, connection.model);
  const model: StructuredModel = {
    configuration: Object.freeze({ id: connection.id, model: connection.model, instruction: connection.instruction ?? '' }), capabilities: modelCapabilities,
    reply(messages: ChatMessage[], signal: AbortSignal, onUsage?: (usage: ProviderUsage) => void) { return legacyModelReply(model, messages, signal, onUsage); },
    async execute(request: ModelRequest, signal: AbortSignal, onUsage?: (usage: ProviderUsage) => void): Promise<ModelResult> {
      requireModelRequest(request, connection.id);
      return observeModelInvocation(signal, onUsage, observe => connection.id === 'claude-cli'
        ? claudeReply(connection, directory, request, signal, observe)
        : apiReply(connection, request, signal, transport, observe));
    }
  };
  return model;
}
/** Every isolation flag stays enabled on every platform. */
export function claudeArguments(model: string, promptFile: string) {
  return ['--print', '--output-format', 'json', '--safe-mode', '--restricted', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--no-session-persistence', '--disable-slash-commands', ...(model ? ['--model', model] : []), '--system-prompt-file', promptFile];
}
async function claudeReply(connection: ProviderConnection, directory: string, request: ModelRequest, signal: AbortSignal, onUsage?: (usage: ProviderUsage) => void) {
  const cwd = join(directory, 'chat-workspace'); await ensureDirectory(cwd);
  // Instructions can exceed one argument (Linux) or the whole command line (Windows); pass them as a private file.
  const promptDirectory = await mkdtemp(join(tmpdir(), 'werk-claude-prompt-'));
  let result: Buffer;
  try {
    const promptFile = join(promptDirectory, 'system-prompt.md');
    await writeFile(promptFile, request.protocolInstructions, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    result = await providerCommand(connection.executable, claudeArguments(request.provider.model, promptFile), cwd, signal, JSON.stringify(request.messages.map(({ role, text }) => ({ role, content: text }))), true, 'claude', output => {
      let response; try { response = JSON.parse(output.toString('utf8')); } catch { return; }
      if (response?.type === 'result') onUsage?.(providerUsage('claude', response));
    });
  } finally { await rm(promptDirectory, { recursive: true, force: true }); }
  let value; try { value = JSON.parse(result.toString('utf8')); } catch { throw new ProviderModelError('protocol'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderModelError('protocol');
  if (value.is_error) throw new ProviderModelError('unavailable');
  if (typeof value.result !== 'string') throw new ProviderModelError('protocol');
  return parseModelResult(value.result);
}
async function apiReply(connection: ProviderConnection, request: ModelRequest, signal: AbortSignal, transport: typeof fetch, onUsage?: (usage: ProviderUsage) => void) {
  const openai = connection.id === 'openai-api';
  let response;
  try {
    response = await transport(openai ? 'https://api.openai.com/v1/responses' : 'https://api.anthropic.com/v1/messages', {
      method: 'POST', signal, redirect: 'error', headers: { 'content-type': 'application/json', ...(openai ? { authorization: `Bearer ${connection.apiKey}` } : { 'x-api-key': connection.apiKey, 'anthropic-version': '2023-06-01' }) },
      body: JSON.stringify(openai ? { model: request.provider.model, instructions: request.protocolInstructions, store: false, max_output_tokens: 8192, input: request.messages.map(({ role, text }) => ({ role, content: text })) } : { model: request.provider.model, system: request.protocolInstructions, max_tokens: 8192, messages: request.messages.map(({ role, text }) => ({ role, content: text })) })
    });
  } catch { throw new ProviderModelError(signal.aborted ? 'cancelled' : 'unavailable'); }
  const reader = response.body?.getReader(); if (!reader) throw response.ok ? new ProviderModelError('protocol') : classifyProviderStatus(response.status);
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 1048576) throw new ProviderModelError('protocol'); chunks.push(part.value); } }
  catch (error) { if (error instanceof ProviderModelError) throw error; throw new ProviderModelError(signal.aborted ? 'cancelled' : 'unavailable'); }
  finally { await reader.cancel().catch(() => {}); }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw response.ok ? new ProviderModelError('protocol') : classifyProviderStatus(response.status); }
  onUsage?.(providerUsage(openai ? 'openai' : 'anthropic', value));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw response.ok ? new ProviderModelError('protocol') : classifyProviderStatus(response.status);
  if (!response.ok) throw classifyProviderStatus(response.status, value);
  if (openai && value.status !== 'completed') throw new ProviderModelError('incomplete');
  if (!openai && value.stop_reason === 'refusal') throw new ProviderModelError('refusal');
  if (!openai && !['end_turn', 'stop_sequence'].includes(value.stop_reason)) throw new ProviderModelError('incomplete');
  if (openai && !Array.isArray(value.output) || !openai && !Array.isArray(value.content)) throw new ProviderModelError('protocol');
  if (openai && value.output.some((item: any) => !['message', 'reasoning'].includes(item?.type))) throw new ProviderModelError('protocol');
  const blocks = openai ? value.output.filter((item: any) => item.type === 'message').flatMap((item: any) => item.content ?? []) : value.content;
  if (blocks.some((item: any) => item?.type === 'refusal')) throw new ProviderModelError('refusal');
  if (blocks.some((item: any) => ![openai ? 'output_text' : 'text', 'thinking', 'redacted_thinking'].includes(item?.type))) throw new ProviderModelError('protocol');
  if (blocks.filter((item: any) => item.type === (openai ? 'output_text' : 'text')).some((item: any) => typeof item.text !== 'string')) throw new ProviderModelError('protocol');
  return parseModelResult(blocks.filter((item: any) => item.type === (openai ? 'output_text' : 'text')).map((item: any) => item.text).join('\n\n'));
}
