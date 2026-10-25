import type { TaskOverviewItem } from './task-overview';
import type { SessionView } from '../application/workspace-view';
interface WorkspaceModeContext { orchestratorUrl?: string | null; chat?: { configured: boolean }; }
/** Assignment execution mode describes configured fleet work, never a local provider selection. */
export function assignmentModeLabel(orchestratorUrl: string | null | undefined, mode: 'mock' | 'cli' | undefined): string | null {
  if (!orchestratorUrl) return null;
  return mode === 'cli' ? 'Assignments: live Codex' : mode === 'mock' ? 'Assignments: simulation' : 'Assignment mode unavailable';
}
/** Standalone setup stays visible before a provider is ready; local-capable fleet workers also support it. */
export function supportsLocalRequestSetup(environment: WorkspaceModeContext | null, state?: string): boolean {
  return !!environment && (state === 'standalone' || environment.chat?.configured === true);
}

/** The initial empty conversation is a place to type, not evidence that a request has been authored. */
export function hasRequestActivity(items: readonly TaskOverviewItem[], records: SessionView['records'] | undefined): boolean {
  return items.some(item => {
    const record = records?.find(value => value.id === item.sessionId);
    const placeholder = item.id === 'session:default' && item.sessionId === 'default' && item.taskId === 'default' && item.source === 'chat' && item.status === 'draft' && !item.requestId && !item.deliveryRunId && !item.localTaskId && !item.modelSnapshot &&
      record?.id === 'default' && record.taskId === 'default' && record.kind === 'chat' && record.title === 'New task' && record.status === 'draft' && record.messages === 0 && !record.busy && !record.requestId && (!record.feature || record.feature.source === 'interaction') &&
      record.interaction?.totalTurns === 0 && !record.interaction.latestTurn && !record.interaction.pending;
    return !placeholder;
  });
}
