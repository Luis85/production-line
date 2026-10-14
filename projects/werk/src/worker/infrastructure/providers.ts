import { providerUsage } from './provider-usage.js';
import type { ProviderUsage } from '../application/run-evidence.js';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { ConversationModel, ChatMessage } from '../application/conversation.js';
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
export function modelFor(connection: ProviderConnection, directory: string, transport: typeof fetch = fetch): ConversationModel | undefined {
  if (!providerReady(connection) || (process.platform === 'win32' && connection.id.endsWith('-cli'))) return;
  if (connection.id === 'codex-cli') return new CodexConversationModel(connection.executable, directory, connection.instruction, connection.model);
  if (connection.id === 'claude-cli') return { async reply(messages: ChatMessage[], signal: AbortSignal, onUsage?: (usage: ProviderUsage) => void) {
    if (process.platform === 'win32') throw Error('Subscription CLI requires a POSIX host');
    const cwd = join(directory, 'chat-workspace'); await ensureDirectory(cwd);
    const result = await providerCommand(connection.executable, ['--print', '--output-format', 'json', '--safe-mode', '--restricted', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--no-session-persistence', '--disable-slash-commands', ...(connection.model ? ['--model', connection.model] : []), '--system-prompt', 'Answer the supplied conversation in plain text. No tools or live system access are available.' + (connection.instruction ? '\nTask agent instructions:\n' + connection.instruction : '')], cwd, signal, JSON.stringify(messages.map(({ role, text }) => ({ role, content: text }))), true, 'claude', output => {
      let response; try { response = JSON.parse(output.toString('utf8')); } catch { return; }
      if (response?.type === 'result') onUsage?.(providerUsage('claude', response));
    });
    const value = JSON.parse(result.toString('utf8'));
    if (value.is_error || typeof value.result !== 'string') throw Error('Invalid Claude response');
    return value.result;
  } };
  return { async reply(messages: ChatMessage[], signal: AbortSignal, onUsage?: (usage: ProviderUsage) => void) {
    const openai = connection.id === 'openai-api';
    const response = await transport(openai ? 'https://api.openai.com/v1/responses' : 'https://api.anthropic.com/v1/messages', {
      method: 'POST', signal, redirect: 'error', headers: { 'content-type': 'application/json', ...(openai ? { authorization: `Bearer ${connection.apiKey}` } : { 'x-api-key': connection.apiKey, 'anthropic-version': '2023-06-01' }) },
      body: JSON.stringify(openai ? { model: connection.model, ...(connection.instruction ? { instructions: connection.instruction } : {}), store: false, max_output_tokens: 8192, input: messages.map(({ role, text }) => ({ role, content: text })) } : { model: connection.model, ...(connection.instruction ? { system: connection.instruction } : {}), max_tokens: 8192, messages: messages.map(({ role, text }) => ({ role, content: text })) })
    });
    const reader = response.body?.getReader(); if (!reader) throw Error('Empty provider response');
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 1048576) throw Error('Provider response limit'); chunks.push(part.value); } }
    finally { await reader.cancel(); }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Error(response.ok ? 'Invalid provider response' : 'Provider API request failed'); }
    onUsage?.(providerUsage(openai ? 'openai' : 'anthropic', value));
    if (!response.ok) throw Error('Provider API request failed');
    if (openai && value.status !== 'completed') throw Error('Incomplete provider response');
    if (!openai && !['end_turn', 'stop_sequence'].includes(value.stop_reason)) throw Error('Incomplete provider response');
    const blocks = openai ? (value.output ?? []).filter((item: any) => item.type === 'message').flatMap((item: any) => item.content ?? []) : value.content ?? [];
    return blocks.filter((item: any) => item.type === (openai ? 'output_text' : 'text')).map((item: any) => item.text).join('\n\n');
  } };
}
