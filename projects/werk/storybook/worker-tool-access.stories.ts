import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { h, nextTick } from 'vue';
import UApp from '@nuxt/ui/components/App.vue';
import ToolAccessPanel from '../src/worker/webview/components/ToolAccessPanel.vue';
import { state } from '../src/worker/webview/store';
import { installWorkerFixture } from './worker-fixtures';
const meta = { title: 'Worker/Tool access', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
function render(configured = false, blocked = false) {
  return () => ({ setup() {
    const fixture = installWorkerFixture('empty');
    state.settings!.board.paused = !blocked;
    state.toolAccess = { schemaVersion: 1, revision: configured ? 3 : 0, builtins: { files: configured, commands: configured ? [{ id: 'check-types', name: 'Check project types', executable: '/example/bin/npm', args: ['run', 'typecheck'], enabled: true, verification: true, timeoutMs: 300000 }] : [], cliTools: configured ? [{ id: 'harness', name: 'Project harness', description: 'Reads the project backlog and runs project checks.', enabled: true, executable: '/example/bin/node', args: ['bin/harness.mjs'], commands: [{ command: 'help', requireOneOf: [], refusedOptions: [] }, { command: 'backlog context', requireOneOf: [], refusedOptions: [] }, { command: 'backlog set', requireOneOf: ['--dry-run'], refusedOptions: [] }, { command: 'eol', requireOneOf: [], refusedOptions: ['--fix'] }], refusedOptions: ['--root', '--config', '--out'], maxArgs: 24, maxArgLength: 500, outputKiB: 48, truncationHint: 'Narrow the command with --limit or --format summary.', timeoutMs: 600000 }] : [], webOrigins: configured ? ['https://docs.example.com'] : [] }, mcp: configured ? [{ id: 'documentation', name: 'Project documentation', transport: 'http', enabled: true, command: '', args: [], url: 'https://tools.example.com/mcp', secretEnv: '', hasSecret: true, timeoutMs: 30000, allowedTools: ['search_docs'], discoveredTools: [{ name: 'search_docs', description: 'Search the project documentation available to this server.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }, { name: 'publish_note', description: 'Publish a note to the documentation server. This tool is not granted.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }] : [], canEdit: !blocked, saveBlockedReason: blocked ? 'Pause new starts and finish or stop queued and running work before changing tool access.' : null, workerNode: '/example/bin/node' };
    const fetchFixture: typeof fetch = (input, init) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href).pathname;
      if (path.startsWith('/api/tool-access')) return Promise.resolve(init?.method === 'POST' ? Response.json({ error: 'Illustrative fixture. Runtime changes are disabled.' }, { status: 409 }) : Response.json(state.toolAccess));
      return fixture.fetchFixture(input, init);
    };
    (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = fetchFixture;
    return () => h(UApp, null, { default: () => h('div', { style: 'max-width:1050px;margin:auto;padding:24px;min-width:0' }, [h('p', { class: 'page-note' }, 'Illustrative example · no tools or servers are contacted'), h(ToolAccessPanel)]) });
  } });
}
const storymap = (summary: string) => ({ app: 'Worker', summary, covers: ['src/worker/webview/components/ToolAccessPanel.vue', 'src/worker/webview/components/McpConnectionsEditor.vue', 'src/worker/webview/components/CliToolsEditor.vue'], route: '/settings#tool-access', ready: '[data-worker-tools-ready]' });
const ready = async ({ canvasElement }: { canvasElement: HTMLElement }) => { await nextTick(); canvasElement.setAttribute('data-worker-tools-ready', 'true'); };
export const DefaultOff: Story = { name: 'All tools disabled by default', parameters: { storymap: storymap('Default-off file, command, CLI, web and MCP grants stay explicit and separate from provider sign-in.') }, render: render(), play: ready };
export const GrantedTools: Story = { name: 'Manage built-in and MCP grants', parameters: { storymap: storymap('Individual tool grants, fixed command presets, a project CLI with an argument policy, secret preservation, server discovery and model data flow are visible before saving.') }, render: render(true), play: ready };
export const DrainBeforeSaving: Story = { name: 'Pause and drain guidance', parameters: { storymap: storymap('Operators can draft tool changes while the worker runs, then pause and drain before saving or revoking access.') }, render: render(false, true), play: ready };

async function element(canvas: HTMLElement, selector: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = canvas.querySelector<HTMLElement>(selector);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('Tool access story did not render ' + selector);
}
export const SavedCliPolicy: Story = {
  name: 'Retain saved CLI command guards',
  parameters: { storymap: storymap('Saved CLI grants keep required preview flags and refused options visible. The worker Node.js shortcut chooses the known executable without changing the command policy or granting access by itself.') },
  render: render(true),
  play: async ({ canvasElement }) => {
    const commands = await element(canvasElement, '#cli-commands-0') as HTMLTextAreaElement;
    if (!commands.value.includes('backlog set requires --dry-run') || !commands.value.includes('eol refuses --fix')) throw Error('Saved CLI command guards must remain intact in the editor.');
    const executable = await element(canvasElement, '#cli-executable-0') as HTMLInputElement;
    executable.value = '/example/alternate/node'; executable.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick(); // Render the edited input before the shortcut restores its previous value.
    const shortcut = [...canvasElement.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Use worker Node.js');
    if (!shortcut) throw Error('The worker executable shortcut must be available.');
    shortcut.click(); await nextTick();
    if (executable.value !== '/example/bin/node') throw Error('The shortcut must use the worker-reported executable.');
    if (!commands.value.includes('requires --dry-run') || !commands.value.includes('refuses --fix')) throw Error('Changing the executable must preserve command guards.');
    (await element(canvasElement, '.cli-limits') as HTMLDetailsElement).open = true;
    await ready({ canvasElement });
  },
};
export const IncompleteCliGuard: Story = {
  name: 'Keep an incomplete CLI guard unsaved',
  parameters: { storymap: storymap('An incomplete requires clause is retained as an invalid draft, with visible correction guidance and saving disabled. The editor never silently removes the missing guard from a previously constrained command.') },
  render: render(true),
  play: async ({ canvasElement }) => {
    const commands = await element(canvasElement, '#cli-commands-0') as HTMLTextAreaElement;
    commands.value = 'backlog set requires'; commands.dispatchEvent(new Event('input', { bubbles: true }));
    const error = await element(canvasElement, '.tool-access .error-text[role="status"]');
    const submit = canvasElement.querySelector<HTMLButtonElement>('.tool-save-actions button[type="submit"]');
    if (!error.textContent?.trim() || !submit?.disabled) throw Error('An incomplete CLI command guard must block saving with an explanation.');
    if (commands.value !== 'backlog set requires') throw Error('Invalid command guards must remain visible for correction.');
    await ready({ canvasElement });
  },
};


export const InheritedTimeouts: Story = {
  name: 'Restore inherited tool timeouts',
  parameters: { storymap: storymap('Blank timeout overrides restore the saved command cap or the 30-second MCP default. Clearing a timeout changes no grant or required-check authority.') },
  render: render(true),
  play: async ({ canvasElement }) => {
    (await element(canvasElement, '.cli-limits') as HTMLDetailsElement).open = true;
    for (const id of ['#tool-command-timeout-0', '#cli-timeout-0', '#mcp-timeout-0']) {
      const field = await element(canvasElement, id) as HTMLInputElement;
      field.value = ''; field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await nextTick();
    if (!(await element(canvasElement, '#tool-command-timeout-help-0')).textContent?.includes('Effective cap: 300 s')) throw Error('A blank command timeout must inherit the saved command cap.');
    if (!(await element(canvasElement, '#mcp-timeout-help-0')).textContent?.includes('Effective cap: 30 s')) throw Error('A blank MCP timeout must inherit 30 seconds.');
    if (canvasElement.querySelector('#tool-window')) throw Error('Tool access must not introduce another invocation window.');
    await ready({ canvasElement });
  },
};
export const CappedTimeoutOverride: Story = {
  name: 'Explain a shorter effective command cap',
  parameters: { storymap: storymap('A per-command override cannot extend the saved worker command cap. MCP calls use their own override, and remaining invocation time can shorten either call.') },
  render: render(true),
  play: async ({ canvasElement }) => {
    const field = await element(canvasElement, '#tool-command-timeout-0') as HTMLInputElement;
    field.value = '600'; field.dispatchEvent(new Event('input', { bubbles: true }));
    const mcp = await element(canvasElement, '#mcp-timeout-0') as HTMLInputElement;
    mcp.value = '45'; mcp.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    if (!(await element(canvasElement, '#tool-command-timeout-help-0')).textContent?.includes('Effective cap: 300 s')) throw Error('The command override must remain bounded by the worker cap.');
    if (!(await element(canvasElement, '#mcp-timeout-help-0')).textContent?.includes('Effective cap: 45 s')) throw Error('MCP must use its configured override.');
    await ready({ canvasElement });
  },
};
export const InvalidMcpTimeout: Story = {
  name: 'Correct an invalid MCP timeout draft',
  parameters: { storymap: storymap('An HTTP MCP timeout beyond five minutes remains visible as an invalid draft. Saving stays disabled until corrected.') },
  render: render(true),
  play: async ({ canvasElement }) => {
    const field = await element(canvasElement, '#mcp-timeout-0') as HTMLInputElement;
    field.value = '301'; field.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    const error = await element(canvasElement, '.tool-access .error-text[role="status"]');
    if (!error.textContent?.includes('1–300 seconds') || !canvasElement.querySelector<HTMLButtonElement>('.tool-save-actions button[type="submit"]')?.disabled || field.value !== '301') throw Error('An invalid MCP timeout must keep its draft and prevent saving.');
    await ready({ canvasElement });
  },
};
