import type { WorkerSettingsView } from '../application/workspace-view';
import { DEFAULT_MAX_TOOL_CALLS, MAX_TOOL_CALLS, DEFAULT_COMMAND_TIMEOUT_MS, MIN_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS, candidateInspectionBounds, type CandidateInspectionLimits } from '../application/execution-policy';
import { createGuardedSettingsEditor, type GuardedSettingsPorts } from './guarded-settings-editor';
export interface QueuePolicy { maxParallel: number; queueCapacity: number; orchestratorQueue: number; order: 'fifo' | 'priority'; }
export interface QueueSettingsCommand { board: QueuePolicy; expectedBoard: QueuePolicy; }
interface QueueDraft { maxParallel: string | number; queueCapacity: string | number; orchestratorQueue: string | number; order: 'fifo' | 'priority'; }
export function queuePolicy(settings: WorkerSettingsView | null): QueuePolicy | null { return settings ? { maxParallel: settings.board.maxParallel, queueCapacity: settings.board.queueCapacity, orchestratorQueue: settings.board.orchestratorQueue, order: settings.board.order } : null; }
export function createQueueSettingsEditor(ports: GuardedSettingsPorts<QueuePolicy, QueueSettingsCommand>) {
  return createGuardedSettingsEditor<QueuePolicy, QueueDraft, QueueSettingsCommand>(ports, {
    empty: () => ({ maxParallel: 1, queueCapacity: 16, orchestratorQueue: 0, order: 'fifo' }),
    fields: saved => ({ ...saved }),
    value: draft => ({ maxParallel: Number(draft.maxParallel), queueCapacity: Number(draft.queueCapacity), orchestratorQueue: Number(draft.orchestratorQueue), order: draft.order }),
    validate: draft => {
      const capacity = Number(draft.queueCapacity), remote = Number(draft.orchestratorQueue), parallel = Number(draft.maxParallel);
      if (!String(draft.maxParallel).trim() || !Number.isInteger(parallel) || parallel < 1 || parallel > 8) return 'Choose 1 to 8 shared execution slots.';
      if (!String(draft.queueCapacity).trim() || !Number.isInteger(capacity) || capacity < 1 || capacity > 64) return 'Choose a chat and file-task capacity from 1 to 64 tasks.';
      if (!String(draft.orchestratorQueue).trim() || !Number.isInteger(remote) || remote < 0 || remote > 64) return 'Choose 0 to 64 extra orchestrator queue places.';
      return ['fifo', 'priority'].includes(draft.order) ? '' : 'Choose a file-task and assignment order.';
    },
    command: (value, baseline) => ({ board: value, expectedBoard: baseline }),
    savedMessage: 'Queue settings saved. Accepted work is kept.',
  });
}
export interface DurationPolicy extends CandidateInspectionLimits { longRunningMs: number; maxRuntimeMs: number; maxToolCalls: number; commandTimeoutMs: number; fromEnvironment: boolean; }
export interface DurationSettingsCommand {
  resources: { longRunningMs: number };
  execution: { maxRuntimeMs?: number; maxToolCalls: number; commandTimeoutMs: number } & CandidateInspectionLimits;
  expectedDuration: { longRunningMs: number; maxRuntimeMs: number };
  expectedToolBudget: { maxToolCalls: number; commandTimeoutMs: number };
  expectedCandidateInspection: CandidateInspectionLimits;
}
interface DurationDraft { sourceMiB: string | number; sourceFiles: string | number; fileMiB: string | number; warningHours: string | number; maximumHours: string | number; maxToolCalls: string | number; commandSeconds: string | number; }
export function durationPolicy(settings: WorkerSettingsView | null): DurationPolicy | null { return settings ? { longRunningMs: settings.resources.longRunningMs, maxRuntimeMs: settings.execution.maxRuntimeMs, maxToolCalls: settings.execution.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS, commandTimeoutMs: settings.execution.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, ...inspectionPolicy(settings.execution), fromEnvironment: settings.executionSource === 'environment' } : null; }
const MIB = 1024 * 1024;
const inspectionPolicy = (saved: Partial<CandidateInspectionLimits>): CandidateInspectionLimits => ({
  candidateSourceMaxBytes: saved.candidateSourceMaxBytes ?? candidateInspectionBounds.candidateSourceMaxBytes.default,
  candidateSourceMaxFiles: saved.candidateSourceMaxFiles ?? candidateInspectionBounds.candidateSourceMaxFiles.default,
  candidateFileMaxBytes: saved.candidateFileMaxBytes ?? candidateInspectionBounds.candidateFileMaxBytes.default,
});
const inspectionFields = (saved: CandidateInspectionLimits) => ({ sourceMiB: saved.candidateSourceMaxBytes / MIB, sourceFiles: saved.candidateSourceMaxFiles, fileMiB: saved.candidateFileMaxBytes / MIB });
const inspectionValue = (draft: DurationDraft): CandidateInspectionLimits => ({ candidateSourceMaxBytes: Number(draft.sourceMiB) * MIB, candidateSourceMaxFiles: Number(draft.sourceFiles), candidateFileMaxBytes: Number(draft.fileMiB) * MIB });
const milliseconds = (hours: string | number) => Math.round(Number(hours) * 3600000);
export function createDurationSettingsEditor(ports: GuardedSettingsPorts<DurationPolicy, DurationSettingsCommand>) {
  return createGuardedSettingsEditor<DurationPolicy, DurationDraft, DurationSettingsCommand>(ports, {
    empty: () => ({ ...inspectionFields(inspectionPolicy({})), warningHours: 1, maximumHours: 6, maxToolCalls: DEFAULT_MAX_TOOL_CALLS, commandSeconds: DEFAULT_COMMAND_TIMEOUT_MS / 1000 }),
    fields: saved => ({ ...inspectionFields(saved), warningHours: saved.longRunningMs / 3600000, maximumHours: saved.maxRuntimeMs / 3600000, maxToolCalls: saved.maxToolCalls, commandSeconds: saved.commandTimeoutMs / 1000 }),
    value: (draft, baseline) => ({ longRunningMs: milliseconds(draft.warningHours), maxRuntimeMs: baseline.fromEnvironment ? baseline.maxRuntimeMs : milliseconds(draft.maximumHours), maxToolCalls: Number(draft.maxToolCalls), commandTimeoutMs: Math.round(Number(draft.commandSeconds) * 1000), ...inspectionValue(draft), fromEnvironment: baseline.fromEnvironment }),
    validate: (draft, baseline) => {
      for (const hours of [draft.warningHours, ...(baseline?.fromEnvironment ? [] : [draft.maximumHours])]) {
        const ms = milliseconds(hours);
        if (!String(hours).trim() || !Number.isFinite(Number(hours)) || !Number.isSafeInteger(ms) || ms < 1000 || ms > 86400000) return 'Enter a duration from one second to 24 hours, expressed in hours.';
      }
      const calls = Number(draft.maxToolCalls), timeout = Math.round(Number(draft.commandSeconds) * 1000);
      if (!String(draft.maxToolCalls).trim() || !Number.isSafeInteger(calls) || calls < 1 || calls > MAX_TOOL_CALLS) return 'Choose a whole-number tool-call limit from 1 to ' + MAX_TOOL_CALLS + '.';
      if (!String(draft.commandSeconds).trim() || !Number.isFinite(Number(draft.commandSeconds)) || !Number.isSafeInteger(timeout) || timeout < MIN_COMMAND_TIMEOUT_MS || timeout > MAX_COMMAND_TIMEOUT_MS) return 'Enter a command timeout from 1 to 3,600 seconds.';
      const inspection = inspectionValue(draft);
      const fields = [
        ['sourceMiB', 'candidateSourceMaxBytes', 'Enter a total source limit from 1 to 1,024 MiB, in whole bytes.'],
        ['sourceFiles', 'candidateSourceMaxFiles', 'Enter a whole-number file limit from 1 to 200,000.'],
        ['fileMiB', 'candidateFileMaxBytes', 'Enter an individual file limit from 0.0625 to 256 MiB, in whole bytes.'],
      ] as const;
      for (const [field, key, message] of fields) {
        const { minimum, maximum } = candidateInspectionBounds[key], value = inspection[key];
        if (!String(draft[field]).trim() || !Number.isSafeInteger(value) || value < minimum || value > maximum) return message;
      }
      if (inspection.candidateFileMaxBytes > inspection.candidateSourceMaxBytes) return 'The individual file limit cannot exceed the total source limit.';
      return '';
    },
    command: (value, baseline) => ({ resources: { longRunningMs: value.longRunningMs }, execution: { ...inspectionPolicy(value), ...(!baseline.fromEnvironment ? { maxRuntimeMs: value.maxRuntimeMs } : {}), maxToolCalls: value.maxToolCalls, commandTimeoutMs: value.commandTimeoutMs }, expectedDuration: { longRunningMs: baseline.longRunningMs, maxRuntimeMs: baseline.maxRuntimeMs }, expectedToolBudget: { maxToolCalls: baseline.maxToolCalls, commandTimeoutMs: baseline.commandTimeoutMs }, expectedCandidateInspection: inspectionPolicy(baseline) }),
    savedMessage: 'Execution limits saved. New attempts use these limits.',
  });
}
