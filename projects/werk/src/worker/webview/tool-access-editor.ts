import { computed, reactive, watch } from 'vue';
import type { ToolAccessView, ToolAccessUpdate, McpConnectionView } from '../application/tool-policy';

export interface CommandDraft { id: string; name: string; executable: string; arguments: string; enabled: boolean; }
export interface McpDraft { id: string; name: string; transport: 'stdio' | 'http'; enabled: boolean; command: string; arguments: string; url: string; secretEnv: string; secret: string; clearSecret: boolean; allowedTools: string[]; }
interface EditorPorts {
  view: () => ToolAccessView | null;
  unlocked: () => boolean;
  epoch: () => number;
  write: (command: ToolAccessUpdate) => Promise<ToolAccessView | undefined>;
  discover: (command: { id: string; expectedRevision: number }) => Promise<ToolAccessView | undefined>;
  refresh: () => Promise<unknown>;
}
const lines = (value: string) => value.split('\n').map(item => item.trim()).filter(Boolean);
const json = (value: unknown) => JSON.stringify(value);
function argumentsOf(value: string): string[] { const result: unknown = JSON.parse(value); if (!Array.isArray(result) || !result.every(item => typeof item === 'string')) throw Error('Arguments must be a JSON array of strings.'); return result; }
const absolute = (value: string) => /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(value);
function canonicalUrl(value: string): string { try { return new URL(value).href; } catch { return value.trim(); } }
const destination = (value: { transport: string; command: string; args?: string[]; arguments?: string; url: string; secretEnv?: string }) => json(value.transport === 'http' ? ['http', canonicalUrl(value.url)] : ['stdio', value.command.trim(), value.args ?? value.arguments, value.secretEnv ?? '']);

