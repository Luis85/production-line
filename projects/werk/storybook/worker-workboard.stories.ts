import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { h, KeepAlive, nextTick } from 'vue';
import { userEvent, within } from 'storybook/test';
import UApp from '@nuxt/ui/components/App.vue';
import Workboard from '../src/worker/webview/pages/TaskboardPage.vue';
import ProjectIntegrationsPanel from '../src/worker/webview/components/ProjectIntegrationsPanel.vue';
import { state } from '../src/worker/webview/store';
import NewRequestPage from '../src/worker/webview/pages/NewRequestPage.vue';
import RequestPage from '../src/worker/webview/pages/RequestPage.vue';
import { router } from './router';
import ProjectsPage from '../src/worker/webview/pages/ProjectsPage.vue';
import WorkerShell from '../src/worker/webview/components/WorkerShell.vue';
import { workerLinks } from '../src/worker/webview/worker-navigation';
import { installWorkboardFixture } from './worker-workboard-fixtures';
const meta = { title: 'Worker/Workboard journey', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
let fixture: ReturnType<typeof installWorkboardFixture>;
const storymap = (summary: string, projects = false, composer = true) => ({ app: 'Worker', summary, covers: (projects ? ['pages/ProjectsPage', 'components/ManagedProjectsPanel'] : ['pages/TaskboardPage', ...(composer ? ['pages/NewRequestPage', 'components/NewFeatureRequestPanel', 'components/SharedFeatureComposer', 'components/FeatureRequestDetails'] : [])]).map(path => 'src/worker/webview/' + path + '.vue'), route: projects ? '/projects' : '/workboard', ready: '[data-workboard-ready]' });
function render(variant: 'setup' | 'ready' | 'review', projects = false) { return () => ({ setup() {
  fixture = installWorkboardFixture(variant);
  return () => h(UApp, null, { default: () => h(WorkerShell, { links: workerLinks, homePath: '/workboard', homeLabel: 'Werk Home', navLabel: 'Worker pages' }, { identity: () => h('span', 'Werk Home · example data'), default: () => [h('p', { style: 'padding:16px 32px 0', class: 'page-note' }, 'Fictional journey · no repository changes, provider calls or publication'), h(KeepAlive, null, { default: () => h(projects ? ProjectsPage : router.currentRoute.value.path === '/requests/new' ? NewRequestPage : router.currentRoute.value.path === '/request' ? RequestPage : Workboard) })], footer: () => 'Isolated fixture · no runtime connected' }) });
} }); }
async function ready(canvas: HTMLElement) { await nextTick(); canvas.setAttribute('data-workboard-ready', 'true'); }
export const FirstProject: Story = {
  name: 'Start from Workboard with an explicit setup path', parameters: { storymap: storymap('New Feature Request leads to project approval and provider setup; it never falls back to an untracked local conversation.', false, false) }, render: render('setup'),
  play: async ({ canvasElement }) => { const q = within(canvasElement); await userEvent.click(q.getByRole('button', { name: 'New Feature Request' })); await q.findByRole('heading', { name: 'Get ready to create a Feature Request' }); if (q.queryByLabelText('Request instructions')) throw Error('Held project must not expose a different intake path.'); await ready(canvasElement); },
};
export const CanonicalRequest: Story = {
  name: 'Prepare the registered project template before explicit Git publication', parameters: { storymap: storymap('A registered ready clone prepares a canonical Feature Request with exact project binding. Preparing stays separate from commit and push.') }, render: render('ready'),
  play: async ({ canvasElement }) => { const q = within(canvasElement); await userEvent.click(q.getByRole('button', { name: 'New Feature Request' })); await userEvent.type(await q.findByLabelText('Request instructions', { exact: true }), 'Export orders for finance with a stable CSV format.'); await userEvent.click(q.getByRole('button', { name: 'Prepare request' })); await q.findByRole('button', { name: 'Mark ready and publish' }); if (q.queryByRole('heading', { name: /^Workboard$/ }) || q.queryByRole('tab', {name:'New request'})) throw Error('Authoring must be a focused project request page.'); if (fixture.commands.length !== 1 || fixture.commands[0]?.action !== 'prepare' || fixture.commands[0]?.projectId !== 'web' || fixture.commands[0]?.expectedBinding?.repositoryId !== 'web') throw Error('Request preparation escaped its registered project.'); if (fixture.commands.some(command => command.action === 'publish')) throw Error('Preparing a request must not publish it.'); await ready(canvasElement); },
};
export const RetainDraft: Story = {
  name: 'Close and reopen without losing the project draft', parameters: { storymap: storymap('The on-demand composer retains instructions and project identity across closing and reopening. No model or Git action is dispatched.') }, render: render('ready'),
  play: async ({ canvasElement }) => { const q = within(canvasElement); await userEvent.click(q.getByRole('button', { name: 'New Feature Request' })); await userEvent.type(await q.findByLabelText('Request instructions', { exact: true }), 'Keep this exact project draft.'); await userEvent.click(q.getByRole('button', { name: 'Back to Workboard' })); if (document.activeElement?.id !== 'new-feature-request') throw Error('Closing the composer did not restore keyboard focus.'); await userEvent.click(q.getByRole('button', { name: 'New Feature Request' })); if ((await q.findByLabelText('Request instructions', { exact: true }) as HTMLTextAreaElement).value !== 'Keep this exact project draft.') throw Error('Closing the composer lost the retained draft.'); if ((q.getByLabelText('Project', { exact: true }) as HTMLSelectElement).value !== 'web') throw Error('Closing the composer changed its project.'); if (fixture.commands.length) throw Error('Drafting dispatched a mutation.'); await ready(canvasElement); },
};
export const VisibleHomeProjects: Story = {
  name: 'See the Home checkout and clone-only project settings', parameters: { storymap: storymap('Projects shows the visible central Home and exact checkout. Add project exposes branch, request folder and actual poll interval, with no adoption of a developer checkout.', true) }, render: render('ready', true),
  play: async ({ canvasElement }) => { const q = within(canvasElement); await q.findByText(/Werk Home:.*Projects:/); const add = await q.findByRole('link', { name: 'Add a project' }); if (add.getAttribute('href') !== '/projects/new') throw Error('Project registration must have its own focused page.'); if (q.queryByLabelText('Git repository URL') || q.queryByLabelText('Absolute checkout directory')) throw Error('The project directory must not mix registration or checkout adoption with project selection.'); await ready(canvasElement); },
};
export const ReviewLane: Story = {
  name: 'Review increments without treating acceptance as a merge', parameters: { storymap: storymap('The board keeps delivered candidates in Review & merge and preserves their exact review route; human acceptance and main-checkout merge remain separate actions.', false, false) }, render: render('review'),
  play: async ({ canvasElement }) => { const q = within(canvasElement); await q.findByRole('heading', { name: /Review & merge/ }); await q.findByRole('button', { name: 'Review increment' });
    await userEvent.click(q.getByRole('button', { name: 'List' }));
    const groups = [...canvasElement.querySelectorAll('.overview-group')]; if (!groups[0]?.textContent?.includes('Needs you') || !groups[1]?.textContent?.includes('Review & merge')) throw Error('Questions and review must lead the keyboard and mobile reading order.');
    if (groups.length < 2 || Math.abs(groups[0]!.getBoundingClientRect().x - groups[1]!.getBoundingClientRect().x) > 1) throw Error('List view must stack the workflow groups.');
    await userEvent.click(q.getByRole('button', { name: 'Board' }));
    await ready(canvasElement); },
};

export const PublishCanonicalRequest: Story = {
  name: 'Publish the checked request only after an explicit action', parameters: { storymap: storymap('Preparing a project template does not publish. The explicit ready action carries the exact binding, workflow digest and original feature file to shared Git.') }, render: render('ready'),
  play: async ({ canvasElement }) => {
    const q = within(canvasElement);
    await userEvent.click(q.getByRole('button', { name: 'New Feature Request' }));
    await userEvent.type(await q.findByLabelText('Request instructions', { exact: true }), 'Export orders for finance with a stable CSV format.');
    await userEvent.click(q.getByRole('button', { name: 'Prepare request' }));
    const publish = await q.findByRole('button', { name: 'Mark ready and publish' });
    if (fixture.commands.some(command => command.action === 'publish')) throw Error('Preparation published without consent.');
    await userEvent.click(publish);
    await q.findByText('Ready request committed and pushed. The worker will claim it when eligible.');
    const command = fixture.commands.at(-1);
    if (command?.action !== 'publish' || command.status !== 'ready' || command.name !== 'export-orders.md' || command.expectedBinding?.repositoryId !== 'web' || command.expectedWorkflowDigest !== 'fixture-workflow') throw Error('Ready publication lost the checked project draft identity.');
    await ready(canvasElement);
  },
};

export const HomeProjectInstructions: Story = {
  name: 'Project instructions lead to Home setup instead of a project-local worker',
  parameters: { storymap: { app:'Worker', summary:'Central Home suppresses the retired project-local integration endpoint and directs setup to registered project clones.', covers:['src/worker/webview/components/ProjectIntegrationsPanel.vue'], route:'/settings#integrations', ready:'[data-workboard-ready]' } },
  render: () => ({ setup() { installWorkboardFixture('ready'); state.environment!.homeLayout='central'; const original=(window as unknown as {__WERK_STORY_FETCH__:typeof fetch}).__WERK_STORY_FETCH__; (window as unknown as {__WERK_STORY_FETCH__:typeof fetch}).__WERK_STORY_FETCH__=async(input,init)=>{const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href).pathname;if(path==='/api/integrations')throw Error('Central Home must not use the retired project-local integration endpoint.');return original(input,init);};return()=>h('main',{style:'max-width:900px;margin:auto;padding:24px;min-width:0'},[h('p',{class:'page-note'},'Fictional central Home · no project instructions are written'),h(ProjectIntegrationsPanel)]); } }),
  play: async ({canvasElement})=>{const q=within(canvasElement);await q.findByText(/Project workflow setup lives in/);if(q.queryByRole('button',{name:'Preview synchronization'})||canvasElement.textContent?.includes('Initialize this worker'))throw Error('Central Home exposed retired project installation.');await ready(canvasElement);},
};

