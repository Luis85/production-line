import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { DocumentationPage, documentationStory } from './documentation';
const meta = { title: "Documentation/Architecture and contracts", component: DocumentationPage, parameters: { layout: 'fullscreen' } } satisfies Meta<typeof DocumentationPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Architecture: Story = documentationStory("architecture", "Review application boundaries and actual delivery capabilities.");
export const Api: Story = documentationStory("api", "Look up the current CLI and HTTP contracts.");
export const ReleaseQuality: Story = documentationStory("releases", "Verify release contents and the publication quality process.");
