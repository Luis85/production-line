import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { h, KeepAlive, nextTick } from 'vue';
import { userEvent, within } from 'storybook/test';
import UApp from '@nuxt/ui/components/App.vue';
import DeliveryPublicationPanel from '../src/worker/webview/components/DeliveryPublicationPanel.vue';
import WorkflowTimeline from '../src/worker/webview/components/WorkflowTimeline.vue';
import ManagedProjectsPanel from '../src/worker/webview/components/ManagedProjectsPanel.vue';
import App from '../src/worker/webview/App.vue';
import TaskboardPage from '../src/worker/webview/pages/TaskboardPage.vue';
import ProjectsPage from '../src/worker/webview/pages/ProjectsPage.vue';
import { router } from './router';
import type { LocalMergeView } from '../src/worker/application/local-merge-contracts';
import type { GateCommandFields } from '../src/worker/webview/request-gate-controller';
import { state } from '../src/worker/webview/store';
import { installDeliveryFixture } from './worker-delivery-fixtures';
import { installWorkerFixture } from './worker-fixtures';
import { installManagedProjectsFixture } from './worker-release-fixtures';
const meta = { title: 'Worker/Main checkout workflow', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
const storymap = (summary: string, names: string[]) => ({ app: 'Worker', summary, covers: names.map(name => 'src/worker/webview/' + name + '.vue'), route: '/review?session=file&fileId=file-review', ready: '[data-main-checkout-ready]' });
const commands: GateCommandFields[] = [];
let advance: () => void;
async function ready(canvas: HTMLElement) { await nextTick(); if (document.documentElement.scrollWidth > innerWidth + 1) throw Error('Main checkout workflow overflowed.'); canvas.setAttribute('data-main-checkout-ready', 'true'); }
function localFixture(unknown: boolean) {
  const base = installDeliveryFixture('review'); commands.length = 0;
  const policy = base.request.input.context as { deliveryPolicy: { configuration: { localMerge?: boolean } } }; policy.deliveryPolicy.configuration.localMerge = true;
  base.request.phase = 'done'; base.request.lifecycle = 'in_progress';
  base.request.attestation = { actor: 'operator', inputHash: base.request.inputHash, outputDigest: base.request.execution!.outputDigest!, note: 'Illustrative exact-candidate acceptance.', at: base.request.updatedAt };
  const view: LocalMergeView = { configured: true, reason: unknown ? 'Reconcile the saved main checkout merge before continuing.' : null, candidate: base.review.candidate, target: { repositoryId: 'web', checkoutPath: 'C:\\Werk\\projects\\web\\checkout', branch: 'main', head: 'a'.repeat(40) }, state: { operations: [] }, canMerge: !unknown, canReconcile: unknown };
  if (unknown) view.state.operations.push({ operationId: 'local-merge-unknown', status: 'unknown', repositoryId: 'web', checkoutPath: view.target!.checkoutPath, mainBranch: 'main', mainHead: view.target!.head, candidate: base.review.candidate, createdAt: base.request.updatedAt, updatedAt: base.request.updatedAt, detail: 'The worker restarted before the main checkout update was confirmed.' });
  base.run.localMerge = view.state;
  const original = (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__;
  (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = async (input, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (body.action === 'local_merge') return Response.json(view);
    return original(input, init);
  };
  return base;
}
function renderMerge(unknown: boolean) { return () => ({ setup() { const base = localFixture(unknown); return () => h('main', { style: 'max-width:1000px;margin:auto;padding:24px;min-width:0' }, [h('p', { class: 'page-note' }, 'Illustrative checkout evidence · no Git command or provider runs.'), h(WorkflowTimeline, { subject: base.request }), h(DeliveryPublicationPanel, { subject: base.request, disabled: false, pending: () => false, onCommand: (value: GateCommandFields) => commands.push(value) })]); } }); }
export const ApproveMainCheckoutMerge: Story = {
  name: 'Approve the exact candidate and main checkout destination',
  parameters: { storymap: storymap('Plain Git retains a Markdown pull request. Candidate acceptance does not merge it; the user approves the displayed checkout, branch and current head separately.', ['components/DeliveryPublicationPanel', 'components/WorkflowTimeline']) }, render: renderMerge(false),
  play: async ({ canvasElement }) => { const q = within(canvasElement), merge = await q.findByRole('button', { name: 'Merge reviewed candidate into main checkout' }) as HTMLButtonElement;
    if (!merge.disabled) throw Error('Main checkout mutation requires explicit approval.'); await q.findByText('C:\\Werk\\projects\\web\\checkout');
    await userEvent.click(q.getByRole('checkbox', { name: 'I approve merging this reviewed candidate into this project’s main checkout on main.' })); await userEvent.click(merge);
    if (commands[0]?.action !== 'merge_local_candidate' || commands[0].mainCheckout !== 'C:\\Werk\\projects\\web\\checkout' || commands[0].mainHead !== 'a'.repeat(40) || !commands[0].candidateDigest) throw Error('Main checkout consent lost destination or candidate identity.');
    if (canvasElement.querySelectorAll('[data-workflow-stage]').length !== 6 || canvasElement.querySelector('[data-workflow-stage=build]')) throw Error('Plain Git requires local merge without GitHub release stages.'); await ready(canvasElement);
  }
};
export const ReconcileMainCheckoutMerge: Story = {
  name: 'Observe an uncertain main checkout merge before retrying',
  parameters: { storymap: storymap('An uncertain checkout update keeps its original operation identity and prevents starting a second merge.', ['components/DeliveryPublicationPanel', 'components/WorkflowTimeline']) }, render: renderMerge(true),
  play: async ({ canvasElement }) => { const q = within(canvasElement); await userEvent.click(await q.findByRole('button', { name: 'Reconcile main checkout merge' }));
    if (commands[0]?.action !== 'reconcile_local_merge' || commands[0].localMergeOperationId !== 'local-merge-unknown') throw Error('Recovery lost the saved local merge operation.');
    if (!(q.getByRole('button', { name: 'Merge reviewed candidate into main checkout' }) as HTMLButtonElement).disabled) throw Error('An uncertain merge must block another merge.'); await ready(canvasElement);
  }
};
export const PrepareProjectWorkflow: Story = {
  name: 'Preview, commit and push missing workflow files',
  parameters: { storymap: storymap('First use previews exact create/preserve files and requires approval before a Git commit and push. An uncertain response exposes reconciliation; policy approval remains separate.', ['components/ManagedProjectsPanel']) },
  render: () => ({ setup() { const base = installManagedProjectsFixture(); base.projects.projects[0].workflow.configured = false;
    const original = (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__;
    (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = async (input, init = {}) => { const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
      if (body.action === 'setup_plan') return Response.json({ schemaVersion: 1, projectId: 'web', branch: 'main', baseCommit: 'a'.repeat(40), checkoutCommit: 'a'.repeat(40), provider: 'claude-cli', planDigest: 'b'.repeat(64), requiresPolicyApproval: true, files: [{ path: '.werk/delivery-policy.json', status: 'create', sha256: 'c'.repeat(64), content: '{"localMerge":true}' }, { path: 'README.md', status: 'preserve', sha256: 'd'.repeat(64), content: '# Existing project' }] });
      if (body.action === 'setup_apply' || body.action === 'setup_reconcile') { base.commands.push(body); return Response.json({ schemaVersion: 1, projectId: 'web', operationId: body.operationId, branch: 'main', status: body.action === 'setup_apply' ? 'unknown' : 'published', commit: 'e'.repeat(40), detail: body.action === 'setup_apply' ? 'Publication acknowledgement was interrupted. Reconcile the saved operation.' : 'Project workflow setup publication confirmed.', requiresPolicyApproval: true }); }
      return original(input, init);
    };
    advance = () => { const mutations = base.commands.filter(item => item.action === 'setup_apply' || item.action === 'setup_reconcile'); if (mutations.length !== 2 || mutations[0].operationId !== mutations[1].operationId || mutations[0].expectedPlan !== 'b'.repeat(64)) throw Error('Setup publication recovery lost the exact preview or operation identity.'); };
    return () => h('main', { style: 'max-width:1000px;margin:auto;padding:24px;min-width:0' }, [h('p', { class: 'page-note' }, 'Illustrative setup · no files are written and no Git command runs.'), h(ManagedProjectsPanel)]);
  } }),
  play: async ({ canvasElement }) => { const q = within(canvasElement); await userEvent.click(await q.findByRole('button', { name: 'Preview project workflow setup' })); await userEvent.click(await q.findByText('Create · .werk/delivery-policy.json')); await q.findByText('{"localMerge":true}');
    const apply = q.getByRole('button', { name: 'Commit and push project setup' }) as HTMLButtonElement; if (!apply.disabled) throw Error('Setup must require explicit commit/push approval.');
    await userEvent.click(q.getByRole('checkbox', { name: 'I approve committing and pushing these missing workflow files to main.' })); await userEvent.click(apply); await userEvent.click(await q.findByRole('button', { name: 'Reconcile project setup publication' })); await q.findByText(/Project workflow setup publication confirmed/); advance(); await ready(canvasElement);
  }
};
export const NotifyRequestProgress: Story = {
  name: 'Notify when a request moves from production to review',
  parameters: { storymap: storymap('Taskboard changes follow retained request summaries. A new review state produces a webview update with a request evidence link; dismissing it does not change the request.', ['pages/TaskboardPage', 'components/OverviewTaskCard']) },
  render: () => ({ setup() { const base = installDeliveryFixture('running');
    const original = (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__; (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = async (input, init = {}) => { const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}; if (body.action === 'execution_recovery') return Response.json({ schemaVersion: 1, runs: [] }); const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href); if (url.pathname === '/api/shared-intake') return Response.json({ config: { enabled: false, repositoryId: '' }, projects: [], requests: [] }); return original(input, init); };
    advance = () => { base.run.phase = 'packaging'; base.run.status = 'completed'; base.run.decision.reason = 'Candidate verification completed. Review the proposed increment.'; base.run.decision.waitingFor = 'Human review of the current candidate.'; base.request.lifecycle = 'in_review'; base.request.phase = 'review'; base.session.requestPhase = 'review'; base.session.requestLifecycle = 'in_review'; state.sessions!.execution.currentSessionId = null; state.refreshRevision++; };
    return () => h(UApp, null, { default: () => h(KeepAlive, null, { default: () => h(TaskboardPage) }) });
  } }),
  play: async ({ canvasElement }) => { const q = within(canvasElement); await q.findByText('The worker is implementing the accepted request in its worktree.'); await nextTick(); advance(); const heading = await q.findByRole('heading', { name: 'Worker updates' }); const updates = heading.closest('section')!; await within(updates).findByText(/Ready for human review/); if (!updates.querySelector('a[href*="review"]')) throw Error('Worker update needs a request evidence link.'); await ready(canvasElement); }
};

export const FirstWorkerHome: Story = {
  name: 'Find the first project and provider setup from an empty worker home',
  parameters: { storymap: { ...storymap('A fresh standalone worker keeps its untouched placeholder out of request activity. First-use links lead to provider settings and the central Home project setup, where clone fields and policy approval remain explicit.', ['pages/TaskboardPage', 'pages/ProjectsPage', 'components/ManagedProjectsPanel', 'components/DeliveryPolicyPanel']), route: '/workboard' } },
  render: () => ({ setup() { installWorkerFixture('empty'); state.status!.mode = 'mock'; state.status!.state = 'standalone'; state.environment!.orchestratorUrl = null; state.environment!.chat.provider = 'claude-cli'; state.environment!.chat.configured = false; state.settings!.defaultProvider = 'claude-cli'; state.sessions!.selected = 'default'; state.sessions!.records.push({ id: 'default', taskId: 'default', kind: 'chat', title: 'New task', provider: 'claude-cli', createdAt: '2026-10-25T12:00:00Z', archived: false, status: 'draft', messages: 0, busy: false, interaction: { schemaVersion: 1, sessionId: 'default', revision: 0, phase: 'idle', pending: null, latestTurn: null, turns: [], totalTurns: 0 } }); return () => h(UApp, null, { default: () => h(KeepAlive, null, { default: () => h(router.currentRoute.value.path === '/projects' ? ProjectsPage : TaskboardPage) }) }); } }),
  play: async ({ canvasElement }) => {
    const q = within(canvasElement);
    await q.findByRole('heading', { name: 'Prepare your first Feature Request' });
    for (const [name, href] of [['Set up a provider', '/settings#provider-connections'], ['Add a project', '/projects'], ['Approve the project delivery policy', '/projects#delivery-policy']]) {
      if (q.getByRole('link', { name }).getAttribute('href') !== href) throw Error('First-use navigation lost its exact Home setup destination: ' + name);
    }
    await userEvent.click(q.getByRole('link', { name: 'Add a project' }));
    await q.findByRole('heading', { name: 'Projects' });
    if (router.currentRoute.value.fullPath !== '/projects') throw Error('Add project did not navigate to the central Projects page.');
    await userEvent.click(q.getByText('Add a project', { exact: true }));
    for (const label of ['Project ID', 'Git repository URL', 'Shared branch', 'Feature Request folder', 'Check for new requests every · seconds']) {
      const field = q.getByLabelText(label);
      if (!field.checkVisibility()) throw Error('Home clone setup did not expose ' + label);
    }
    const clone = q.getByRole('button', { name: 'Clone and add project' }) as HTMLButtonElement;
    if (!clone.disabled) throw Error('An empty clone registration must not be submitted.');
    if (q.queryByLabelText('Absolute checkout directory')) throw Error('New Home projects must use isolated clones.');
    await q.findByRole('heading', { name: 'Project delivery policy' });
    await ready(canvasElement);
  }
};
function renderRetainedSetup(resume: boolean) { return () => ({ setup() {
  const base = installManagedProjectsFixture(), project = base.projects.projects[0]; project.workflow.configured = false;
  const plan = { schemaVersion: 1 as const, projectId: 'web', branch: 'main', baseCommit: 'a'.repeat(40), checkoutCommit: 'a'.repeat(40), provider: 'claude-cli', planDigest: 'b'.repeat(64), requiresPolicyApproval: true as const, files: [{ path: '.werk/delivery-policy.json', status: 'create' as const, sha256: 'c'.repeat(64), content: '{"localMerge":true}' }] };
  project.setup = { schemaVersion: 1, projectId: 'web', operationId: 'retained-setup', branch: 'main', status: 'unknown', detail: resume ? 'Preparation stopped before publication. Review the retained plan before resuming.' : 'Publication may have completed. Reconcile the original operation.', requiresPolicyApproval: true, ...(resume ? { resumePlan: plan } : { commit: 'e'.repeat(40) }) };
  const original = (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__;
  (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = async (input, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (body.action === 'setup_apply' || body.action === 'setup_reconcile') {
      if (body.operationId !== 'retained-setup' || (resume ? body.action !== 'setup_apply' || body.expectedPlan !== plan.planDigest : body.action !== 'setup_reconcile')) throw Error('Reload recovery changed its durable setup identity.');
      delete project.setup; return Response.json({ schemaVersion: 1, projectId: 'web', operationId: 'retained-setup', branch: 'main', status: 'published', commit: 'e'.repeat(40), detail: 'Retained setup publication confirmed.', requiresPolicyApproval: true });
    }
    return original(input, init);
  };
  return () => h('main', { style: 'max-width:1000px;margin:auto;padding:24px;min-width:0' }, [h('p', { class: 'page-note' }, 'Illustrative reloaded setup journal · no Git commands run.'), h(ManagedProjectsPanel)]);
} }); }
export const ReloadUncertainSetup: Story = {
  name: 'Recover an uncertain setup publication after reloading the webview',
  parameters: { storymap: storymap('The managed project returns the durable uncertain operation after reload. Recovery observes that operation without starting another publication.', ['components/ManagedProjectsPanel']) }, render: renderRetainedSetup(false),
  play: async ({ canvasElement }) => { const q = within(canvasElement); await userEvent.click(await q.findByRole('button', { name: 'Reconcile project setup publication' })); await q.findByText(/Retained setup publication confirmed/); if (q.queryByRole('button', { name: 'Resume project setup publication' })) throw Error('An uncertain push must not be repeated.'); await ready(canvasElement); }
};
export const ResumeRetainedSetup: Story = {
  name: 'Approve a retained pre-publication setup plan after reloading',
  parameters: { storymap: storymap('A known interruption before publication retains the exact plan and operation. Resuming requires renewed explicit commit and push approval.', ['components/ManagedProjectsPanel']) }, render: renderRetainedSetup(true),
  play: async ({ canvasElement }) => { const q = within(canvasElement), resume = await q.findByRole('button', { name: 'Resume project setup publication' }) as HTMLButtonElement;
    if (!resume.disabled) throw Error('Reload must clear prior setup consent.'); await userEvent.click(q.getByText('Create · .werk/delivery-policy.json')); await q.findByText('{"localMerge":true}');
    await userEvent.click(q.getByRole('checkbox', { name: 'I approve committing and pushing these missing workflow files to main.' })); await userEvent.click(resume); await q.findByText(/Retained setup publication confirmed/); await ready(canvasElement);
  }
};

function assignmentShell(orchestratorUrl: string | null) { return () => ({ setup() { installWorkerFixture('empty'); state.status!.mode = 'mock'; state.status!.state = orchestratorUrl ? 'idle' : 'standalone'; state.environment!.orchestratorUrl = orchestratorUrl; state.environment!.chat.provider = 'claude-cli'; state.settings!.defaultProvider = 'claude-cli'; return () => h(App); } }); }
export const StandaloneAssignmentMode: Story = {
  name: 'Keep legacy fleet mode out of a standalone Claude workspace',
  parameters: { storymap: storymap('Standalone local Claude requests have their own provider configuration. A disconnected fleet assignment mode must not label their workspace as simulation.', ['App', 'components/WorkerShell']) }, render: assignmentShell(null),
  play: async ({ canvasElement }) => { const q = within(canvasElement); await q.findByText('standalone', { exact: true }); if (q.queryByText(/Assignments:/) || q.queryByText('Assignment mode unavailable')) throw Error('Standalone local work must not inherit an assignment execution label.'); await ready(canvasElement); }
};
export const FleetAssignmentSimulation: Story = {
  name: 'Retain the simulation label for a configured fleet',
  parameters: { storymap: storymap('A configured orchestrator keeps its truthful assignment simulation label independently of the provider selected for local work.', ['App', 'components/WorkerShell']) }, render: assignmentShell('http://example-orchestrator.invalid'),
  play: async ({ canvasElement }) => { await within(canvasElement).findByText('Assignments: simulation'); await ready(canvasElement); }
};
