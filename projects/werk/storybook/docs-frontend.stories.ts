import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { DocumentationPage, documentationStory } from './documentation';
const meta = { title: "Documentation/Frontend reference", component: DocumentationPage, parameters: { layout: 'fullscreen' } } satisfies Meta<typeof DocumentationPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Architecture: Story = documentationStory("frontend", "Understand component responsibilities, state boundaries, shared adapters and builds.");
export const ComponentsAndStories: Story = documentationStory("storybook", "Build component examples and qualify desktop/mobile documentation.");
