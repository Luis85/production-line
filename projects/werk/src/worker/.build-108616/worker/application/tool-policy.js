import { validateDelegationPolicy,                       } from './delegation-policy.js';
import { callTimeout, toolTimeLimits } from './tool-limits.js';
import { validateMcpAddress } from './mcp-endpoint.js';
import { DomainError } from '../../shared/errors.js';
import { cliToolDescription, cliToolInputSchema, cliToolLimits, validateCliTool,                  } from './cli-tool-policy.js';
                                                                        

                                                                                                            
/**
 * Chat sessions have no task worktree. `chatDirectory: "repository:<id>"` is an explicit operator opt-in that
 * starts this grant's chat calls in that assigned repository's live checkout; omitted means the private, empty
 * chat workspace. Task invocations always use their pinned task worktree.
 */
                                                              
                                                                                                                                                                                                                                                                                                                                                                              
                                              
                                                                                                                                    
                                                              
                                                                          
                                                                                  
                                                            
                                                                                                   
 
                                                                                                                                                         
                                                                                                    
/** `workerNode` is the Node.js executable running this worker, offered as a CLI tool interpreter. */
                                                                                                                                                                     
                                                                                                                                                                                
                                                                                                    
                                                                                          
                                                                                                                                                      
/** Omitted grants preserve saved access; explicit null only clears per-tool timeout overrides. */
                                                                                                                                               
