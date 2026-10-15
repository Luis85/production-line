import type { Meta, StoryObj } from '@storybook/vue3-vite';
import GuideApp from '../src/guide/webview/GuideApp.vue';
import { clickButton, fillInput, findElement } from './story-actions';

const meta = { title: 'Guide/System journeys', component: GuideApp, parameters: { layout: 'fullscreen' } } satisfies Meta<typeof GuideApp>;
export default meta;
type Story = StoryObj<typeof meta>;
const parameters = (summary: string, step: number) => ({ storymap: {
  app: 'Guide', summary, covers: ['src/guide/webview/GuideApp.vue'], journey: 'Understand, define and operate a system', step,
} });

export const SystemOverview: Story = {
  parameters: parameters('Understand the real boundaries between Factory, production line, Orchestrator, Worker and task evidence.', 1),
};
export const FollowATask: Story = {
  parameters: parameters('Follow submission, leasing, evidence and human review through the system guide.', 2),
  play: async ({ canvasElement }) => {
    await clickButton(canvasElement, 'Human review');
    await findElement(canvasElement, '#task-life');
  },
};
export const NativeSystemDefinition: Story = {
  parameters: parameters('Prepare and preview a native system definition with independent runtime state and explicit worker capacity.', 3),
  play: async ({ canvasElement }) => {
    await fillInput(canvasElement, '#definition-id', 'product-system');
    await fillInput(canvasElement, '#definition-factory', 'Product Factory');
    (await findElement<HTMLElement>(canvasElement, '#deployment')).scrollIntoView();
  },
};
export const DockerSystemDefinition: Story = {
  parameters: parameters('Preview Docker deployment commands and generated YAML without requiring host Node or starting a runtime.', 4),
  play: async ({ canvasElement }) => {
    await clickButton(canvasElement, 'Docker · no host Node');
    (await findElement<HTMLElement>(canvasElement, '#deployment')).scrollIntoView();
  },
};
export const InvalidDefinition: Story = {
  parameters: parameters('Block an invalid system definition and show the validation explanation before download.', 5),
  play: async ({ canvasElement }) => {
    await fillInput(canvasElement, '#definition-workers', '0');
    (await findElement<HTMLElement>(canvasElement, '#deployment')).scrollIntoView();
  },
};
export const RecoveryGuidance: Story = {
  parameters: parameters('Read the scoped health, shutdown, backup and recovery guidance for a complete deployment.', 6),
  play: async ({ canvasElement }) => {
    const operations = await findElement<HTMLElement>(canvasElement, '#operations');
    for (const disclosure of operations.querySelectorAll('details')) disclosure.open = true;
    operations.scrollIntoView();
  },
};
