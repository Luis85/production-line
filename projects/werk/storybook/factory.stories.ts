import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { h, type Component } from 'vue';
import { expect, within, waitFor } from 'storybook/test';
import FactoryApp from '../src/factory/webview/App.vue';
import FactoryDashboard from '../src/factory/webview/components/FactoryDashboard.vue';
import FactoryIntake from '../src/factory/webview/components/FactoryIntake.vue';
import FactoryTaskboard from '../src/factory/webview/components/FactoryTaskboard.vue';
import LineDashboard from '../src/factory/webview/components/LineDashboard.vue';
import RegistryEditor from '../src/factory/webview/components/RegistryEditor.vue';
import { factoryFixture, lines } from './fixtures/portfolio';

const meta = { title: 'Factory/Portfolio and routing', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type Fixture = ReturnType<typeof factoryFixture>;
const map = (component: string, summary: string, step: number) => ({ storymap: {
  app: 'Factory', summary, journey: 'Portfolio to production line', step,
  route: component === 'App' ? '/' : '/factories/studio',
  covers: [`src/factory/webview/${component}.vue`],
} });
function panel(component: Component, title: string, configure: (store: Fixture) => void = () => {}, options = {}) {
  return () => ({ setup() {
    const store = factoryFixture(options);
    configure(store);
    return () => h('main', { style: 'padding:32px;max-width:1440px;margin:auto;min-width:0' }, [
      h('p', { class: 'eyebrow' }, 'Factory · isolated example'),
      h('h1', { style: 'font-size:1.8rem;font-weight:650;margin-bottom:24px' }, title),
      h(component, { store }),
    ]);
  } });
}

export const Access: Story = {
  name: '01 · Access and token guidance',
  parameters: map('App', 'The public access screen explains Factory credentials before exposing portfolio data.', 1),
  render: () => ({ render: () => h(FactoryApp) }),
  play: async ({ canvasElement }) => { await expect(within(canvasElement).getByLabelText('Zugangstoken der Fabrikverwaltung')).toBeVisible(); },
};
export const Portfolio: Story = {
  name: '02 · Factory portfolio',
  parameters: map('components/FactoryDashboard', 'A Factory groups independent production lines and observes their task and capacity totals.', 2),
  render: panel(FactoryDashboard, 'Production portfolio'),
};
export const EmptyPortfolio: Story = {
  name: '03 · Empty portfolio',
  parameters: map('components/FactoryDashboard', 'A newly configured Factory explains that no production line has been registered.', 2),
  render: panel(FactoryDashboard, 'A new Factory', () => {}, { empty: true }),
};
export const UnavailableLine: Story = {
  name: '04 · Partial portfolio observations',
  parameters: map('components/FactoryDashboard', 'An unavailable line remains visible; its missing measurements are never presented as zero.', 2),
  render: panel(FactoryDashboard, 'One line needs attention', store => { store.state.lineView = 'list'; store.state.stale = true; }, { unavailable: true }),
};
export const IntakeAndRouting: Story = {
  name: '05 · Intake and delivery receipts',
  parameters: map('components/FactoryIntake', 'Prepare a request, choose automatic or manual routing, and distinguish queued work from acknowledged delivery.', 3),
  render: panel(FactoryIntake, 'Prepare and route work'),
  play: async ({ canvasElement }) => { await expect(within(canvasElement).getByLabelText('Projekt')).toHaveValue('customer-portal'); },
};
export const IntakeReadOnly: Story = {
  name: '06 · Intake with viewer access',
  parameters: map('components/FactoryIntake', 'Viewer access preserves delivery visibility and disables task creation and routing mutations.', 3),
  render: panel(FactoryIntake, 'Observe work with viewer access', store => { store.state.canWrite = false; store.state.role = 'Nur Lesezugriff'; }),
};
export const AggregatedTaskboard: Story = {
  name: '07 · Tasks across production lines',
  parameters: map('components/FactoryTaskboard', 'Bounded task pages preserve line ownership and link each task to its orchestrator.', 4),
  render: panel(FactoryTaskboard, 'Work across the Factory'),
  play: async ({ canvasElement }) => { await waitFor(() => expect(within(canvasElement).getByText('Clarify account permissions')).toBeVisible()); },
};
export const TaskboardPartialFailure: Story = {
  name: '08 · Taskboard with an unreachable line',
  parameters: map('components/FactoryTaskboard', 'One failed task source does not hide successful line reads; the partial selection is explicit.', 4),
  render: panel(FactoryTaskboard, 'Inspect a partial taskboard', () => {}, { unavailable: true }),
  play: async ({ canvasElement }) => { await waitFor(() => expect(within(canvasElement).getByText(/Fixture: this line is temporarily unavailable/)).toBeVisible()); },
};
export const SelectedLine: Story = {
  name: '09 · Production line dashboard',
  parameters: map('components/LineDashboard', 'A selected line shows its own intake, queue, workers, evidence and independent orchestrator handoff.', 5),
  render: panel(LineDashboard, 'Inspect a production line', store => { store.state.lineId = 'alpha'; }),
};
export const RegisterLine: Story = {
  name: '10 · Register a production line',
  parameters: map('components/RegistryEditor', 'Registration connects an existing orchestrator using a credential variable reference, without starting services.', 6),
  render: panel(RegistryEditor, 'Connect an existing production line', store => {
    store.openEditor('line');
    Object.assign(store.state.editor!, { name: 'Customer experience', factoryId: 'studio', orchestratorUrl: 'https://alpha.example.invalid', webviewUrl: 'https://alpha.example.invalid', tokenEnv: 'WERK_LINE_ALPHA_TOKEN' });
  }),
};
export const EditFactory: Story = {
  name: '11 · Edit Factory hierarchy',
  parameters: map('components/RegistryEditor', 'Factory editing exposes logical ownership and excludes descendants from parent choices.', 6),
  render: panel(RegistryEditor, 'Organize the Factory hierarchy', store => { store.openEditor('factory', store.state.factories[1]); }),
};
export const UnregisterLine: Story = {
  name: '12 · Unregister confirmation',
  parameters: map('components/RegistryEditor', 'The explicit confirmation explains that unregistering a line leaves its runtime and tasks intact.', 6),
  render: panel(RegistryEditor, 'Review a registry change', store => { store.state.deletion = { type: 'line', id: lines[0].id, name: lines[0].name, key: 'synthetic-removal' }; }),
};
