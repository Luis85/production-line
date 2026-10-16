import { computed, reactive, watch } from 'vue';
import type { ToolAccessView, ToolAccessUpdate, McpConnectionView, CliCommandRule, ToolCliTool } from '../application/tool-policy';

/** Timeouts and the tool window are edited in whole seconds and sent as milliseconds. */
export interface CommandDraft { id: string; name: string; executable: string; arguments: string; enabled: boolean; timeoutSeconds: number; }
/** Rules are edited one per line, for example `backlog set requires --dry-run` or `eol refuses --fix`. */
export interface CliToolDraft { id: string; name: string; description: string; executable: string; arguments: string; commands: string; refusedOptions: string; maxArgs: number; maxArgLength: number; outputKiB: number; truncationHint: string; enabled: boolean; timeoutSeconds: number; }
export interface McpDraft { id: string; name: string; transport: 'stdio' | 'http'; enabled: boolean; command: string; arguments: string; url: string; secretEnv: string; secret: string; clearSecret: boolean; allowedTools: string[]; timeoutSeconds: number; }
/** Mirrors toolTimeLimits in application/tool-limits.ts, which the worker enforces on save. */
export const toolLimitSeconds = Object.freeze({ callDefault: 30, callMax: 900, httpMcpMax: 300, windowDefault: 120, windowMin: 10, windowMax: 86400 });
const seconds = (ms: number | undefined, fallback: number) => ms === undefined ? fallback : Math.round(ms / 1000);
interface EditorPorts {
  view: () => ToolAccessView | null;
  unlocked: () => boolean;
  epoch: () => number;
  write: (command: ToolAccessUpdate) => Promise<ToolAccessView | undefined>;
  discover: (command: { id: string; expectedRevision: number }) => Promise<ToolAccessView | undefined>;
  refresh: () => Promise<unknown>;
  /** The worker's invocation runtime budget; the tool window cannot outlast it. */
  executionBudgetMs?: () => number | undefined;
}
const lines = (value: string) => value.split('\n').map(item => item.trim()).filter(Boolean);
const json = (value: unknown) => JSON.stringify(value);
function argumentsOf(value: string): string[] { const result: unknown = JSON.parse(value); if (!Array.isArray(result) || !result.every(item => typeof item === 'string')) throw Error('Arguments must be a JSON array of strings.'); return result; }
const absolute = (value: string) => /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(value);
function canonicalUrl(value: string): string { try { return new URL(value).href; } catch { return value.trim(); } }
const words = (value: string) => value.split(/[\s,]+/).filter(Boolean);
const optionName = /^-{1,2}[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
export function formatCliRules(rules: CliCommandRule[]): string {
  return rules.map(rule => [rule.command, ...(rule.requireOneOf.length ? ['requires', ...rule.requireOneOf] : []), ...(rule.refusedOptions.length ? ['refuses', ...rule.refusedOptions] : [])].join(' ')).join('\n');
}
/** Parse the line format; throws a message that names the offending line. */
export function parseCliRules(value: string): CliCommandRule[] {
  return lines(value).map(line => {
    const rule: CliCommandRule = { command: '', requireOneOf: [], refusedOptions: [] }, command: string[] = [];
    let target: string[] | null = null;
    for (const token of words(line)) {
      if (token === 'requires') target = rule.requireOneOf;
      else if (token === 'refuses') target = rule.refusedOptions;
      else if (target) { if (!optionName.test(token)) throw Error(`"${line}": list options such as --dry-run after requires or refuses.`); target.push(token); }
      else command.push(token);
    }
    if (command.length < 1 || command.length > 2) throw Error(`"${line}": start each line with a command of one or two words.`);
    rule.command = command.join(' ');
    return rule;
  });
}
const cliDraft = (item: ToolCliTool): CliToolDraft => ({ id: item.id, name: item.name, description: item.description, executable: item.executable, arguments: json(item.args), commands: formatCliRules(item.commands), refusedOptions: item.refusedOptions.join(' '), maxArgs: item.maxArgs, maxArgLength: item.maxArgLength, outputKiB: item.outputKiB, truncationHint: item.truncationHint, enabled: item.enabled, timeoutSeconds: seconds(item.timeoutMs, toolLimitSeconds.callDefault) });
const destination = (value: { transport: string; command: string; args?: string[]; arguments?: string; url: string; secretEnv?: string }) => json(value.transport === 'http' ? ['http', canonicalUrl(value.url)] : ['stdio', value.command.trim(), value.args ?? value.arguments, value.secretEnv ?? '']);

/** Tool grants stay drafts until the paused, drained worker acknowledges a revision. */
export function createToolAccessEditor(ports: EditorPorts) {
  const draft = reactive({ windowSeconds: toolLimitSeconds.windowDefault as number, files: false, commands: [] as CommandDraft[], cliTools: [] as CliToolDraft[], webOrigins: '', mcp: [] as McpDraft[], revision: -1, baseline: '', busy: false, discovering: '', checking: false, error: '', notice: '', uncertain: null as ToolAccessUpdate | null });
  const values = () => ({ windowSeconds: draft.windowSeconds, files: draft.files, commands: draft.commands, cliTools: draft.cliTools, webOrigins: draft.webOrigins, mcp: draft.mcp });
  const dirty = computed(() => json(values()) !== draft.baseline);
  const stale = computed(() => draft.revision >= 0 && !!ports.view() && draft.revision !== ports.view()!.revision);
  const locked = computed(() => !ports.unlocked() || draft.busy || draft.checking || !!draft.uncertain);
  const validation = computed(() => {
    for (const group of [draft.commands, draft.cliTools, draft.mcp]) {
      const ids = new Set<string>();
      for (const item of group) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(item.id)) return 'Use 1–64 letters, numbers, underscores or hyphens for each ID.';
      if (ids.has(item.id)) return 'Give each command, CLI tool and MCP connection a different ID.';
      ids.add(item.id);
      if (!item.name.trim()) return 'Give each command, CLI tool and MCP connection a name.';
      }
    }
    if (draft.commands.length > 16 || draft.cliTools.length > 8 || draft.mcp.length > 8) return 'Use up to 16 command presets, eight CLI tools and eight MCP connections.';
    for (const tool of draft.cliTools) {
      const label = tool.name || tool.id;
      if (tool.id.length > 48) return 'Use at most 48 characters for each CLI tool ID.';
      if (!absolute(tool.executable.trim())) return `Enter an absolute executable path for CLI tool ${label}.`;
      if (/\.(?:bat|cmd)$/i.test(tool.executable.trim())) return 'CLI tools cannot run .bat or .cmd files. Use an interpreter such as node.exe and pass the script as a fixed argument.';
      let rules: CliCommandRule[]; try { rules = parseCliRules(tool.commands); } catch (failure) { return `${label}: ${(failure as Error).message}`; }
      if (!rules.length) return `Allow at least one command for CLI tool ${label}.`;
      if (new Set(rules.map(rule => rule.command)).size !== rules.length) return `List each command once for CLI tool ${label}.`;
      if (words(tool.refusedOptions).some(option => !optionName.test(option))) return `Refused options for ${label} are option names such as --root, separated by spaces.`;
      for (const [value, min, max, limit] of [[tool.maxArgs, 1, 64, 'maximum arguments (1–64)'], [tool.maxArgLength, 1, 2048, 'maximum argument length (1–2,048)'], [tool.outputKiB, 1, 64, 'output limit (1–64 KiB)']] as const)
        if (!Number.isSafeInteger(value) || value < min || value > max) return `Use a whole number for the ${limit} of ${label}.`;
    }
    for (const command of draft.commands) if (!absolute(command.executable.trim())) return 'Enter an absolute executable path for every command preset.';
    const window = draft.windowSeconds;
    if (!Number.isSafeInteger(window) || window < toolLimitSeconds.windowMin || window > toolLimitSeconds.windowMax) return `Use a whole number of seconds from ${toolLimitSeconds.windowMin} to ${toolLimitSeconds.windowMax.toLocaleString('en-US')} for the tool window.`;
    for (const [items, kind] of [[draft.commands, 'command preset'], [draft.cliTools, 'CLI tool'], [draft.mcp, 'MCP connection']] as const) for (const item of items) {
      const max = 'transport' in item && item.transport === 'http' ? toolLimitSeconds.httpMcpMax : toolLimitSeconds.callMax, label = item.name || item.id;
      if (!Number.isSafeInteger(item.timeoutSeconds) || item.timeoutSeconds < 1 || item.timeoutSeconds > max) return `Use a whole number of seconds from 1 to ${max} for the timeout of ${kind} ${label}.`;
      if (item.timeoutSeconds > window) return `The timeout of ${kind} ${label} (${item.timeoutSeconds} s) exceeds the tool window (${window} s). Raise the tool window or shorten the timeout.`;
    }
    for (const item of [...draft.commands, ...draft.cliTools, ...draft.mcp.filter(item => item.transport === 'stdio')]) { try { const args = argumentsOf(item.arguments); if (args.length > 32 || args.some(value => value.length > 2048 || /[\x00-\x1f\x7f]/.test(value))) throw Error(); } catch { return 'Use a JSON array of up to 32 strings for fixed arguments; each argument may contain up to 2,048 characters.'; } }
    for (const connection of draft.mcp) {
      if (connection.transport === 'stdio' && !absolute(connection.command.trim())) return 'Enter an absolute executable path for each local MCP server.';
      if (connection.transport === 'stdio' && !/^[A-Z_][A-Z0-9_]{0,79}$/.test(connection.secretEnv)) return 'Use an uppercase environment variable name for each local MCP secret.';
      if (connection.transport === 'http') { try { const url = new URL(connection.url), local = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname); if (!(url.protocol === 'https:' || url.protocol === 'http:' && local) || url.username || url.password || url.search || url.hash) throw Error(); } catch { return 'Use HTTPS for an MCP server, or HTTP on localhost. Omit credentials, query parameters and fragments.'; } }
      if (connection.secret && connection.clearSecret) return 'Choose either a replacement secret or removal of the saved secret.';
    }
    const origins = new Set<string>();
    if (lines(draft.webOrigins).length > 16) return 'Grant up to 16 web origins.';
    for (const origin of lines(draft.webOrigins)) { try { const url = new URL(origin); if (!['http:', 'https:'].includes(url.protocol) || !['', '/'].includes(url.pathname) || url.username || url.password || url.search || url.hash) throw Error(); if (origins.has(url.origin)) return 'List each web origin only once.'; origins.add(url.origin); } catch { return 'Enter web origins as https://example.com, one per line, without paths or credentials.'; } }
    return '';
  });
  /** Advisory: the invocation budget stops tools first when it is shorter than the window. */
  const windowNote = computed(() => {
    const budget = ports.executionBudgetMs?.();
    return budget !== undefined && draft.windowSeconds * 1000 > budget ? `The worker's invocation limit (${Math.round(budget / 1000).toLocaleString('en-US')} s) is shorter than this window and stops tool calls first.` : '';
  });
  const canSave = computed(() => !locked.value && !!ports.view()?.canEdit && dirty.value && !stale.value && !validation.value);
  const canDiscover = computed(() => !locked.value && !!ports.view()?.canEdit && !dirty.value && !stale.value);
  function savedConnection(id: string): McpConnectionView | undefined { return ports.view()?.mcp.find(item => item.id === id); }
  function destinationChanged(item: McpDraft) { const saved = savedConnection(item.id); let args: string[]; try { args = argumentsOf(item.arguments); } catch { return !!saved; } return !!saved && destination(saved) !== destination({ ...item, args }); }
  function accept(view: ToolAccessView, notice = '') {
    draft.windowSeconds = seconds(view.limits?.windowMs, toolLimitSeconds.windowDefault);
    draft.files = view.builtins.files;
    draft.commands = view.builtins.commands.map(item => ({ id: item.id, name: item.name, executable: item.executable, arguments: json(item.args), enabled: item.enabled, timeoutSeconds: seconds(item.timeoutMs, toolLimitSeconds.callDefault) }));
    draft.cliTools = (view.builtins.cliTools ?? []).map(cliDraft);
    draft.webOrigins = view.builtins.webOrigins.join('\n');
    draft.mcp = view.mcp.map(item => ({ id: item.id, name: item.name, transport: item.transport, enabled: item.enabled, command: item.command, arguments: json(item.args), url: item.url, secretEnv: item.secretEnv, secret: '', clearSecret: false, allowedTools: [...item.allowedTools], timeoutSeconds: seconds(item.timeoutMs, toolLimitSeconds.callDefault) }));
    draft.revision = view.revision; draft.baseline = json(values()); draft.uncertain = null; draft.error = ''; draft.notice = notice;
  }
  function observe() {
    const view = ports.view();
    if (!view || !ports.unlocked() || draft.busy || draft.uncertain) return;
    if (draft.revision < 0 || !dirty.value && draft.revision !== view.revision) accept(view);
  }
  const stopView = watch(() => [ports.unlocked(), json(ports.view())], observe, { immediate: true });
  const stopAccess = watch(ports.unlocked, unlocked => { if (!unlocked) { for (const item of draft.mcp) item.secret = ''; draft.uncertain = null; } }, { flush: 'sync' });
  const stopEpoch = watch(ports.epoch, () => Object.assign(draft, { windowSeconds: toolLimitSeconds.windowDefault, files: false, commands: [], cliTools: [], webOrigins: '', mcp: [], revision: -1, baseline: '', busy: false, discovering: '', checking: false, error: '', notice: '', uncertain: null }), { flush: 'sync' });
  function reload() { if (!locked.value && ports.view()) accept(ports.view()!); }
  function addCommand() {
    if (locked.value || draft.commands.length >= 16) return;
    let n = 1; while ([...draft.commands, ...draft.cliTools, ...draft.mcp].some(item => item.id === `command-${n}`)) n++;
    draft.commands.push({ id: `command-${n}`, name: '', executable: '', arguments: '[]', enabled: false, timeoutSeconds: toolLimitSeconds.callDefault }); draft.notice = '';
  }
  function addCliTool() {
    if (locked.value || draft.cliTools.length >= 8) return;
    let n = 1; while ([...draft.commands, ...draft.cliTools, ...draft.mcp].some(item => item.id === `cli-${n}`)) n++;
    draft.cliTools.push({ id: `cli-${n}`, name: '', description: '', executable: ports.view()?.workerNode ?? '', arguments: '["bin/tool.mjs"]', commands: 'help', refusedOptions: '', maxArgs: 24, maxArgLength: 500, outputKiB: 32, truncationHint: 'Narrow the command, for example with a filter, limit or summary option.', enabled: false, timeoutSeconds: toolLimitSeconds.callDefault }); draft.notice = '';
  }
  function addMcp() {
    if (locked.value || draft.mcp.length >= 8) return;
    let n = 1; while ([...draft.commands, ...draft.cliTools, ...draft.mcp].some(item => item.id === `mcp-${n}`)) n++;
    draft.mcp.push({ id: `mcp-${n}`, name: '', transport: 'stdio', enabled: false, command: '', arguments: '[]', url: '', secretEnv: 'MCP_AUTH_TOKEN', secret: '', clearSecret: false, allowedTools: [], timeoutSeconds: toolLimitSeconds.callDefault }); draft.notice = '';
  }
  function command(): ToolAccessUpdate {
    return { expectedRevision: draft.revision, limits: { windowMs: draft.windowSeconds * 1000 }, builtins: { files: draft.files, commands: draft.commands.map(item => ({ id: item.id, name: item.name.trim(), executable: item.executable.trim(), args: argumentsOf(item.arguments), enabled: item.enabled, timeoutMs: item.timeoutSeconds * 1000 })), cliTools: draft.cliTools.map(item => ({ id: item.id, name: item.name.trim(), description: item.description.trim(), enabled: item.enabled, executable: item.executable.trim(), args: argumentsOf(item.arguments), commands: parseCliRules(item.commands), refusedOptions: words(item.refusedOptions), maxArgs: item.maxArgs, maxArgLength: item.maxArgLength, outputKiB: item.outputKiB, truncationHint: item.truncationHint.trim(), timeoutMs: item.timeoutSeconds * 1000 })), webOrigins: lines(draft.webOrigins).map(value => new URL(value).origin) }, mcp: draft.mcp.map(item => ({ id: item.id, name: item.name.trim(), transport: item.transport, enabled: item.enabled, command: item.transport === 'stdio' ? item.command.trim() : '', args: item.transport === 'stdio' ? argumentsOf(item.arguments) : [], url: item.transport === 'http' ? item.url.trim() : '', secretEnv: item.transport === 'stdio' ? item.secretEnv : '', allowedTools: destinationChanged(item) ? [] : [...item.allowedTools], timeoutMs: item.timeoutSeconds * 1000, ...(item.secret ? { secret: item.secret } : {}), ...(item.clearSecret ? { clearSecret: true } : {}) })) };
  }
  async function send(submitted: ToolAccessUpdate) {
    if (!ports.unlocked() || draft.busy || draft.checking) return;
    const epoch = ports.epoch(); draft.busy = true; draft.error = ''; draft.notice = ''; draft.uncertain = submitted;
    try {
      const result = await ports.write(submitted);
      if (epoch !== ports.epoch() || !ports.unlocked()) return;
      if (result) accept(result, 'Tool access saved. Future model turns use these grants.');
      else draft.error = 'The save could not be confirmed. Check saved access before continuing.';
    } catch (failure) {
      if (epoch !== ports.epoch() || !ports.unlocked()) return;
      const status = (failure as Error & { status?: number }).status;
      if (status && status >= 400 && status < 500 && status !== 401) draft.uncertain = null;
      draft.error = (failure as Error).message;
      if (status === 409) await ports.refresh();
    } finally { if (epoch === ports.epoch()) { draft.busy = false; observe(); } }
  }
  async function save() { if (canSave.value) await send(command()); }
  async function retry() { if (draft.uncertain) await send(draft.uncertain); }
  async function check() {
    if (!ports.unlocked() || draft.busy || draft.checking) return;
    draft.checking = true; const epoch = ports.epoch();
    try { await ports.refresh(); if (epoch === ports.epoch()) observe(); }
    catch (failure) { if (epoch === ports.epoch() && ports.unlocked()) draft.error = (failure as Error).message; }
    finally { if (epoch === ports.epoch()) draft.checking = false; }
  }
  function resolveUncertain() { if (!draft.busy && !draft.checking && ports.unlocked() && ports.view()) accept(ports.view()!, 'Saved access loaded. Review it before making further changes.'); }
  async function discover(id: string) {
    if (!canDiscover.value) return;
    const epoch = ports.epoch(); draft.busy = true; draft.discovering = id; draft.error = ''; draft.notice = '';
    try {
      const result = await ports.discover({ id, expectedRevision: draft.revision });
      if (epoch === ports.epoch() && ports.unlocked() && result) accept(result, 'Tools discovered. Select the tools to grant, then save access.');
    } catch (failure) { if (epoch === ports.epoch() && ports.unlocked()) { draft.error = (failure as Error).message; await ports.refresh(); } }
    finally { if (epoch === ports.epoch()) { draft.busy = false; draft.discovering = ''; observe(); } }
  }
  const workerNode = () => ports.view()?.workerNode ?? '';
  return { draft, dirty, stale, locked, workerNode, validation, windowNote, canSave, canDiscover, savedConnection, destinationChanged, reload, addCommand, addCliTool, addMcp, save, retry, check, resolveUncertain, discover, dispose: () => { stopView(); stopAccess(); stopEpoch(); } };
}
export type ToolAccessEditor = ReturnType<typeof createToolAccessEditor>;
