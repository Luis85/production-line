import type { ProviderAuthenticationMode } from './provider-capabilities.js';
import type { ModelEffort } from './model-effort.js';
import type { FeatureRequestReference } from './feature-request-reference.js';
import type { ConversationModel } from './conversation.js';
import type { DevelopmentRuntime } from './development.js';
import type { ToolWorktreeIdentity } from './tool-runtime.js';

export type ProviderId = 'codex-cli' | 'claude-cli' | 'openai-api' | 'anthropic-api' | 'cursor-cli';
/** Private worker configuration; credentials never belong in public observations or model dispatches. */
export interface ProviderConnection { id: ProviderId; executable: string; model: string; effort?: ModelEffort; apiKey: string; authenticationMode?: ProviderAuthenticationMode; instruction?: string; }
export const providerIds: ProviderId[] = ['codex-cli', 'claude-cli', 'openai-api', 'anthropic-api', 'cursor-cli'];
export const providerLabels: Record<ProviderId, string> = { 'codex-cli': 'Codex CLI', 'claude-cli': 'Claude Code CLI', 'openai-api': 'OpenAI · API', 'anthropic-api': 'Claude · API', 'cursor-cli': 'Cursor CLI' };
export function providerReady(connection: ProviderConnection) { return connection.authenticationMode !== 'legacy' && (connection.authenticationMode !== 'api-key' || !!connection.apiKey) && (connection.id.endsWith('-cli') ? !!connection.executable : !!connection.apiKey && !!connection.model); }
/** The application selects execution scope. The adapter resolves storage and current tool grants. */
export interface ModelScope { sessionId?: string; feature?: FeatureRequestReference; baseCommit?: string; worktree?: string; worktreeIdentity?: ToolWorktreeIdentity; development?: DevelopmentRuntime; }
export type ModelFactory = (connection: ProviderConnection, scope?: ModelScope) => ConversationModel | undefined;

/** Cursor can route models from either family; existing adapters retain their explicit family. */
export function providerSupportsDefinition(provider: string, family: string): boolean {
  return !family || provider === 'cursor-cli' && ['openai', 'anthropic'].includes(family)
    || (provider === 'codex-cli' || provider === 'openai-api') && family === 'openai'
    || (provider === 'claude-cli' || provider === 'anthropic-api') && family === 'anthropic';
}