function invalid(message        )        { throw new DomainError('invalid_input', message); }
const record = (value         )                                   => !!value && typeof value === 'object' && !Array.isArray(value);
function fields(value         , allowed          , label        )                          {
  if (!record(value)) invalid(`Use the documented ${label} fields.`);
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
  if (unexpected.length) invalid(`Use the documented ${label} fields. Unexpected: ${unexpected.slice(0, 5).map(key => key.length > 64 ? `${key.slice(0, 64)}…` : key).join(', ')}${unexpected.length > 5 ? ', …' : ''}.`);
  return value;
}
function string(value         , label        , max        , empty = false)         {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\x00-\x1f\x7f]/.test(value)) invalid(`Use a valid ${label}.`);
  return value;
}
function boolean(value         , label        )          { if (typeof value !== 'boolean') invalid(`${label} must be true or false.`); return value; }
function id(value         )         { const result = string(value, 'tool configuration ID', 64); if (!/^[a-zA-Z0-9_-]+$/.test(result)) invalid('Tool configuration IDs use letters, digits, underscores and hyphens.'); return result; }
function strings(value         , label        , maxItems        , maxLength        )           {
  if (!Array.isArray(value) || value.length > maxItems) invalid(`Too many ${label}.`);
  return value.map(item => string(item, label, maxLength, true));
}
function absolute(value         , label        )         {
  const result = string(value, label, 4096);
  // Validate the portable representation here; host-specific executability belongs to the adapter.
  if (!/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(result)) invalid(`${label} must be an absolute path on the worker machine.`);
  return result;
}
function url(value         , originOnly         )         {
  const raw = string(value, originOnly ? 'web origin' : 'MCP address', 2048);
  if (!originOnly) return validateMcpAddress(raw).href;
  let parsed     ; try { parsed = new URL(raw); } catch { return invalid('Use an HTTP(S) address without credentials.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) invalid('Use an HTTP(S) address without credentials, query or fragment; web grants use origins only.');
  return parsed.origin;
}
const chatRepository = /^repository:([a-zA-Z0-9_-]{1,100})$/;
/** The assigned repository ID a grant's chat calls start in, or undefined for the private chat workspace. */
export function chatRepositoryId(grant                   )                     { return grant.chatDirectory === undefined ? undefined : chatRepository.exec(grant.chatDirectory)?.[1]; }
function chatDirectory(value         , label        )                    {
  // Omitted keeps the 0.9.0 document shape and the private chat workspace.
  if (value === undefined) return {};
  if (typeof value !== 'string' || !chatRepository.test(value)) invalid(`${label}: chatDirectory must be "repository:<assigned repository ID>". Omit it to keep chat calls in the private chat workspace.`);
  return { chatDirectory: value };
}
/** Save-time check: a chat directory names a repository currently assigned to this worker. Calls check again. */
export function assertChatDirectories(policy            , assignedRepositoryIds                   )       {
  for (const [label, grant] of [...policy.builtins.commands.map(item => [`Command preset "${item.id}"`, item]         ), ...policy.mcp.map(item => [`MCP connection "${item.id}"`, item]         )]) {
    const repository = chatRepositoryId(grant);
    if (repository !== undefined && !assignedRepositoryIds.includes(repository)) invalid(`${label} runs chat calls in repository "${repository}", which is not assigned to this worker. Choose an assigned repository or the private chat workspace.`);
  }
}
export function defaultToolPolicy()             { return { schemaVersion: 1, revision: 0, builtins: { files: false, commands: [], cliTools: [], webOrigins: [] }, mcp: [] }; }
export function validateToolDefinitions(value         )                   {
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
function withSavedTimeout(value         , previous                         )          {
  if (!record(value)) return value;
  const { timeoutMs, ...rest } = value;
  const effective = timeoutMs === undefined ? previous?.timeoutMs : timeoutMs === null ? undefined : timeoutMs;
  return { ...rest, ...(effective === undefined ? {} : { timeoutMs: effective }) };
}
function builtins(value         , previous                    )                    {
  const input = fields(value, ['files', 'commands', 'cliTools', 'webOrigins'], 'built-in tool policy');
  if (!Array.isArray(input.commands) || input.commands.length > 16) invalid('Configure at most 16 command presets.');
  const commands = input.commands.map(item => {
    const command = fields(previous ? withSavedTimeout(item, previous.commands.find(saved => record(item) && saved.id === item.id)) : item, ['id', 'name', 'executable', 'args', 'enabled', 'verification', 'timeoutMs', 'chatDirectory'], 'command preset');
    const timeoutMs = callTimeout(command.timeoutMs, 'Command preset');
    return { id: id(command.id), name: string(command.name, 'command name', 120), executable: absolute(command.executable, 'Command executable'), args: strings(command.args, 'command arguments', 32, 2048), enabled: boolean(command.enabled, 'Command enabled'), ...(command.verification === undefined || boolean(command.verification, 'Required feature check') === false ? {} : { verification: true }), ...chatDirectory(command.chatDirectory, 'Command preset'), ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  });
  if (new Set(commands.map(item => item.id)).size !== commands.length) invalid('Command preset IDs must be unique.');
  // Documents saved before CLI tools existed omit the list; absence grants nothing.
  if (input.cliTools !== undefined && (!Array.isArray(input.cliTools) || input.cliTools.length > cliToolLimits.tools)) invalid(`Configure at most ${cliToolLimits.tools} CLI tools.`);
  const cliTools = ((input.cliTools ?? [])             ).map(item => validateCliTool(previous ? withSavedTimeout(item, previous.cliTools.find(saved => record(item) && saved.id === item.id)) : item, absolute));
  if (new Set(cliTools.map(item => item.id)).size !== cliTools.length) invalid('CLI tool IDs must be unique.');
  const webOrigins = strings(input.webOrigins, 'web origins', 16, 2048).map(item => url(item, true));
  if (new Set(webOrigins).size !== webOrigins.length) invalid('Web origins must be unique.');
  return { files: boolean(input.files, 'File access'), commands, cliTools, webOrigins };
}
function connection(value         )                    {
  const input = fields(value, ['id', 'name', 'transport', 'enabled', 'command', 'args', 'url', 'secretEnv', 'secret', 'allowedTools', 'discoveredTools', 'timeoutMs', 'chatDirectory'], 'saved MCP connection');
  if (!['stdio', 'http'].includes(String(input.transport))) invalid('Choose stdio or HTTP for the MCP transport.');
  const transport = input.transport                    ;
  const command = transport === 'stdio' ? absolute(input.command, 'MCP executable') : string(input.command, 'unused MCP executable', 0, true);
  const args = strings(input.args, 'MCP arguments', 32, 2048);
  if (transport === 'http' && args.length) invalid('HTTP MCP connections do not take command arguments.');
  if (transport === 'http' && input.chatDirectory !== undefined) invalid('HTTP MCP connections have no working directory. Remove chatDirectory.');
  const address = transport === 'http' ? url(input.url, false) : string(input.url, 'unused MCP address', 0, true);
  // A local server without a credential needs no variable; a stored secret always needs its dedicated destination.
  const secretEnv = transport === 'stdio' ? string(input.secretEnv ?? 'MCP_AUTH_TOKEN', 'secret environment variable', 80, true) : string(input.secretEnv ?? '', 'unused secret environment variable', 0, true);
  if (secretEnv && (!/^[A-Z_][A-Z0-9_]{0,79}$/.test(secretEnv) || /^(?:PATH|HOME|USERPROFILE|SYSTEMROOT|WINDIR|SHELL|ENV|BASH_ENV|COMSPEC|PATHEXT|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|RUBYOPT|RUBYLIB|PERL5OPT|PERL5LIB|LD_.*|DYLD_.*|WERK_.*|CODEX_.*|CLAUDE_.*)$/.test(secretEnv))) invalid('Choose a dedicated MCP credential environment variable, not a process or worker configuration variable.');
  if (transport === 'stdio' && !secretEnv && string(input.secret, 'MCP secret', 4096, true)) invalid('Name the environment variable that receives the MCP secret, or remove the secret.');
  const discoveredTools = validateToolDefinitions(input.discoveredTools);
  const allowedTools = strings(input.allowedTools, 'granted tool names', 64, 128);
  if (new Set(allowedTools).size !== allowedTools.length || allowedTools.some(name => !discoveredTools.some(tool => tool.name === name))) invalid('Grant only tools from the current discovered MCP catalog.');
  const timeoutMs = callTimeout(input.timeoutMs, 'MCP connection', transport === 'http' ? toolTimeLimits.httpMcpMaxMs : toolTimeLimits.mcpMaxMs);
  return { id: id(input.id), name: string(input.name, 'connection name', 120), transport, enabled: boolean(input.enabled, 'MCP enabled'), command, args, url: address, secretEnv, secret: string(input.secret, 'MCP secret', 4096, true), allowedTools, discoveredTools, ...chatDirectory(input.chatDirectory, 'MCP connection'), ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}
export function validateToolPolicy(value         )             {
  const input = fields(value, ['schemaVersion', 'revision', 'builtins', 'mcp', 'delegation'], 'tool policy');
  if (input.schemaVersion !== 1 || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0 || Number(input.revision) >= Number.MAX_SAFE_INTEGER || !Array.isArray(input.mcp) || input.mcp.length > 8) invalid('Invalid saved tool policy.');
  const mcp = input.mcp.map(connection);
  if (new Set(mcp.map(item => item.id)).size !== mcp.length) invalid('MCP connection IDs must be unique.');
  const builtinPolicy = builtins(input.builtins);
  const delegation = input.delegation === undefined ? undefined : validateDelegationPolicy(input.delegation);
  const granted = mcp.filter(item => item.enabled).flatMap(item => item.discoveredTools.filter(tool => item.allowedTools.includes(tool.name)));
  const count = (delegation?.enabled ? 1 : 0) + granted.length + (builtinPolicy.files ? 3 + (builtinPolicy.commands.some(item => item.enabled && item.verification) ? 3 : 0) : 0) + (builtinPolicy.commands.some(item => item.enabled) ? 1 : 0) + builtinPolicy.cliTools.filter(item => item.enabled).length + (builtinPolicy.webOrigins.length ? 1 : 0);
  if (count > 64) invalid('Enable at most 64 model tools across built-ins and MCP connections.');
  const cliDefinitions = builtinPolicy.cliTools.filter(item => item.enabled).map(item => ({ description: cliToolDescription(item), inputSchema: cliToolInputSchema(item) }));
  if (JSON.stringify(granted).length + JSON.stringify(cliDefinitions).length > 98304) invalid('Granted MCP and CLI tool descriptions and schemas exceed 96 KiB. Enable fewer tools or shorten their descriptions.');
  return { schemaVersion: 1, revision: Number(input.revision), builtins: builtinPolicy, mcp, ...(delegation === undefined ? {} : { delegation }) };
}
const destination = (item                                                                                 ) => JSON.stringify([item.transport, item.command, item.args, item.url, item.secretEnv]);
/** `assignedRepositoryIds` are the worker's current repository assignments; chat directories must name one of them. */
export function updateToolPolicy(previous            , value         , assignedRepositoryIds                    = [])             {
  const input = fields(value, ['expectedRevision', 'builtins', 'mcp', 'delegation'], 'tool access update');
  if (input.expectedRevision !== previous.revision) throw new DomainError('conflict', 'Tool access changed. Reload the saved policy before applying your changes.');
  if (!Array.isArray(input.mcp) || input.mcp.length > 8) invalid('Configure at most eight MCP connections.');
  const mcp = input.mcp.map(raw => {
    const entry = fields(raw, ['id', 'name', 'transport', 'enabled', 'command', 'args', 'url', 'secretEnv', 'secret', 'clearSecret', 'allowedTools', 'timeoutMs', 'chatDirectory'], 'MCP connection');
    if (entry.clearSecret !== undefined && typeof entry.clearSecret !== 'boolean') invalid('Clear secret must be true or false.');
    if (entry.secret !== undefined && typeof entry.secret !== 'string') invalid('MCP secret must be a string.');
    if (entry.clearSecret === true && entry.secret) invalid('Choose replacing or clearing the MCP secret.');
    const saved = previous.mcp.find(item => item.id === entry.id);
    const normalizedDestination = { ...entry, url: entry.transport === 'http' ? url(entry.url, false) : entry.url, secretEnv: entry.secretEnv ?? (entry.transport === 'stdio' ? 'MCP_AUTH_TOKEN' : '') }                                ;
    const same = saved && destination(saved) === destination(normalizedDestination);
    const sameCatalog = same && saved.chatDirectory === entry.chatDirectory;
    const { clearSecret, ...rest } = entry;
    const secret = clearSecret === true ? '' : entry.secret !== undefined && entry.secret !== '' ? entry.secret : same ? saved.secret : '';
    return connection(withSavedTimeout({ ...rest, secret, allowedTools: sameCatalog ? entry.allowedTools : [], discoveredTools: sameCatalog ? saved.discoveredTools : [] }, saved));
  });
  const delegation = input.delegation === undefined ? previous.delegation : input.delegation;
  const next = validateToolPolicy({ schemaVersion: 1, revision: previous.revision + 1, builtins: builtins(input.builtins, previous.builtins), mcp, ...(delegation === undefined ? {} : { delegation }) });
  assertChatDirectories(next, assignedRepositoryIds);
  return next;
}
export function discoveredToolPolicy(previous            , connectionId        , expectedRevision        , definitions         )             {
  if (expectedRevision !== previous.revision) throw new DomainError('conflict', 'Tool access changed while discovering tools. Reload and retry.');
  const tools = validateToolDefinitions(definitions);
  const next = structuredClone(previous), target = next.mcp.find(item => item.id === connectionId);
  if (!target) throw new DomainError('not_found', 'MCP connection not found.');
  // A changed schema or description requires an explicit new grant, even when its name survives.
  target.allowedTools = target.allowedTools.filter(name => JSON.stringify(target.discoveredTools.find(tool => tool.name === name)) === JSON.stringify(tools.find(tool => tool.name === name)));
  target.discoveredTools = tools; next.revision++; return validateToolPolicy(next);
}
/** Only absent overrides are omitted. An explicit value remains a cap when global settings later change. */
export function persistedToolPolicy(policy            )                          {
  const copy = structuredClone(policy);
  const { cliTools, ...builtins } = copy.builtins;
  return cliTools.length ? { ...copy } : { ...copy, builtins };
}
export function publicToolPolicy(policy            )                                                                       {
  return { ...structuredClone(policy), mcp: policy.mcp.map(({ secret, ...item }) => ({ ...structuredClone(item), hasSecret: !!secret })) };
}
