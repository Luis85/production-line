import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { onUnmounted } from 'vue';
import ConceptApp from '../src/orchestrator/webview/concept/ConceptApp.vue';
import { createConceptSimulation, STORAGE_KEY } from '../src/orchestrator/webview/concept/engine.mjs';
import { findElement } from './story-actions';

const meta = { title: 'Concept/Local simulation', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const root = 'src/orchestrator/webview/concept/ConceptApp.vue';
const component = (name: string) => `src/orchestrator/webview/concept/components/${name}.vue`;
const parameters = (summary: string, covers: string[], step: number) => ({ storymap: {
  app: 'Concept', summary, covers: [root, ...covers], journey: 'Explore the complete system in a local simulation', step,
} });

/** Use the product simulation engine and its normal storage boundary, never a parallel UI model. */
function renderConcept(view: string, selectedLine = 'line-atlas') {
  return () => ({
    components: { ConceptApp },
    setup() {
      const previous = localStorage.getItem(STORAGE_KEY);
      const previousHash = location.hash;
      const engine = createConceptSimulation();
      engine.chooseLine(selectedLine);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(engine.data));
      history.replaceState(null, '', `${location.pathname}${location.search}#${view}`);
      onUnmounted(() => {
        if (previous === null) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, previous);
        history.replaceState(null, '', `${location.pathname}${location.search}${previousHash}`);
      });
      return {};
    },
    template: '<ConceptApp />',
  });
}

export const Intake: Story = {
  parameters: parameters('Create a requirement-backed or manually specified feature in the selected simulated line.', [component('ConceptIntake')], 1),
  render: renderConcept('intake'),
};
export const Factories: Story = {
  parameters: parameters('Explore Factory hierarchy and line ownership without mixing task stores.', [component('ConceptFactory')], 2),
  render: renderConcept('factory'),
};
export const Architecture: Story = {
  parameters: parameters('Inspect the illustrative architecture, worker responsibilities and command versus feedback connections.', ['src/shared/webview/components/SpatialMap.vue'], 3),
  render: renderConcept('architecture'),
};
export const Process: Story = {
  parameters: parameters('Trace a selected feature through context, attempt, checks, review and human merge confirmation.', [component('ConceptDocumentation')], 4),
  render: renderConcept('process'),
};
export const Taskboard: Story = {
  parameters: parameters('Inspect simulated tasks by workflow state within the active production line.', [component('ConceptBoard')], 5),
  render: renderConcept('board'),
};
export const ReviewDetail: Story = {
  parameters: parameters('Inspect a simulated review, checks and snapshot evidence before an explicit human decision.', [component('ConceptBoard'), component('ConceptTaskDetail')], 6),
  render: renderConcept('board', 'line-portal'),
  play: async ({ canvasElement }) => {
    const card = await findElement<HTMLElement>(canvasElement, '[data-task-id="102"]');
    card.click();
    await findElement(document.body, '[role="dialog"]');
  },
};
export const Dashboard: Story = {
  parameters: parameters('Observe simulated throughput and capacity while keeping unknown real-world cost and quality explicit.', [component('ConceptDashboard')], 7),
  render: renderConcept('dashboard'),
};
export const Providers: Story = {
  parameters: parameters('Inspect worker configuration, provider profiles and bounded capacity in the local simulation.', [component('ConceptProviders')], 8),
  render: renderConcept('providers'),
};
export const Operations: Story = {
  parameters: parameters('Read development commands and persistence boundaries without executing services or shell commands.', [component('ConceptDocumentation')], 9),
  render: renderConcept('operations'),
};
export const System: Story = {
  parameters: parameters('Inspect architecture boundaries and the division of responsibilities across the complete system.', [component('ConceptDocumentation'), component('ConceptSystem'), component('ConceptRepositoryWorkflow'), component('ConceptRuntimeBoundaries'), component('ConceptAgentDelivery')], 10),
  render: renderConcept('system'),
};
