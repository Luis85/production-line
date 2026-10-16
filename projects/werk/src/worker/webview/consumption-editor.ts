import { computed, reactive, watch } from 'vue';
import { workerAllowance as calculateWorkerAllowance, type ConsumptionPolicy } from '../application/consumption';

export interface ConsumptionCommand { consumption: ConsumptionPolicy; expectedConsumption: ConsumptionPolicy; }
interface EditorPorts {
  policy: () => ConsumptionPolicy | null;
  unlocked: () => boolean;
  epoch: () => number;
  write: (command: ConsumptionCommand) => Promise<ConsumptionPolicy | undefined>;
  refresh: () => Promise<unknown>;
}
const copy = (policy: ConsumptionPolicy): ConsumptionPolicy => ({ enabled: policy.enabled, period: policy.period, allowance: policy.allowance, workerPercent: policy.workerPercent, perRunReservation: policy.perRunReservation });
const key = (policy: ConsumptionPolicy | null) => policy ? JSON.stringify(copy(policy)) : '';
const initial = () => ({ enabled: false, period: 'daily' as const, allowance: '1000000' as string | number, workerPercent: '50' as string | number, perRunReservation: '10000' as string | number });
const fields = (policy: ConsumptionPolicy) => ({ enabled: policy.enabled, period: policy.period, allowance: String(policy.allowance), workerPercent: String(policy.workerPercent), perRunReservation: String(policy.perRunReservation) });

/** Polling updates saved values without replacing an operator's unsubmitted edits. */
export function createConsumptionEditor(ports: EditorPorts) {
  const draft = reactive({ ...initial(), period: 'daily' as 'daily' | 'monthly', baseline: null as ConsumptionPolicy | null, busy: false, checking: false, error: '', notice: '', uncertain: null as ConsumptionCommand | null });
  const values = () => ({ enabled: draft.enabled, period: draft.period, allowance: String(draft.allowance), workerPercent: String(draft.workerPercent), perRunReservation: String(draft.perRunReservation) });
  const dirty = computed(() => !!draft.baseline && JSON.stringify(values()) !== JSON.stringify(fields(draft.baseline)));
  const stale = computed(() => !!draft.baseline && !!ports.policy() && key(draft.baseline) !== key(ports.policy()));
  const locked = computed(() => !ports.unlocked() || draft.busy || draft.checking || !!draft.uncertain);
  const currentPolicy = (): ConsumptionPolicy => ({ enabled: draft.enabled, period: draft.period, allowance: Number(draft.allowance), workerPercent: Number(draft.workerPercent), perRunReservation: Number(draft.perRunReservation) });
  const validation = computed(() => {
    if (!['daily', 'monthly'].includes(draft.period)) return 'Choose a daily or monthly allowance.';
    const positiveInteger = (value: string | number) => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
    if (!positiveInteger(draft.allowance)) return 'Enter a total allowance as a positive whole number of tokens.';
    if (!positiveInteger(draft.workerPercent) || Number(draft.workerPercent) > 100) return 'Enter a worker share from 1 to 100 percent.';
    if (!positiveInteger(draft.perRunReservation)) return 'Enter a reservation as a positive whole number of tokens.';
    const allowance = calculateWorkerAllowance(currentPolicy());
    if (Number(draft.perRunReservation) > allowance) return 'Keep the model call reservation no larger than the worker allocation.';
    return '';
  });
  const workerAllowance = computed(() => {
    const policy = currentPolicy();
    return Number.isSafeInteger(policy.allowance) && policy.allowance > 0 && Number.isSafeInteger(policy.workerPercent) && policy.workerPercent >= 1 && policy.workerPercent <= 100 ? calculateWorkerAllowance(policy) : null;
  });
  const canSave = computed(() => !locked.value && !!ports.policy() && dirty.value && !stale.value && !validation.value);
  function accept(policy: ConsumptionPolicy, notice = '') {
    Object.assign(draft, fields(policy), { baseline: copy(policy), uncertain: null, error: '', notice });
  }
  function observe() {
    const policy = ports.policy();
    if (!policy || !ports.unlocked() || draft.busy) return;
    if (draft.uncertain && key(policy) === key(draft.uncertain.consumption)) accept(policy, 'Consumption limits saved. Recorded usage is kept.');
    else if (!draft.baseline || !dirty.value && !draft.uncertain && key(draft.baseline) !== key(policy)) accept(policy);
  }
  const stopPolicy = watch(() => [ports.unlocked(), key(ports.policy())], observe, { immediate: true });
  const stopEpoch = watch(ports.epoch, () => Object.assign(draft, initial(), { baseline: null, busy: false, checking: false, error: '', notice: '', uncertain: null }), { flush: 'sync' });
  function reload() { if (!draft.busy && !draft.checking && ports.unlocked() && ports.policy()) accept(ports.policy()!); }
  async function check() {
    if (!ports.unlocked() || draft.busy || draft.checking) return;
    const epoch = ports.epoch(); draft.checking = true;
    try { await ports.refresh(); if (epoch === ports.epoch()) observe(); }
    catch (failure) { if (epoch === ports.epoch() && ports.unlocked()) draft.error = (failure as Error).message; }
    finally { if (epoch === ports.epoch()) draft.checking = false; }
  }
  async function send(command: ConsumptionCommand) {
    if (!ports.unlocked() || draft.busy || draft.checking) return;
    const epoch = ports.epoch(), submittedValues = JSON.stringify(values());
    draft.busy = true; draft.error = ''; draft.notice = ''; draft.uncertain = command;
    try {
      const result = await ports.write({ consumption: copy(command.consumption), expectedConsumption: copy(command.expectedConsumption) });
      if (epoch !== ports.epoch() || !ports.unlocked()) return;
      if (result) {
        if (JSON.stringify(values()) === submittedValues) accept(result, 'Consumption limits saved. Recorded usage is kept.');
        else { draft.baseline = copy(result); draft.uncertain = null; draft.notice = 'Consumption limits saved. Your newer edits are not saved.'; }
      } else draft.error = 'The save could not be confirmed. Check saved limits before making another change.';
    } catch (failure) {
      if (epoch !== ports.epoch() || !ports.unlocked()) return;
      const status = (failure as Error & { status?: number }).status;
      draft.error = (failure as Error).message;
      if (status && status >= 400 && status < 500 && status !== 401) draft.uncertain = null;
      if (status === 409) {
        await ports.refresh();
        if (epoch === ports.epoch() && ports.unlocked() && key(ports.policy()) === key(command.consumption)) accept(ports.policy()!, 'Consumption limits saved. Recorded usage is kept.');
      }
    } finally { if (epoch === ports.epoch()) { draft.busy = false; observe(); } }
  }
  async function save() {
    if (!canSave.value || !draft.baseline) return;
    await send({ consumption: currentPolicy(), expectedConsumption: copy(draft.baseline) });
  }
  async function retry() { if (draft.uncertain) await send(draft.uncertain); }
  return { draft, dirty, stale, locked, validation, canSave, workerAllowance, reload, check, save, retry, dispose: () => { stopPolicy(); stopEpoch(); } };
}
