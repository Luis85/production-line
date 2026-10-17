import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { DocumentationPage, documentationStory } from './documentation';
const meta = { title: "Documentation/Work with requests", component: DocumentationPage, parameters: { layout: 'fullscreen' } } satisfies Meta<typeof DocumentationPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Workspace: Story = documentationStory("worker-workspace", "Use the taskboard, queue, metrics, history and settings.");
export const Implementation: Story = documentationStory("implement-feature", "Authorize a worktree implementation, required checks and a reviewable result.");
export const TeamAuthoring: Story = documentationStory("team-requests", "Create template-based Obsidian requests without connecting to the worker.");
export const SharedQueue: Story = documentationStory("shared-intake", "Connect shared Git intake with readiness rules, lifecycle notes and review branches.");
