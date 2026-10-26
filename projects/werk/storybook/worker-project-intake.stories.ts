import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { h, nextTick, ref } from 'vue';
import { userEvent, waitFor, within } from 'storybook/test';
import TaskIntake from '../src/worker/webview/components/TaskIntake.vue';
import { state } from '../src/worker/webview/store';
import { installExpandedDeliveryFixture } from './worker-expanded-delivery-fixtures';
const meta = { title: 'Worker/Project intake', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
let commands: Record<string, any>[] = [];
const projects = [{ id: 'web', label: 'Web project', enabled: true }, { id: 'api', label: 'API project', enabled: true }];
const binding = (repositoryId: string) => ({ repositoryId, remote: 'origin', branch: 'team-intake', workflowPath: '.werk/feature-workflow.json' });
function render(shared: boolean) { return () => ({ setup() {
  installExpandedDeliveryFixture(); commands = []; state.draftEpoch++;
  state.settings!.repositories.items = projects.map(project => ({ id: project.id, path: '/example/' + project.id, remote: 'origin', branch: 'main', watch: true }));
  const created = ref(''), previous = (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__;
  if (shared) state.environment!.sharedIntake = { dependencyPlans: [], selectedProjectId: 'web', projects, revision: 1, workerId: 'example-worker', config: { ...binding('web'), enabled: true, pollMs: 15000 }, canEdit: true, blockedReason: null, state: 'idle', error: null, lastSyncedAt: null, sourceCommit: null, workflow: null, requests: [] };
  else if (state.environment?.sharedIntake) state.environment.sharedIntake.config.repositoryId = '';
  (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href), body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (!shared && url.pathname === '/api/shared-intake') return Response.json({ revision: 1, workerId: 'fixture-worker', config: { enabled: false, repositoryId: '', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 1000 }, canEdit: true, blockedReason: null, state: 'disabled', error: null, lastSyncedAt: null, sourceCommit: null, workflow: null, requests: [] });
    if (shared && url.pathname === '/api/shared-intake') { const projectId = url.searchParams.get('projectId') || 'web'; return Response.json({ ...state.environment!.sharedIntake, selectedProjectId: projectId, config: { ...state.environment!.sharedIntake!.config, ...binding(projectId) } }); }
    if (url.pathname === '/api/settings') return Response.json({ ...state.settings, repositories: { ...state.settings!.repositories, items: projects.map(project => ({ id: project.id, path: '/example/' + project.id, remote: 'origin', branch: 'main', watch: true })) } });
    if (url.pathname === '/api/tasks' && body.action === 'create') { commands.push(body); return Response.json({ session: { ...state.sessions!.records[0], id: 'created-api', title: body.title }, chat: { ...state.chat, sessionId: 'created-api' } }); }
    if (url.pathname === '/api/features' && body.action === 'prepare') { commands.push(body); return Response.json({ featureId: 'FR-project-draft', name: 'FR-project-draft.md', path: 'features/FR-project-draft.md', markdown: '---\nschemaVersion: 1\nid: FR-project-draft\ntitle: API request\nstatus: draft\nmode: patch\npaths: []\n---\n# Goal\n\n' + body.seed.message + '\n\n## Context\n\nAPI project validation behavior.\n\n## Acceptance criteria\n\n## Verification plan\n', revision: null, status: 'draft', readiness: { valid: false, errors: [{ code: 'details', message: 'Complete acceptance criteria and approved paths before publishing.' }] }, workflowDigest: 'illustrative-project-workflow', binding: body.expectedBinding }); }
    return previous(input, init);
  };
  return () => h('main', { style: 'max-width:760px;margin:auto;padding:24px;min-width:0' }, [h('p', { class: 'page-note' }, 'Illustrative project selection · request bodies are captured offline; no request is dispatched or published.'), h(TaskIntake, { onCreated: (id: string) => { created.value = id; } }), created.value ? h('p', { role: 'status' }, 'Illustrative request saved: ' + created.value) : null]);
} }); }
function storymap(summary: string, shared = false) { return { app: 'Worker', summary, covers: ['TaskIntake', 'ProjectExecutionSelection', ...(shared ? ['SharedFeatureComposer', 'FeatureRequestDetails'] : [])].map(name => 'src/worker/webview/components/' + name + '.vue'), route: '/taskboard', ready: '[data-project-intake-ready]' }; }
async function ready(canvas: HTMLElement) { await nextTick(); if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) throw Error('Project intake overflowed.'); canvas.setAttribute('data-project-intake-ready', 'true'); }
export const DirectProjectRequest: Story = {
  name: 'Create one canonical request in a selected project', parameters: { storymap: storymap('The direct composer binds a secondary project and its authorized execution profile to the same durable request. Raw worker defaults do not override the named profile.') }, render: render(false),
  play: async ({ canvasElement }) => { const q = within(canvasElement); await userEvent.selectOptions(q.getByLabelText('Project', { exact: true }), 'api'); await userEvent.click(q.getByText('Task options', { exact: true })); const profile = await q.findByLabelText('Project execution profile'); await userEvent.selectOptions(profile, 'reviewer'); await q.findByText('via override', { exact: false }); await userEvent.type(q.getByLabelText('Request instructions', { exact: true }), 'Describe the API change and its measurable acceptance criteria.'); await userEvent.click(q.getByRole('button', { name: 'Create request' })); await q.findByText('Illustrative request saved: created-api'); const project = q.getByLabelText('Project', { exact: true }) as HTMLSelectElement; if (project.value !== 'api' || project.selectedOptions[0]?.textContent !== 'api') throw Error('The saved request project disappeared after refreshing worker settings.'); const body = commands[0]; if (commands.length !== 1 || body.projectId !== 'api' || body.executionProfile !== 'reviewer' || !body.id || ['provider', 'model', 'effort'].some(key => key in body)) throw Error('Canonical project/profile admission included inherited raw model settings or lost identity.'); await ready(canvasElement); },
};
export const SharedProjectAutomaticRouting: Story = {
  name: 'Prepare a shared project draft with automatic routing', parameters: { storymap: storymap('The shared composer preserves project Git binding and omits inherited provider settings for automatic routing. Preparing the draft neither publishes nor starts implementation.', true) }, render: render(true),
  play: async ({ canvasElement }) => {
    const q = within(canvasElement);
    const instruction = 'Implement the API validation rules after the team completes its criteria.';
    await userEvent.selectOptions(await q.findByLabelText('Project', { exact: true }), 'api');
    await q.findByText('api · origin / team-intake');
    await userEvent.click(q.getByText('Request options', { exact: true }));
    await q.findByLabelText('Project execution profile');
    await waitFor(() => { if (!q.queryByText('via default', { exact: false })) throw Error('Project policy is still loading.'); });
    await userEvent.type(q.getByLabelText('Request instructions', { exact: true }), instruction);
    await userEvent.click(q.getByRole('button', { name: 'Prepare request' }));
    const name = await q.findByLabelText('Request name') as HTMLInputElement;
    const goal = await q.findByLabelText('Goal', { exact: true }) as HTMLTextAreaElement;
    if (name.value !== 'API request' || goal.value !== instruction || canvasElement.querySelector('.request-identity strong')?.textContent !== 'API request') throw Error('The prepared draft lost its readable request identity or accepted instructions.');
    await q.findByLabelText('Context', { exact: true });
    await q.findByLabelText('Verification plan', { exact: true });
    const advanced = q.getByText('Advanced template editing', { exact: true });
    await userEvent.click(advanced);
    const markdown = q.getByLabelText('Complete request Markdown') as HTMLTextAreaElement;
    if (!/^id: FR-project-draft$/m.test(markdown.value) || !/^title: API request$/m.test(markdown.value)) throw Error('The readable draft must preserve its exact canonical Feature Request ID in the project template.');
    await userEvent.click(advanced);
    const body = commands[0];
    if (commands.length !== 1 || body.action !== 'prepare' || !body.operationId || body.projectId !== 'api' || body.expectedBinding.repositoryId !== 'api' || ['executionProfile', 'provider', 'model', 'effort'].some(key => key in body.seed)) throw Error('Automatic routing did not preserve the project binding and omitted model fields.');
    if (!(q.getByRole('button', { name: 'Mark ready and publish' }) as HTMLButtonElement).disabled) throw Error('Incomplete shared request could publish ready.');
    await ready(canvasElement);
  },
};