export const OpenExistingRequest: Story = {
  name: 'Open one existing conversation without starting another request',
  parameters: { storymap: { app:'Worker', summary:'The request page binds the explicit session before exposing its checkpoint; it never mounts generic new-chat intake.', covers:['src/worker/webview/pages/RequestPage.vue','src/worker/webview/components/TaskInteraction.vue'], route:'/request?session=completed', ready:'[data-workboard-ready]' } },
  render: render('review'),
  play: async ({canvasElement}) => { const q=within(canvasElement); await q.findByRole('heading',{name:'Conversation'}); if(q.queryByRole('tab',{name:'New request'}) || q.queryByRole('heading',{name:/^Workboard$/})) throw Error('An existing request must not mount another creation or board goal.'); if(state.sessions?.selected!=='completed') throw Error('The explicit request identity must remain selected.'); await ready(canvasElement); },
};
export const MissingRequestIdentity: Story = {
  name:'An unavailable request never falls back to the selected conversation',
  parameters:{storymap:{app:'Worker',summary:'An unknown request produces recovery guidance while preserving the previous selection and hiding its messages.',covers:['src/worker/webview/pages/RequestPage.vue'],route:'/request?session=missing-request',ready:'[data-workboard-ready]'}},
  render:render('review'),
  play:async({canvasElement})=>{const q=within(canvasElement);await q.findByRole('alert');if(q.queryByRole('heading',{name:'Conversation'})||q.queryByLabelText('Follow-up message'))throw Error('Missing identity exposed another request conversation.');if(state.sessions?.selected!=='completed')throw Error('Missing identity must not select a fallback request.');await ready(canvasElement);},
};

