import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { userEvent, within } from 'storybook/test';
import { h, nextTick, type Component } from 'vue';
import UApp from '@nuxt/ui/components/App.vue';
import ToolAccessPanel from '../src/worker/webview/components/ToolAccessPanel.vue';
import InteractionPanel from '../src/worker/webview/components/InteractionPanel.vue';
import { installToolDirectoryFixture, installToolBudgetFixture } from './worker-increment-fixtures';

const meta = { title: 'Worker/Local development', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
const toolComponents = ['ToolAccessPanel', 'McpConnectionsEditor'];
const storymap = (summary: string, components: string[], route = '/settings#tool-access') => ({ app: 'Worker', summary, covers: components.map(name => 'src/worker/webview/components/' + name + '.vue'), route, ready: '[data-increment-ready]' });
function render(component: Component, install: () => unknown) {
  return () => ({ setup() {
    install();
    return () => h(UApp, null, { default: () => h('div', { style: 'max-width:1050px;margin:auto;padding:24px;min-width:0' }, [
      h('p', { class: 'page-note' }, 'Illustrative example · no model, process or repository changes'), h(component),
    ]) });
  } });
}
async function element(canvas: HTMLElement, selector: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = canvas.querySelector<HTMLElement>(selector);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('Local development story did not render ' + selector);
}
async function ready(canvas: HTMLElement) { await nextTick(); canvas.setAttribute('data-increment-ready', 'true'); }

export const PrivateChatDirectory: Story = {
  name: 'Start chat tools in a private folder by default',
  parameters: { storymap: storymap('Commands and local MCP servers start without project files unless the operator explicitly selects an assigned checkout. File-task worktrees keep their own priority.', toolComponents) },
  render: render(ToolAccessPanel, () => installToolDirectoryFixture('private')),
  play: async ({ canvasElement }) => {
    for (const id of ['#tool-command-chat-help-0', '#mcp-chat-help-0']) if (!(await element(canvasElement, id)).textContent?.includes('empty private folder')) throw Error('The private default must explain the absence of project files.');
    const secret = await element(canvasElement, '#mcp-secret-env-0') as HTMLInputElement;
    if (secret.value !== '') throw Error('A local MCP connection without a secret must not require a secret environment variable.');
    await ready(canvasElement);
  },
};
export const LiveChatDirectory: Story = {
  name: 'Recognize explicitly granted live checkout access',
  parameters: { storymap: storymap('A saved live-checkout choice warns that command and MCP writes may change the developer checkout. Tasks continue to use their isolated worktree.', toolComponents) },
  render: render(ToolAccessPanel, () => installToolDirectoryFixture('live')),
  play: async ({ canvasElement }) => {
    for (const id of ['#tool-command-chat-help-0', '#mcp-chat-help-0']) {
      const help = await element(canvasElement, id);
      if (!help.textContent?.includes('live repository checkout') || !help.textContent.includes('Tasks still use their task worktree')) throw Error('The live checkout choice must explain its authority and preserve task worktree precedence.');
    }
    await ready(canvasElement);
  },
};
export const MissingChatRepository: Story = {
  name: 'Correct a removed chat repository assignment',
  parameters: { storymap: storymap('A saved reference to a removed repository stays visible with correction guidance. Saving cannot silently fall back to another checkout.', toolComponents) },
  render: render(ToolAccessPanel, () => installToolDirectoryFixture('missing')),
  play: async ({ canvasElement }) => {
    const error = await element(canvasElement, '.tool-access .error-text[role="status"]');
    if (!error.textContent?.includes('no longer assigned')) throw Error('A missing assignment must have actionable guidance.');
    if (!canvasElement.querySelector<HTMLButtonElement>('.tool-save-actions button[type="submit"]')?.disabled) throw Error('A missing repository assignment must block saving.');
    await ready(canvasElement);
  },
};
export const ChangedMcpDirectory: Story = {
  name: 'Review MCP tools again after changing the chat directory',
  parameters: { storymap: storymap('A working-directory change invalidates the MCP catalog and grants before saving. Same-server credentials remain preserved; discovery never implicitly grants tools.', toolComponents) },
  render: render(ToolAccessPanel, () => installToolDirectoryFixture('private', true)),
  play: async ({ canvasElement }) => {
    await userEvent.click(await element(canvasElement, '#mcp-chat-0'));
    await userEvent.click(await within(document.body).findByRole('option', { name: /^Live checkout of repository “web” · not isolated$/ }));
    const notice = await element(canvasElement, '.mcp-connection .connection-change');
    if (!notice.textContent?.includes('Changing the chat directory clears discovered tools and grants') || !notice.textContent.includes('saved secret stays')) throw Error('Directory changes must explain rediscovery and secret preservation separately.');
    if (canvasElement.querySelector('.mcp-connection .tool-grants')) throw Error('The previous directory’s tools must not remain grantable.');
    const secret = await element(canvasElement, '#mcp-secret-0') as HTMLInputElement;
    if (!secret.placeholder.includes('Secret saved')) throw Error('Changing only the directory must preserve the same server’s credential.');
    await ready(canvasElement);
  },
};
function budgetStory(reason: 'calls' | 'window'): Story {
  return {
    name: reason === 'calls' ? 'Review a reached tool call limit' : 'Review an expired tool window',
    parameters: { storymap: storymap('Saved evidence shows the configured 128-call, six-hour invocation budget and refused calls. It does not promise a successful final model turn after an invocation deadline.', ['InteractionPanel'], '/taskboard') },
    render: render(InteractionPanel, () => installToolBudgetFixture(reason)),
    play: async ({ canvasElement }) => {
      await element(canvasElement, '.turn-consumption h4');
      for (let attempt = 0; attempt < 100 && !canvasElement.textContent?.includes('Tool budget exhausted'); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      const text = canvasElement.textContent ?? '';
      if (!text.includes(reason === 'calls' ? '128 of 128 calls used' : '9 of 128 calls used') || !text.includes('21600 s window') || !text.includes(reason === 'calls' ? '2 calls refused' : '1 call refused')) throw Error('Tool budget evidence must retain actual configured limits and counts.');
      await ready(canvasElement);
    },
  };
}
export const ToolCallLimit: Story = { ...budgetStory('calls'), name: 'Review a reached tool call limit' };
export const ToolWindowLimit: Story = { ...budgetStory('window'), name: 'Review an expired tool window' };
