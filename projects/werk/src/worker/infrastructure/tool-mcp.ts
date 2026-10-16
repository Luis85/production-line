import type { ToolDefinition, ToolMcpConnection } from '../application/tool-policy.js';
import { openMcpHttp, validateMcpEndpoint } from './tool-mcp-http.js';
import { openMcpStdio } from './tool-mcp-stdio.js';
import { MCP_PROTOCOL_VERSIONS, MCP_REQUEST_LIMIT, McpClientError, plainObject, type McpClientOptions, type McpSession, type McpTransportConfiguration } from './tool-mcp-protocol.js';
export { McpClientError } from './tool-mcp-protocol.js';
export type { McpClientOptions, McpClientDependencies, McpTransportConfiguration } from './tool-mcp-protocol.js';
export type McpToolDefinition = ToolDefinition;
export interface McpToolResult { content: { type: 'text'; text: string }[]; isError?: boolean; }

export function mcpTransportConfiguration(connection: ToolMcpConnection): McpTransportConfiguration {
  return connection.transport === 'stdio'
    ? { transport: 'stdio', executable: connection.command, args: [...connection.args], env: connection.secret ? { [connection.secretEnv || 'MCP_AUTH_TOKEN']: connection.secret } : {} }
    : { transport: 'http', url: connection.url, headers: connection.secret ? { Authorization: `Bearer ${connection.secret}` } : {} };
}
function validateConfiguration(config: McpTransportConfiguration): void {
  if (config.transport === 'http') {
    validateMcpEndpoint(config.url);
    if (!plainObject(config.headers) || Object.keys(config.headers).some(key => key.toLowerCase() !== 'authorization') || Object.values(config.headers).some(value => typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/.test(value))) throw new McpClientError('configuration');
  } else if (config.transport === 'stdio') {
    if (typeof config.executable !== 'string' || !config.executable.trim() || config.executable.length > 4096 || /[\r\n\0]/.test(config.executable) || !Array.isArray(config.args) || config.args.length > 64 || config.args.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0')) || !plainObject(config.env) || Object.entries(config.env).some(([key, value]) => !/^[A-Z_][A-Z0-9_]{0,79}$/.test(key) || /^(?:PATH|HOME|USERPROFILE|SHELL|ENV|BASH_ENV|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|RUBYOPT|RUBYLIB|PERL5OPT|PERL5LIB|LD_.*|DYLD_.*|WERK_.*|CODEX_.*|CLAUDE_.*)$/.test(key) || typeof value !== 'string' || value.length > 8192 || value.includes('\0'))) throw new McpClientError('configuration');
  } else throw new McpClientError('configuration');
}
function safeData(value: unknown, config: McpTransportConfiguration, depth = 0): unknown {
  if (depth > 32) throw new McpClientError('protocol');
  const secrets = Object.values(config.transport === 'http' ? config.headers : config.env).flatMap(secret => secret.startsWith('Bearer ') ? [secret, secret.slice(7)] : [secret]).filter(Boolean);
  const redact = (text: string) => secrets.reduce((result, secret) => result.split(secret).join('[REDACTED]'), text);
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => safeData(item, config, depth + 1));
  if (plainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), safeData(item, config, depth + 1)]));
  return value;
}
function definition(value: unknown): ToolDefinition {
  if (!plainObject(value) || typeof value.name !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.name) || (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 4000)) || !plainObject(value.inputSchema) || value.inputSchema.type !== 'object') throw new McpClientError('protocol');
  if (Buffer.byteLength(JSON.stringify(value.inputSchema)) > 16 * 1024) throw new McpClientError('output_limit');
  return { name: value.name, description: typeof value.description === 'string' ? value.description : '', inputSchema: value.inputSchema };
}
async function listTools(session: McpSession): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = [], names = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 16; page++) {
    const result = await session.request('tools/list', cursor ? { cursor } : {});
    if (!plainObject(result) || !Array.isArray(result.tools)) throw new McpClientError('protocol');
    for (const value of result.tools) {
      const tool = definition(value);
      if (names.has(tool.name)) throw new McpClientError('protocol');
      names.add(tool.name); tools.push(tool);
      if (tools.length > 64 || Buffer.byteLength(JSON.stringify(tools)) > 64 * 1024) throw new McpClientError('output_limit');
    }
    if (result.nextCursor === undefined) return tools;
    if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 2048 || cursors.has(result.nextCursor)) throw new McpClientError('protocol');
    cursor = result.nextCursor; cursors.add(cursor);
  }
  throw new McpClientError('output_limit');
}
async function withSession<T>(config: McpTransportConfiguration, options: McpClientOptions, defaultTimeout: number, operation: (session: McpSession) => Promise<T>): Promise<T> {
  validateConfiguration(config);
  const timeout = options.timeoutMs ?? defaultTimeout;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000) throw new McpClientError('configuration');
  const controller = new AbortController();
  const cancel = () => controller.abort(new McpClientError('cancelled'));
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new McpClientError('timeout')), timeout); timer.unref();
  let session: McpSession | undefined;
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    session = config.transport === 'stdio' ? openMcpStdio(config, options, controller.signal) : openMcpHttp(config, options, controller.signal);
    const initialized = await session.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: 'werk-worker', version: '1' } });
    if (!plainObject(initialized) || typeof initialized.protocolVersion !== 'string' || !MCP_PROTOCOL_VERSIONS.includes(initialized.protocolVersion) || !plainObject(initialized.capabilities) || !plainObject(initialized.capabilities.tools) || !plainObject(initialized.serverInfo) || typeof initialized.serverInfo.name !== 'string' || typeof initialized.serverInfo.version !== 'string') throw new McpClientError('protocol');
    session.protocolVersion = initialized.protocolVersion;
    await session.notify('notifications/initialized');
    const result = await operation(session);
    if (controller.signal.aborted) throw controller.signal.reason;
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error instanceof McpClientError ? error : new McpClientError('unavailable');
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', cancel);
    await session?.close();
  }
}
/** Connection inspection lists available tools; callers persist grants separately. */
export async function discoverMcpTools(config: McpTransportConfiguration, options: McpClientOptions = {}): Promise<ToolDefinition[]> {
  return withSession(config, options, 10000, async session => safeData(await listTools(session), config) as ToolDefinition[]);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (plainObject(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function toolResult(value: unknown, config: McpTransportConfiguration): McpToolResult {
  if (!plainObject(value) || !Array.isArray(value.content) || (value.isError !== undefined && typeof value.isError !== 'boolean') || (value.structuredContent !== undefined && !plainObject(value.structuredContent))) throw new McpClientError('protocol');
  const content = value.content.map(block => {
    if (!plainObject(block) || typeof block.type !== 'string') throw new McpClientError('protocol');
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw new McpClientError('protocol');
      return { type: 'text' as const, text: safeData(block.text, config) as string };
    }
    // Providers receive external content as data, never an implicit resource/network request.
    const valid = (block.type === 'image' || block.type === 'audio') ? typeof block.data === 'string' && typeof block.mimeType === 'string'
      : block.type === 'resource_link' ? typeof block.uri === 'string' && typeof block.name === 'string'
      : block.type === 'resource' ? plainObject(block.resource) && typeof block.resource.uri === 'string' && (typeof block.resource.text === 'string' || typeof block.resource.blob === 'string') : false;
    if (!valid) throw new McpClientError('protocol');
    return { type: 'text' as const, text: JSON.stringify(safeData(block, config)) };
  });
  if (value.structuredContent !== undefined) content.push({ type: 'text', text: JSON.stringify(safeData(value.structuredContent, config)) });
  const result: McpToolResult = { content, ...(value.isError === undefined ? {} : { isError: value.isError }) };
  if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) throw new McpClientError('output_limit');
  return result;
}
/** No retry: a timed-out external operation may already have changed its remote system. */
export async function callMcpTool(config: McpTransportConfiguration, name: string, args: unknown, grantedDefinitions: ToolDefinition[], options: McpClientOptions = {}): Promise<McpToolResult> {
  const granted = grantedDefinitions.find(tool => tool.name === name);
  if (!granted) throw new McpClientError('denied');
  if (!plainObject(args)) throw new McpClientError('protocol');
  try { if (Buffer.byteLength(JSON.stringify(args)) > MCP_REQUEST_LIMIT - 1024) throw new McpClientError('output_limit'); }
  catch (error) { throw error instanceof McpClientError ? error : new McpClientError('protocol'); }
  return withSession(config, options, 30000, async session => {
    const actual = (await listTools(session)).find(tool => tool.name === name);
    if (!actual || canonical(actual.inputSchema) !== canonical(granted.inputSchema)) throw new McpClientError('changed');
    return toolResult(await session.request('tools/call', { name, arguments: args }), config);
  });
}
