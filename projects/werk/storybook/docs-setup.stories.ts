import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { DocumentationPage, documentationStory } from './documentation';
const meta = { title: "Documentation/Set up your workspace", component: DocumentationPage, parameters: { layout: 'fullscreen' } } satisfies Meta<typeof DocumentationPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const LocalWorker: Story = documentationStory("install-worker", "Install a verified worker, discover the local repository and connect a model account.");
export const FirstRequest: Story = documentationStory("first-feature", "Follow one request from installation through queue, evidence and human review.");
export const CompleteSystem: Story = documentationStory("system-setup", "Plan and run an independent multi-line system from one YAML definition.");
