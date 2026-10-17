import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { DocumentationPage, documentationStory } from './documentation';
const meta = { title: "Documentation/Operate the system", component: DocumentationPage, parameters: { layout: 'fullscreen' } } satisfies Meta<typeof DocumentationPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Consumption: Story = documentationStory("consumption", "Configure a daily or monthly allowance and inspect reservation/accounting limits.");
export const Metrics: Story = documentationStory("run-metrics", "Interpret measured run evidence without treating missing usage as zero.");
export const Recovery: Story = documentationStory("backup-upgrade", "Back up state and follow a verified upgrade and recovery workflow.");
