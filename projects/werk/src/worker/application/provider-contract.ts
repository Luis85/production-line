import type { ConversationModel } from './conversation.js';
import type { ToolWorktreeIdentity } from './tool-runtime.js';

export type ProviderId = 'codex-cli' | 'claude-cli' | 'openai-api' | 'anthropic-api';
/** Private worker configuration; credentials never belong in public observations or model dispatches. */
export interface ProviderConnection { id: ProviderId; executable: string; model: string; apiKey: string; instruction?: string; }
export const providerIds: ProviderId[] = ['codex-cli', 'claude-cli', 'openai-api', 'anthropic-api'];
export const providerLabels: Record<ProviderId, string> = { 'codex-cli': 'Codex CLI', 'claude-cli': 'Claude Code CLI', 'openai-api': 'OpenAI · API', 'anthropic-api': 'Claude · API' };
export function providerReady(connection: ProviderConnection) { return connection.id.endsWith('-cli') ? !!connection.executable : !!connection.apiKey && !!connection.model; }
/** The application selects execution scope. The adapter resolves storage and current tool grants. */
export interface ModelScope { sessionId?: string; worktree?: string; worktreeIdentity?: ToolWorktreeIdentity; }
export type ModelFactory = (connection: ProviderConnection, scope?: ModelScope) => ConversationModel | undefined;
