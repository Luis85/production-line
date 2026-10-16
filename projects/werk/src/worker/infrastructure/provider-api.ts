import { readResponseBody, ResponseBodyLimitError } from '../../shared/http/response-body.js';
import { classifyProviderStatus, parseModelResult, ProviderModelError, type ModelRequest, type ModelInvocationControl } from '../application/model-contract.js';
import type { ProviderUsage } from '../application/run-evidence.js';
import type { ToolRuntime } from '../application/tool-runtime.js';
import type { ProviderConnection } from './providers.js';
import { providerUsage } from './provider-usage.js';
import { invokeGrantedTool } from './provider-tool-session.js';
import { DEFAULT_MAX_TOOL_CALLS } from '../application/execution-policy.js';
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
function addUsage(previous: ProviderUsage | undefined, next: ProviderUsage): ProviderUsage {
  if (!previous) return next;
  const total = { ...next };
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'providerReportedCostUsd'] as const) {
    const value = previous[key] === null || next[key] === null ? null : previous[key]! + next[key]!;
    total[key] = value !== null && Number.isFinite(value) && (key === 'providerReportedCostUsd' || Number.isSafeInteger(value)) ? value : null;
  }
  return total;
}
async function readResponse(response: Response, signal: AbortSignal) {
  if (!response.body) throw response.ok ? new ProviderModelError('protocol') : classifyProviderStatus(response.status);
  let bytes: Uint8Array;
  try { bytes = await readResponseBody(response.body, 1048576, { cancel: 'always' }); }
  catch (error) {
    if (signal.aborted) throw new ProviderModelError('cancelled');
    if (error instanceof ProviderModelError) throw error;
    if (error instanceof ResponseBodyLimitError) throw new ProviderModelError('protocol');
    throw new ProviderModelError('unavailable');
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw response.ok ? new ProviderModelError('protocol') : classifyProviderStatus(response.status); }
}
/** Stateless tool loops: each turn replays this invocation only; server-side conversation storage stays off. */
export async function apiReply(connection: ProviderConnection, request: ModelRequest, signal: AbortSignal, transport: typeof fetch, onUsage?: (usage: ProviderUsage) => void, runtime?: ToolRuntime, control?: ModelInvocationControl) {
  const openai = connection.id === 'openai-api';
  const history: any[] = request.messages.map(({ role, text }) => ({ role, content: text }));
  const definitions = runtime?.manifest.tools.map(tool => openai
    ? { type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false }
    : { name: tool.name, description: tool.description, input_schema: tool.inputSchema });
  const maxCalls = request.policy.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  let calls = 0, usage: ProviderUsage | undefined;
  const seenCallIds = new Set<string>();
  // One response may finish the task after the last permitted tool call.
  for (let turn = 0; turn <= maxCalls; turn++) {
    if (signal.aborted) throw new ProviderModelError('cancelled');
    const body = openai
      ? { model: request.provider.model, instructions: request.protocolInstructions, store: false, max_output_tokens: 8192, input: history, ...(definitions ? { tools: definitions, parallel_tool_calls: false, include: ['reasoning.encrypted_content'] } : {}) }
      : { model: request.provider.model, system: request.protocolInstructions, max_tokens: 8192, messages: history, ...(definitions ? { tools: definitions } : {}) };
    if (Buffer.byteLength(JSON.stringify(body)) > 4194304) throw new ProviderModelError('protocol');
    control?.beforeCall();
    let response: Response;
    try {
      response = await transport(openai ? 'https://api.openai.com/v1/responses' : 'https://api.anthropic.com/v1/messages', {
        method: 'POST', signal, redirect: 'error', headers: { 'content-type': 'application/json', ...(openai ? { authorization: `Bearer ${connection.apiKey}` } : { 'x-api-key': connection.apiKey, 'anthropic-version': '2023-06-01' }) }, body: JSON.stringify(body)
      });
    } catch (error) {
      if (signal.aborted) throw new ProviderModelError('cancelled');
      if (error instanceof ProviderModelError) throw error;
      if (error instanceof ResponseBodyLimitError) throw new ProviderModelError('protocol');
      throw new ProviderModelError('unavailable');
    }
    const value = await readResponse(response, signal);
    usage = addUsage(usage, providerUsage(openai ? 'openai' : 'anthropic', value)); onUsage?.(usage);
    if (!record(value)) throw response.ok ? new ProviderModelError('protocol') : classifyProviderStatus(response.status);
    if (!response.ok) throw classifyProviderStatus(response.status, value);
    if (openai && value.status !== 'completed') throw new ProviderModelError('incomplete');
    if (!openai && value.stop_reason === 'refusal') throw new ProviderModelError('refusal');
    if (!openai && !['end_turn', 'stop_sequence', ...(runtime ? ['tool_use'] : [])].includes(value.stop_reason)) throw new ProviderModelError('incomplete');
    const items = openai ? value.output : value.content;
    if (!Array.isArray(items) || items.some(item => !record(item))) throw new ProviderModelError('protocol');
    const toolType = openai ? 'function_call' : 'tool_use';
    if (openai && items.some(item => !['message', 'reasoning', ...(runtime ? [toolType] : [])].includes(item.type))) throw new ProviderModelError('protocol');
    const blocks = openai ? items.filter(item => item.type === 'message').flatMap(item => item.content ?? []) : items;
    if (blocks.some(item => item?.type === 'refusal')) throw new ProviderModelError('refusal');
    if (blocks.some(item => !record(item) || ![openai ? 'output_text' : 'text', 'thinking', 'redacted_thinking', ...(!openai && runtime ? [toolType] : [])].includes(item.type))) throw new ProviderModelError('protocol');
    const textBlocks = blocks.filter(item => item.type === (openai ? 'output_text' : 'text'));
    if (textBlocks.some(item => typeof item.text !== 'string')) throw new ProviderModelError('protocol');
    const toolCalls = items.filter(item => item.type === toolType);
    if (!toolCalls.length) {
      if (!openai && value.stop_reason === 'tool_use') throw new ProviderModelError('protocol');
      return parseModelResult(textBlocks.map(item => item.text).join('\n\n'));
    }
    if (!runtime || !openai && value.stop_reason !== 'tool_use') throw new ProviderModelError('protocol');
    if (calls + toolCalls.length > maxCalls) throw new ProviderModelError('tool_access');
    const parsed = toolCalls.map(item => {
      const id = openai ? item.call_id : item.id;
      let args: unknown = item.input;
      if (openai) { try { args = JSON.parse(item.arguments); } catch { throw new ProviderModelError('protocol'); } }
      if (typeof id !== 'string' || !id || id.length > 256 || typeof item.name !== 'string' || !runtime.manifest.tools.some(tool => tool.name === item.name) || !record(args) || Buffer.byteLength(JSON.stringify(args)) > 65536 || seenCallIds.has(id)) throw new ProviderModelError('protocol');
      return { id, name: item.name, args };
    });
    if (new Set(parsed.map(call => call.id)).size !== parsed.length) throw new ProviderModelError('protocol');
    for (const call of parsed) seenCallIds.add(call.id);
    calls += parsed.length;
    if (openai) history.push(...items); else history.push({ role: 'assistant', content: items });
    const results = [];
    for (const call of parsed) {
      const result = await invokeGrantedTool(runtime, call.name, call.args, signal);
      results.push(openai ? { type: 'function_call_output', call_id: call.id, output: JSON.stringify(result) } : { type: 'tool_result', tool_use_id: call.id, content: result.content, ...(result.isError ? { is_error: true } : {}) });
    }
    if (openai) history.push(...results); else history.push({ role: 'user', content: results });
  }
  throw new ProviderModelError('protocol');
}
