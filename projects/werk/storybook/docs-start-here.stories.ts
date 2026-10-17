import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { DocumentationPage, documentationStory } from './documentation';
const meta = { title: "Documentation/Start here", component: DocumentationPage, parameters: { layout: 'fullscreen' } } satisfies Meta<typeof DocumentationPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Welcome: Story = documentationStory("start", "Choose a setup path for a local worker, distributed team, system operator or frontend contributor.");
export const ExecutionModes: Story = documentationStory("execution-modes", "Compare real local worker execution, shared feature intake and simulated system assignments.");
