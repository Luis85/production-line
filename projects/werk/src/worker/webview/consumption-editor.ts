import { computed, reactive, toRefs } from 'vue';
import { workerAllowance as calculateWorkerAllowance, type ConsumptionPolicy } from '../application/consumption';
import { createGuardedSettingsEditor, type GuardedSettingsPorts } from './guarded-settings-editor';

export interface ConsumptionCommand { consumption: ConsumptionPolicy; expectedConsumption: ConsumptionPolicy; }
type EditorPorts = Omit<GuardedSettingsPorts<ConsumptionPolicy, ConsumptionCommand>, 'saved'> & { policy: () => ConsumptionPolicy | null };
interface ConsumptionDraft { enabled: boolean; period: 'daily' | 'monthly'; allowance: string | number; workerPercent: string | number; perRunReservation: string | number; }
const initial = (): ConsumptionDraft => ({ enabled: false, period: 'daily', allowance: '1000000', workerPercent: '50', perRunReservation: '10000' });
const fields = (policy: ConsumptionPolicy): ConsumptionDraft => ({ enabled: policy.enabled, period: policy.period, allowance: String(policy.allowance), workerPercent: String(policy.workerPercent), perRunReservation: String(policy.perRunReservation) });
const value = (draft: ConsumptionDraft): ConsumptionPolicy => ({ enabled: draft.enabled, period: draft.period, allowance: Number(draft.allowance), workerPercent: Number(draft.workerPercent), perRunReservation: Number(draft.perRunReservation) });
const draftKey = (draft: ConsumptionDraft) => JSON.stringify({ ...draft, allowance: String(draft.allowance), workerPercent: String(draft.workerPercent), perRunReservation: String(draft.perRunReservation) });

/** Consumption supplies its policy and fields; guarded saves own polling, recovery and access fencing. */
export function createConsumptionEditor(ports: EditorPorts) {
  const editor = createGuardedSettingsEditor<ConsumptionPolicy, ConsumptionDraft, ConsumptionCommand>({
    ...ports,
    saved: () => { const policy = ports.policy(); return policy ? value(policy) : null; },
    write: async command => { const policy = await ports.write(command); return policy ? value(policy) : undefined; },
  }, {
    empty: initial, fields, value, draftKey,
    validate: draft => {
      if (!['daily', 'monthly'].includes(draft.period)) return 'Choose a daily or monthly allowance.';
      const positiveInteger = (input: string | number) => /^\d+$/.test(String(input)) && Number.isSafeInteger(Number(input)) && Number(input) > 0;
      if (!positiveInteger(draft.allowance)) return 'Enter a total allowance as a positive whole number of tokens.';
      if (!positiveInteger(draft.workerPercent) || Number(draft.workerPercent) > 100) return 'Enter a worker share from 1 to 100 percent.';
      if (!positiveInteger(draft.perRunReservation)) return 'Enter a reservation as a positive whole number of tokens.';
      if (Number(draft.perRunReservation) > calculateWorkerAllowance(value(draft))) return 'Keep the model call reservation no larger than the worker allocation.';
      return '';
    },
    command: (consumption, expectedConsumption) => ({ consumption, expectedConsumption }),
    savedMessage: 'Consumption limits saved. Recorded usage is kept.',
    unconfirmedMessage: 'The save could not be confirmed. Check saved limits before making another change.',
    newerEditsMessage: 'Consumption limits saved. Your newer edits are not saved.',
  });
  // Preserve the existing component's flat writable bindings while the shared editor replaces field snapshots.
  const field = <Key extends keyof ConsumptionDraft>(key: Key) => computed({ get: () => editor.draft.values[key], set: (next: ConsumptionDraft[Key]) => { editor.draft.values[key] = next; } });
  const draft = reactive({
    ...toRefs(editor.draft),
    enabled: field('enabled'), period: field('period'), allowance: field('allowance'), workerPercent: field('workerPercent'), perRunReservation: field('perRunReservation'),
    uncertain: computed(() => editor.draft.uncertain?.command ?? null),
  });
  const workerAllowance = computed(() => {
    const policy = value(editor.draft.values);
    return Number.isSafeInteger(policy.allowance) && policy.allowance > 0 && Number.isSafeInteger(policy.workerPercent) && policy.workerPercent >= 1 && policy.workerPercent <= 100 ? calculateWorkerAllowance(policy) : null;
  });
  return { ...editor, draft, workerAllowance };
}
