import { validateFeatureRequestReference, type FeatureRequestReference } from './feature-request-reference.js';
import type { DefinitionSnapshot } from './definitions.js';
import { validateSnapshot } from './definitions.js';
import { validateModelSelection, type ModelSelection } from './model-selection.js';
import type { ProviderId } from './provider-contract.js';
import type { WorkerSettingsPort } from './workspace-ports.js';
import { identifier, text } from '../../shared/contracts.js';

export type TaskState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "waiting_input"
  | "escalated"
  | "needs_rework";
export interface SessionRecord {
  selection?: ModelSelection;
  feature?: FeatureRequestReference;
  definition?: DefinitionSnapshot;
  submissionHash?: string;
  /** A failed admission without accepted snapshots can never become a continuation. */
  continuationBlockedReason?: string;
  taskState?: TaskState;
  taskId: string;
  kind: "chat" | "local" | "orchestrator";
  id: string;
  title: string;
  provider: ProviderId;
  createdAt: string;
  archived: boolean;
}

export interface SessionCatalog {
  records: SessionRecord[];
  selected: string;
  changing: boolean;
}

/** Restore catalog metadata before loading provider-independent transcripts. */
export function restoreSessionCatalog(saved: string | undefined, settings: WorkerSettingsPort): SessionCatalog {
  const catalog: SessionCatalog = { records: [], selected: 'default', changing: false };
    if (saved !== undefined) {
      const value = JSON.parse(saved);
      if (
        !Array.isArray(value.records) ||
        !value.records.length ||
        value.records.length > 100 ||
        new Set(value.records.map((item: SessionRecord) => item.id)).size !==
          value.records.length
      )
        throw Error("Invalid sessions");
      for (const record of value.records) {
        identifier(record.id, "session");
        text(record.title, "Session title", 120);
        settings.provider(record.provider);
        if (record.feature) validateFeatureRequestReference(record.feature);
        if (record.continuationBlockedReason !== undefined) text(record.continuationBlockedReason, 'Continuation block reason', 1000);
        if (record.definition) {
          validateSnapshot(record.definition);
        }
        if (record.selection) {
          const selection = validateModelSelection(record.selection);
          if (selection.provider !== record.provider) throw Error('Invalid saved session model selection.');
        }
        if (
          typeof record.archived !== "boolean" ||
          !Number.isFinite(Date.parse(record.createdAt))
        )
          throw Error("Invalid session");
      }
      if (
        !value.records.some(
          (record: SessionRecord) =>
            record.id === value.selected && !record.archived,
        )
      )
        throw Error("Invalid selected session");
      catalog.records = value.records.map((record: SessionRecord) => ({
        ...record,
        taskId: record.taskId ?? record.id,
        kind: record.kind ?? "chat",
        taskState:
          record.kind === "orchestrator" &&
          ["running", "queued"].includes(record.taskState ?? "")
            ? "failed"
            : record.taskState,
      }));
      catalog.selected = value.selected;
    } else {
      catalog.records = [
        {
          id: "default",
          taskId: "default",
          kind: "chat",
          title: "New task",
          provider: settings.value.defaultProvider ?? "codex-cli",
          createdAt: new Date().toISOString(),
          archived: false,
        },
      ];
    }
  return catalog;
}
