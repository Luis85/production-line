import { modelSelection, selectedConnection, validateModelSelection, type ModelSelection } from './model-selection.js';
import type { SessionRecord, SessionCatalog } from './session-catalog.js';
import type { WorkerConversation } from './conversation.js';
import type { ProviderConnection } from './provider-contract.js';
import { definitionConnection, type DefinitionSnapshot } from './definitions.js';
import type { WorkerSettingsPort } from './workspace-ports.js';
import type { RequestJournal } from './journal-ports.js';
import { gateDigest } from './request-gates.js';
import { DomainError } from '../../shared/errors.js';

/** Recover accepted profiles; pristine placeholders must remain configurable before first admission. */
export function restoreSessionSelections(records: SessionRecord[], requests: Pick<RequestJournal, 'forSession'>): boolean {
  let changed = false;
  for (const record of records) {
    const request = requests.forSession(record.id);
    const accepted = request?.provider.id === record.provider
      ? validateModelSelection({ provider: record.provider, model: request.provider.model, effort: request.provider.effort ?? 'default' }) : undefined;
    if (record.selection) {
      const selected = validateModelSelection(record.selection);
      if (selected.provider !== record.provider || accepted && gateDigest(selected) !== gateDigest(accepted))
        throw new DomainError('conflict', 'Saved session selection differs from its accepted request. Restore the original session.');
    } else if (accepted) {
      record.selection = accepted;
      changed = true;
    }
  }
  return changed;
}
export function sessionConnection(settings: WorkerSettingsPort, record: SessionRecord) {
  const connection = settings.provider(record.provider);
  // Display-only sessions may have incomplete API configuration. Admission resolves it strictly.
  return record.selection ? selectedConnection(connection, record.selection, record.definition) : definitionConnection(connection, record.definition);
}
export function ensureSessionSelection(record: SessionRecord, selection: ModelSelection): boolean {
  const accepted = validateModelSelection(selection);
  if (record.provider !== accepted.provider || record.selection && gateDigest(record.selection) !== gateDigest(accepted))
    throw new DomainError('conflict', 'This session has a different accepted model selection.');
  if (record.selection) return false;
  record.selection = accepted;
  return true;
}

/** An unconfigured API placeholder is not an accepted Feature Request. */
export function draftSessionSelection(connection: ProviderConnection, input: { model?: unknown; effort?: unknown } = {}, definition?: DefinitionSnapshot): ModelSelection | undefined {
  const profile = definitionConnection(connection, definition);
  if (connection.id.endsWith('-api') && !profile.model && (input.model === undefined || input.model === '') && (input.effort === undefined || input.effort === '')) return undefined;
  return modelSelection(connection, input, definition);
}
interface SessionSelectionContext {
  catalog: SessionCatalog;
  settings: WorkerSettingsPort;
  instances: Map<string, WorkerConversation>;
  load(record: SessionRecord): Promise<void>;
  persist(): Promise<void>;
}
/** Pin defaults durably before the first message can create a request or incur model cost. */
export async function freezeSessionSelection(context: SessionSelectionContext, record: SessionRecord): Promise<void> {
  if (context.catalog.changing) throw new DomainError('conflict', 'Session change in progress. Retry the message when saving finishes.');
  // Legacy snapshots can retain an empty API model for display, but cannot admit new work.
  const accepted = modelSelection(sessionConnection(context.settings, record));
  if (record.selection) return;
  context.catalog.changing = true;
  const previous = context.instances.get(record.id);
  let persisted = false;
  record.selection = accepted;
  try {
    await context.load(record);
    await context.persist();
    persisted = true;
    await previous?.close();
  } catch (error) {
    if (!persisted) {
      delete record.selection;
      const replacement = context.instances.get(record.id);
      if (previous) context.instances.set(record.id, previous);
      else context.instances.delete(record.id);
      if (replacement !== previous) await replacement?.close().catch(() => {});
    }
    throw error;
  } finally { context.catalog.changing = false; }
}