export const RetainPreparedDraft: Story = {
  name:'Keep prepared requirements while returning to the board',
  parameters:{storymap:storymap('Prepared requirements remain attached to the exact project across navigation. Returning does not reprepare or publish.')},render:render('ready'),
  play:async({canvasElement})=>{const q=within(canvasElement);await userEvent.click(q.getByRole('button',{name:'New Feature Request'}));await userEvent.type(await q.findByLabelText('Request instructions',{exact:true}),'Export orders for finance.');await userEvent.click(q.getByRole('button',{name:'Prepare request'}));const goal=await q.findByLabelText('Goal',{exact:true}) as HTMLTextAreaElement;await userEvent.clear(goal);await userEvent.type(goal,'Keep these exact prepared requirements.');await userEvent.click(q.getByRole('button',{name:'Back to Workboard'}));await userEvent.click(q.getByRole('button',{name:'New Feature Request'}));if((await q.findByLabelText('Goal',{exact:true}) as HTMLTextAreaElement).value!=='Keep these exact prepared requirements.')throw Error('Navigating to Workboard lost prepared requirements.');if(fixture.commands.length!==1||fixture.commands[0]?.expectedBinding?.repositoryId!=='web')throw Error('Returning changed or replayed the project reservation.');await ready(canvasElement);},
};
export const SavedDraftConsent: Story = {
  name:'Open a saved draft only after explicitly discarding retained instructions',
  parameters:{storymap:storymap('A saved-draft deep link preserves existing private instructions until explicit discard, then reopens only the exact named project draft.')},render:render('ready'),
  play:async({canvasElement})=>{const q=within(canvasElement);await userEvent.click(q.getByRole('button',{name:'New Feature Request'}));const instructions=await q.findByLabelText('Request instructions',{exact:true}) as HTMLTextAreaElement;await userEvent.type(instructions,'Private instructions must survive a saved-draft link.');await router.push({path:'/requests/new',query:{project:'web',draft:'export-orders.md'}});await q.findByText('Your retained draft is still open. Save or discard it before opening another project draft.');if(instructions.value!=='Private instructions must survive a saved-draft link.'||fixture.commands.length)throw Error('A draft deep link replaced private instructions or issued a command without consent.');await userEvent.click(q.getByRole('button',{name:'Discard retained instructions and open the saved draft'}));await q.findByLabelText('Goal',{exact:true});const command=fixture.commands[0];if(fixture.commands.length!==1||command?.action!=='prepare'||command.name!=='export-orders.md'||command.expectedBinding?.repositoryId!=='web'||fixture.commands.some(value=>value.action==='publish'))throw Error('Saved draft reopening lost its exact identity or published without consent.');await ready(canvasElement);},
};

export const MixedRequestIdentity: Story = {
  name:'Reject a link with conflicting conversation and project identities',
  parameters:{storymap:{app:'Worker',summary:'A mixed session/project link exposes no conversation controls and never selects an alternative request.',covers:['src/worker/webview/pages/RequestPage.vue'],route:'/request?session=completed&project=web&request=other.md',ready:'[data-workboard-ready]'}},render:render('review'),
  play:async({canvasElement})=>{const q=within(canvasElement);await q.findByText('This link mixes conversation and project request identities. Return to Workboard and open the exact request.');if(q.queryByRole('heading',{name:'Conversation'})||canvasElement.querySelector('.shared-intake-panel'))throw Error('Ambiguous identity exposed a fallback request surface.');if(state.sessions?.selected!=='completed')throw Error('An ambiguous link selected another conversation.');await ready(canvasElement);},
};
