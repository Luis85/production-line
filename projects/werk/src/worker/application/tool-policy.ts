import { DomainError } from '../../shared/errors.js';

export interface ToolDefinition { name: string; description: string; inputSchema: Record<string, unknown>; }
/**
 * Chat sessions have no task worktree. `chatDirectory: "repository:<id>"` is an explicit operator opt-in that
 * starts this grant's chat calls in that assigned repository's live checkout; omitted means the private, empty
 * chat workspace. Task invocations always use their pinned task worktree.
 */
export interface ToolChatDirectory { chatDirectory?: string; }
export interface ToolCommandPreset extends ToolChatDirectory { id: string; name: string; executable: string; args: string[]; enabled: boolean; }
export type CommandPreset = ToolCommandPreset;
export interface ToolBuiltinPolicy { files: boolean; commands: ToolCommandPreset[]; webOrigins: string[]; }
export interface ToolMcpConnection extends ToolChatDirectory {
  id: string; name: string; transport: 'stdio' | 'http'; enabled: boolean;
  command: string; args: string[]; url: string; secretEnv: string; secret: string;
  allowedTools: string[]; discoveredTools: ToolDefinition[];
}
export interface ToolPolicy { schemaVersion: 1; revision: number; builtins: ToolBuiltinPolicy; mcp: ToolMcpConnection[]; }
export interface McpConnectionView extends Omit<ToolMcpConnection, 'secret'> { hasSecret: boolean; }
export interface ToolAccessView extends Omit<ToolPolicy, 'mcp'> { mcp: McpConnectionView[]; canEdit: boolean; saveBlockedReason: string | null; }
export interface ToolMcpInput extends Omit<ToolMcpConnection, 'secret' | 'discoveredTools'> { secret?: string; clearSecret?: boolean; }
export interface ToolAccessUpdate { expectedRevision: number; builtins: ToolBuiltinPolicy; mcp: ToolMcpInput[]; }
function invalid(message: string): never { throw new DomainError('invalid_input', message); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function fields(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid(`Use the documented ${label} fields.`);
  return value;
}
function string(value: unknown, label: string, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\x00-\x1f\x7f]/.test(value)) invalid(`Use a valid ${label}.`);
  return value;
}
function boolean(value: unknown, label: string): boolean { if (typeof value !== 'boolean') invalid(`${label} must be true or false.`); return value; }
function id(value: unknown): string { const result = string(value, 'tool configuration ID', 64); if (!/^[a-zA-Z0-9_-]+$/.test(result)) invalid('Tool configuration IDs use letters, digits, underscores and hyphens.'); return result; }
function strings(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) invalid(`Too many ${label}.`);
  return value.map(item => string(item, label, maxLength, true));
}
function absolute(value: unknown, label: string): string {
  const result = string(value, label, 4096);
  // Validate the portable representation here; host-specific executability belongs to the adapter.
  if (!/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(result)) invalid(`${label} must be an absolute path on the worker machine.`);
  return result;
}
function url(value: unknown, originOnly: boolean): string {
  const raw = string(value, originOnly ? 'web origin' : 'MCP address', 2048);
  let parsed: URL; try { parsed = new URL(raw); } catch { return invalid('Use an HTTP(S) address without credentials.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || (originOnly && !['', '/'].includes(parsed.pathname))) invalid('Use an HTTP(S) address without credentials, query or fragment; web grants use origins only.');
  if (!originOnly && parsed.protocol === 'http:' && parsed.hostname !== 'localhost' && parsed.hostname !== '[::1]' && !/^127\.\d+\.\d+\.\d+$/.test(parsed.hostname)) invalid('Remote MCP connections require HTTPS; HTTP is available only for loopback servers.');
  return originOnly ? parsed.origin : parsed.href;
}
const chatRepository = /^repository:([a-zA-Z0-9_-]{1,100})$/;
/** The assigned repository ID a grant's chat calls start in, or undefined for the private chat workspace. */
export function chatRepositoryId(grant: ToolChatDirectory): string | undefined { return grant.chatDirectory === undefined ? undefined : chatRepository.exec(grant.chatDirectory)?.[1]; }
function chatDirectory(value: unknown, label: string): ToolChatDirectory {
  // Omitted keeps the 0.9.0 document shape and the private chat workspace.
  if (value === undefined) return {};
  if (typeof value !== 'string' || !chatRepository.test(value)) invalid(`${label}: chatDirectory must be "repository:<assigned repository ID>". Omit it to keep chat calls in the private chat workspace.`);
  return { chatDirectory: value };
}
/** Save-time check: a chat directory names a repository currently assigned to this worker. Calls check again. */
export function assertChatDirectories(policy: ToolPolicy, assignedRepositoryIds: readonly string[]): void {
  for (const [label, grant] of [...policy.builtins.commands.map(item => [`Command preset "${item.id}"`, item] as const), ...policy.mcp.map(item => [`MCP connection "${item.id}"`, item] as const)]) {
    const repository = chatRepositoryId(grant);
    if (repository !== undefined && !assignedRepositoryIds.includes(repository)) invalid(`${label} runs chat calls in repository "${repository}", which is not assigned to this worker. Choose an assigned repository or the private chat workspace.`);
  }
}
export function defaultToolPolicy(): ToolPolicy { return { schemaVersion: 1, revision: 0, builtins: { files: false, commands: [], webOrigins: [] }, mcp: [] }; }
export function validateToolDefinitions(value: unknown): ToolDefinition[] {
  if (!Array.isArray(value) || value.length > 64) invalid('An MCP connection may expose at most 64 tools.');
  const result = value.map(item => {
    const entry = fields(item, ['name', 'description', 'inputSchema'], 'tool definition');
    const name = string(entry.name, 'tool name', 128);
    if (!/^[a-zA-Z0-9_.:-]+$/.test(name)) invalid('The MCP server returned an unsupported tool name.');
    if (!record(entry.inputSchema) || entry.inputSchema.type !== 'object' || JSON.stringify(entry.inputSchema).length > 16384) invalid('MCP tools need a bounded object input schema.');
    const description = entry.description ?? '';
    if (typeof description !== 'string' || description.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(description)) invalid('Use a bounded, readable tool description.');
    return { name, description, inputSchema: structuredClone(entry.inputSchema) };
  });
  if (new Set(result.map(item => item.name)).size !== result.length) invalid('MCP tool names must be unique.');
  if (JSON.stringify(result).length > 65536) invalid('MCP tool catalog exceeds 64 KiB; configure a smaller server catalog.');
  return result;
}
function builtins(value: unknown): ToolBuiltinPolicy {
  const input = fields(value, ['files', 'commands', 'webOrigins'], 'built-in tool policy');
  if (!Array.isArray(input.commands) || input.commands.length > 16) invalid('Configure at most 16 command presets.');
  const commands = input.commands.map(item => {
    const command = fields(item, ['id', 'name', 'executable', 'args', 'enabled', 'chatDirectory'], 'command preset');
    return { id: id(command.id), name: string(command.name, 'command name', 120), executable: absolute(command.executable, 'Command executable'), args: strings(command.args, 'command arguments', 32, 2048), enabled: boolean(command.enabled, 'Command enabled'), ...chatDirectory(command.chatDirectory, 'Command preset') };
  });
  if (new Set(commands.map(item => item.id)).size !== commands.length) invalid('Command preset IDs must be unique.');
  const webOrigins = strings(input.webOrigins, 'web origins', 16, 2048).map(item => url(item, true));
  if (new Set(webOrigins).size !== webOrigins.length) invalid('Web origins must be unique.');
  return { files: boolean(input.files, 'File access'), commands, webOrigins };
}
function connection(value: unknown): ToolMcpConnection {
  const input = fields(value, ['id', 'name', 'transport', 'enabled', 'command', 'args', 'url', 'secretEnv', 'secret', 'allowedTools', 'discoveredTools', 'chatDirectory'], 'saved MCP connection');
  if (!['stdio', 'http'].includes(String(input.transport))) invalid('Choose stdio or HTTP for the MCP transport.');
  const transport = input.transport as 'stdio' | 'http';
  const command = transport === 'stdio' ? absolute(input.command, 'MCP executable') : string(input.command, 'unused MCP executable', 0, true);
  const args = strings(input.args, 'MCP arguments', 32, 2048);
  if (transport === 'http' && args.length) invalid('HTTP MCP connections do not take command arguments.');
  if (transport === 'http' && input.chatDirectory !== undefined) invalid('HTTP MCP connections have no working directory. Remove chatDirectory.');
  const address = transport === 'http' ? url(input.url, false) : string(input.url, 'unused MCP address', 0, true);
  const secretEnv = transport === 'stdio' ? string(input.secretEnv ?? 'MCP_AUTH_TOKEN', 'secret environment variable', 80) : string(input.secretEnv ?? '', 'unused secret environment variable', 0, true);
  if (secretEnv && (!/^[A-Z_][A-Z0-9_]{0,79}$/.test(secretEnv) || /^(?:PATH|HOME|USERPROFILE|SYSTEMROOT|WINDIR|SHELL|ENV|BASH_ENV|COMSPEC|PATHEXT|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|RUBYOPT|RUBYLIB|PERL5OPT|PERL5LIB|LD_.*|DYLD_.*|WERK_.*|CODEX_.*|CLAUDE_.*)$/.test(secretEnv))) invalid('Choose a dedicated MCP credential environment variable, not a process or worker configuration variable.');
  const discoveredTools = validateToolDefinitions(input.discoveredTools);
  const allowedTools = strings(input.allowedTools, 'granted tool names', 64, 128);
  if (new Set(allowedTools).size !== allowedTools.length || allowedTools.some(name => !discoveredTools.some(tool => tool.name === name))) invalid('Grant only tools from the current discovered MCP catalog.');
  return { id: id(input.id), name: string(input.name, 'connection name', 120), transport, enabled: boolean(input.enabled, 'MCP enabled'), command, args, url: address, secretEnv, secret: string(input.secret, 'MCP secret', 4096, true), allowedTools, discoveredTools, ...chatDirectory(input.chatDirectory, 'MCP connection') };
}
export function validateToolPolicy(value: unknown): ToolPolicy {
  const input = fields(value, ['schemaVersion', 'revision', 'builtins', 'mcp'], 'tool policy');
  if (input.schemaVersion !== 1 || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0 || Number(input.revision) >= Number.MAX_SAFE_INTEGER || !Array.isArray(input.mcp) || input.mcp.length > 8) invalid('Invalid saved tool policy.');
  const mcp = input.mcp.map(connection);
  if (new Set(mcp.map(item => item.id)).size !== mcp.length) invalid('MCP connection IDs must be unique.');
  const builtinPolicy = builtins(input.builtins);
  const granted = mcp.filter(item => item.enabled).flatMap(item => item.discoveredTools.filter(tool => item.allowedTools.includes(tool.name)));
  const count = granted.length + (builtinPolicy.files ? 3 : 0) + (builtinPolicy.commands.some(item => item.enabled) ? 1 : 0) + (builtinPolicy.webOrigins.length ? 1 : 0);
  if (count > 64) invalid('Enable at most 64 model tools across built-ins and MCP connections.');
  if (JSON.stringify(granted).length > 98304) invalid('Granted MCP descriptions and schemas exceed 96 KiB. Enable fewer tools.');
  return { schemaVersion: 1, revision: Number(input.revision), builtins: builtinPolicy, mcp };
}
const destination = (item: Pick<ToolMcpConnection, 'transport' | 'command' | 'args' | 'url' | 'secretEnv'>) => JSON.stringify([item.transport, item.command, item.args, item.url, item.secretEnv]);
/** `assignedRepositoryIds` are the worker's current repository assignments; chat directories must name one of them. */
export function updateToolPolicy(previous: ToolPolicy, value: unknown, assignedRepositoryIds: readonly string[] = []): ToolPolicy {
  const input = fields(value, ['expectedRevision', 'builtins', 'mcp'], 'tool access update');
  if (input.expectedRevision !== previous.revision) throw new DomainError('conflict', 'Tool access changed. Reload the saved policy before applying your changes.');
  if (!Array.isArray(input.mcp) || input.mcp.length > 8) invalid('Configure at most eight MCP connections.');
  const mcp = input.mcp.map(raw => {
    const entry = fields(raw, ['id', 'name', 'transport', 'enabled', 'command', 'args', 'url', 'secretEnv', 'secret', 'clearSecret', 'allowedTools', 'chatDirectory'], 'MCP connection');
    if (entry.clearSecret !== undefined && typeof entry.clearSecret !== 'boolean') invalid('Clear secret must be true or false.');
    if (entry.secret !== undefined && typeof entry.secret !== 'string') invalid('MCP secret must be a string.');
    if (entry.clearSecret === true && entry.secret) invalid('Choose replacing or clearing the MCP secret.');
    const saved = previous.mcp.find(item => item.id === entry.id);
    const normalizedDestination = { ...entry, url: entry.transport === 'http' ? url(entry.url, false) : entry.url, secretEnv: entry.secretEnv ?? (entry.transport === 'stdio' ? 'MCP_AUTH_TOKEN' : '') } as unknown as ToolMcpConnection;
    const same = saved && destination(saved) === destination(normalizedDestination);
    const { clearSecret, ...rest } = entry;
    const secret = clearSecret === true ? '' : entry.secret !== undefined && entry.secret !== '' ? entry.secret : same ? saved.secret : '';
    return connection({ ...rest, secret, allowedTools: same ? entry.allowedTools : [], discoveredTools: same ? saved.discoveredTools : [] });
  });
  const next = validateToolPolicy({ schemaVersion: 1, revision: previous.revision + 1, builtins: input.builtins, mcp });
  assertChatDirectories(next, assignedRepositoryIds);
  return next;
}
export function discoveredToolPolicy(previous: ToolPolicy, connectionId: string, expectedRevision: number, definitions: unknown): ToolPolicy {
  if (expectedRevision !== previous.revision) throw new DomainError('conflict', 'Tool access changed while discovering tools. Reload and retry.');
  const tools = validateToolDefinitions(definitions);
  const next = structuredClone(previous), target = next.mcp.find(item => item.id === connectionId);
  if (!target) throw new DomainError('not_found', 'MCP connection not found.');
  // A changed schema or description requires an explicit new grant, even when its name survives.
  target.allowedTools = target.allowedTools.filter(name => JSON.stringify(target.discoveredTools.find(tool => tool.name === name)) === JSON.stringify(tools.find(tool => tool.name === name)));
  target.discoveredTools = tools; next.revision++; return validateToolPolicy(next);
}
export function publicToolPolicy(policy: ToolPolicy): Omit<ToolAccessView, 'canEdit' | 'saveBlockedReason'> {
  return { ...structuredClone(policy), mcp: policy.mcp.map(({ secret, ...item }) => ({ ...structuredClone(item), hasSecret: !!secret })) };
}
