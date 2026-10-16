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
    state.toolAccess = { schemaVersion: 1, revision: configured ? 3 : 0, builtins: { files: configured, commands: configured ? [{ id: 'check-types', name: 'Check project types', executable: '/example/bin/npm', args: ['run', 'typecheck'], enabled: true }] : [], cliTools: configured ? [{ id: 'harness', name: 'Project harness', description: 'Reads the project backlog and runs project checks.', enabled: true, executable: '/example/bin/node', args: ['bin/harness.mjs'], commands: [{ command: 'help', requireOneOf: [], refusedOptions: [] }, { command: 'backlog context', requireOneOf: [], refusedOptions: [] }, { command: 'backlog set', requireOneOf: ['--dry-run'], refusedOptions: [] }, { command: 'eol', requireOneOf: [], refusedOptions: ['--fix'] }], refusedOptions: ['--root', '--config', '--out'], maxArgs: 24, maxArgLength: 500, outputKiB: 48, truncationHint: 'Narrow the command with --limit or --format summary.' }] : [], webOrigins: configured ? ['https://docs.example.com'] : [] }, mcp: configured ? [{ id: 'documentation', name: 'Project documentation', transport: 'http', enabled: true, command: '', args: [], url: 'https://tools.example.com/mcp', secretEnv: '', hasSecret: true, allowedTools: ['search_docs'], discoveredTools: [{ name: 'search_docs', description: 'Search the project documentation available to this server.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }, { name: 'publish_note', description: 'Publish a note to the documentation server. This tool is not granted.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }] : [], canEdit: !blocked, saveBlockedReason: blocked ? 'Pause new starts and finish or stop queued and running work before changing tool access.' : null, workerNode: '/example/bin/node' };
    const fetchFixture: typeof fetch = (input, init) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href).pathname;
      if (path.startsWith('/api/tool-access')) return Promise.resolve(init?.method === 'POST' ? Response.json({ error: 'Illustrative fixture. Runtime changes are disabled.' }, { status: 409 }) : Response.json(state.toolAccess));
      return fixture.fetchFixture(input, init);
    };
    (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = fetchFixture;
    return () => h(UApp, null, { default: () => h('div', { style: 'max-width:1050px;margin:auto;padding:24px;min-width:0' }, [h('p', { class: 'page-note' }, 'Illustrative example · no tools or servers are contacted'), h(ToolAccessPanel)]) });
  } });
}
const storymap = (summary: string) => ({ app: 'Worker', summary, covers: ['src/worker/webview/components/ToolAccessPanel.vue', 'src/worker/webview/components/McpConnectionsEditor.vue', 'src/worker/webview/components/CliToolsEditor.vue'], route: '/dashboard#tool-access', ready: '[data-worker-tools-ready]' });
const ready = async ({ canvasElement }: { canvasElement: HTMLElement }) => { await nextTick(); canvasElement.setAttribute('data-worker-tools-ready', 'true'); };
export const DefaultOff: Story = { name: 'All tools disabled by default', parameters: { storymap: storymap('Default-off file, command, CLI, web and MCP grants stay explicit and separate from provider sign-in.') }, render: render(), play: ready };
export const GrantedTools: Story = { name: 'Manage built-in and MCP grants', parameters: { storymap: storymap('Individual tool grants, fixed command presets, a project CLI with an argument policy, secret preservation, server discovery and model data flow are visible before saving.') }, render: render(true), play: ready };
export const DrainBeforeSaving: Story = { name: 'Pause and drain guidance', parameters: { storymap: storymap('Operators can draft tool changes while the worker runs, then pause and drain before saving or revoking access.') }, render: render(false, true), play: ready };
