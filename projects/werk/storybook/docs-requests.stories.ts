import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { DocumentationPage, documentationStory } from './documentation';
const meta = { title: "Documentation/Work with requests", component: DocumentationPage, parameters: { layout: 'fullscreen' } } satisfies Meta<typeof DocumentationPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Workspace: Story = documentationStory("worker-workspace", "Create Feature Requests through chat, follow their queue and evidence, and configure the worker.");
export const Implementation: Story = documentationStory("implement-feature", "Authorize a worktree implementation, required checks and a reviewable result.");
export const TeamAuthoring: Story = documentationStory("team-requests", "Create template-based Obsidian requests without connecting to the worker.");
export const SharedQueue: Story = documentationStory("shared-intake", "Use Markdown or webview authoring for one shared Feature Request lifecycle, from readiness to human review.");