/** Tool grants stay drafts until the paused, drained worker acknowledges a revision. */
export function createToolAccessEditor(ports: EditorPorts) {
  const draft = reactive({ files: false, commands: [] as CommandDraft[], webOrigins: '', mcp: [] as McpDraft[], revision: -1, baseline: '', busy: false, discovering: '', checking: false, error: '', notice: '', uncertain: null as ToolAccessUpdate | null });
  const values = () => ({ files: draft.files, commands: draft.commands, webOrigins: draft.webOrigins, mcp: draft.mcp });
  const dirty = computed(() => json(values()) !== draft.baseline);
  const stale = computed(() => draft.revision >= 0 && !!ports.view() && draft.revision !== ports.view()!.revision);
  const locked = computed(() => !ports.unlocked() || draft.busy || draft.checking || !!draft.uncertain);
  const validation = computed(() => {
    for (const group of [draft.commands, draft.mcp]) {
      const ids = new Set<string>();
      for (const item of group) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(item.id)) return 'Use 1–64 letters, numbers, underscores or hyphens for each ID.';
      if (ids.has(item.id)) return 'Give each command and each MCP connection a different ID.';
      ids.add(item.id);
      if (!item.name.trim()) return 'Give each command and MCP connection a name.';
      }
    }
    if (draft.commands.length > 16 || draft.mcp.length > 8) return 'Use up to 16 command presets and eight MCP connections.';
    for (const command of draft.commands) if (!absolute(command.executable.trim())) return 'Enter an absolute executable path for every command preset.';
    for (const item of [...draft.commands, ...draft.mcp.filter(item => item.transport === 'stdio')]) { try { const args = argumentsOf(item.arguments); if (args.length > 32 || args.some(value => value.length > 2048 || /[\x00-\x1f\x7f]/.test(value))) throw Error(); } catch { return 'Use a JSON array of up to 32 strings for fixed arguments; each argument may contain up to 2,048 characters.'; } }
    for (const connection of draft.mcp) {
      if (connection.transport === 'stdio' && !absolute(connection.command.trim())) return 'Enter an absolute executable path for each local MCP server.';
      if (connection.transport === 'stdio' && connection.secretEnv && !/^[A-Z_][A-Z0-9_]{0,79}$/.test(connection.secretEnv)) return 'Use an uppercase environment variable name for each local MCP secret.';
      if (connection.transport === 'stdio' && !connection.secretEnv && connection.secret) return 'Name the environment variable that receives the local MCP secret, or leave the secret blank.';
      if (connection.transport === 'http') { try { const url = new URL(connection.url), local = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname); if (!(url.protocol === 'https:' || url.protocol === 'http:' && local) || url.username || url.password || url.search || url.hash) throw Error(); } catch { return 'Use HTTPS for an MCP server, or HTTP on localhost. Omit credentials, query parameters and fragments.'; } }
      if (connection.secret && connection.clearSecret) return 'Choose either a replacement secret or removal of the saved secret.';
    }
    const origins = new Set<string>();
    if (lines(draft.webOrigins).length > 16) return 'Grant up to 16 web origins.';
    for (const origin of lines(draft.webOrigins)) { try { const url = new URL(origin); if (!['http:', 'https:'].includes(url.protocol) || !['', '/'].includes(url.pathname) || url.username || url.password || url.search || url.hash) throw Error(); if (origins.has(url.origin)) return 'List each web origin only once.'; origins.add(url.origin); } catch { return 'Enter web origins as https://example.com, one per line, without paths or credentials.'; } }
    return '';
  });
  const canSave = computed(() => !locked.value && !!ports.view()?.canEdit && dirty.value && !stale.value && !validation.value);
  const canDiscover = computed(() => !locked.value && !!ports.view()?.canEdit && !dirty.value && !stale.value);
  function savedConnection(id: string): McpConnectionView | undefined { return ports.view()?.mcp.find(item => item.id === id); }
  function destinationChanged(item: McpDraft) { const saved = savedConnection(item.id); let args: string[]; try { args = argumentsOf(item.arguments); } catch { return !!saved; } return !!saved && destination(saved) !== destination({ ...item, args }); }
  function accept(view: ToolAccessView, notice = '') {
    draft.files = view.builtins.files;
    draft.commands = view.builtins.commands.map(item => ({ id: item.id, name: item.name, executable: item.executable, arguments: json(item.args), enabled: item.enabled }));
    draft.webOrigins = view.builtins.webOrigins.join('\n');
    draft.mcp = view.mcp.map(item => ({ id: item.id, name: item.name, transport: item.transport, enabled: item.enabled, command: item.command, arguments: json(item.args), url: item.url, secretEnv: item.secretEnv, secret: '', clearSecret: false, allowedTools: [...item.allowedTools] }));
    draft.revision = view.revision; draft.baseline = json(values()); draft.uncertain = null; draft.error = ''; draft.notice = notice;
  }
  function observe() {
    const view = ports.view();
    if (!view || !ports.unlocked() || draft.busy || draft.uncertain) return;
    if (draft.revision < 0 || !dirty.value && draft.revision !== view.revision) accept(view);
  }
  const stopView = watch(() => [ports.unlocked(), json(ports.view())], observe, { immediate: true });
  const stopAccess = watch(ports.unlocked, unlocked => { if (!unlocked) { for (const item of draft.mcp) item.secret = ''; draft.uncertain = null; } }, { flush: 'sync' });
  const stopEpoch = watch(ports.epoch, () => Object.assign(draft, { files: false, commands: [], webOrigins: '', mcp: [], revision: -1, baseline: '', busy: false, discovering: '', checking: false, error: '', notice: '', uncertain: null }), { flush: 'sync' });
  function reload() { if (!locked.value && ports.view()) accept(ports.view()!); }
  function addCommand() {
    if (locked.value || draft.commands.length >= 16) return;
    let n = 1; while ([...draft.commands, ...draft.mcp].some(item => item.id === `command-${n}`)) n++;
    draft.commands.push({ id: `command-${n}`, name: '', executable: '', arguments: '[]', enabled: false }); draft.notice = '';
  }
  function addMcp() {
    if (locked.value || draft.mcp.length >= 8) return;
    let n = 1; while ([...draft.commands, ...draft.mcp].some(item => item.id === `mcp-${n}`)) n++;
    draft.mcp.push({ id: `mcp-${n}`, name: '', transport: 'stdio', enabled: false, command: '', arguments: '[]', url: '', secretEnv: 'MCP_AUTH_TOKEN', secret: '', clearSecret: false, allowedTools: [] }); draft.notice = '';
  }
  function command(): ToolAccessUpdate {
    return { expectedRevision: draft.revision, builtins: { files: draft.files, commands: draft.commands.map(item => ({ id: item.id, name: item.name.trim(), executable: item.executable.trim(), args: argumentsOf(item.arguments), enabled: item.enabled })), webOrigins: lines(draft.webOrigins).map(value => new URL(value).origin) }, mcp: draft.mcp.map(item => ({ id: item.id, name: item.name.trim(), transport: item.transport, enabled: item.enabled, command: item.transport === 'stdio' ? item.command.trim() : '', args: item.transport === 'stdio' ? argumentsOf(item.arguments) : [], url: item.transport === 'http' ? item.url.trim() : '', secretEnv: item.transport === 'stdio' ? item.secretEnv : '', allowedTools: destinationChanged(item) ? [] : [...item.allowedTools], ...(item.secret ? { secret: item.secret } : {}), ...(item.clearSecret ? { clearSecret: true } : {}) })) };
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
  return { draft, dirty, stale, locked, validation, canSave, canDiscover, savedConnection, destinationChanged, reload, addCommand, addMcp, save, retry, check, resolveUncertain, discover, dispose: () => { stopView(); stopAccess(); stopEpoch(); } };
}
export type ToolAccessEditor = ReturnType<typeof createToolAccessEditor>;
