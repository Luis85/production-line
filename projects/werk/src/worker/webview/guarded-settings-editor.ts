import { computed, reactive, shallowReactive, watch } from 'vue';

export interface GuardedSettingsPorts<Saved, Command> {
  saved: () => Saved | null;
  unlocked: () => boolean;
  epoch: () => number;
  write: (command: Command) => Promise<Saved | undefined>;
  refresh: () => Promise<unknown>;
}
interface SettingsForm<Saved, Draft, Command> {
  empty: () => Draft;
  fields: (saved: Saved) => Draft;
  value: (draft: Draft, baseline: Saved) => Saved;
  validate: (draft: Draft, baseline: Saved | null) => string;
  command: (value: Saved, baseline: Saved) => Command;
  savedMessage: string;
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A guarded form owns its draft and exact unconfirmed command across polling and route changes. */
export function createGuardedSettingsEditor<Saved extends object, Draft extends object, Command extends object>(ports: GuardedSettingsPorts<Saved, Command>, form: SettingsForm<Saved, Draft, Command>) {
  const draft = shallowReactive({ values: reactive(form.empty()) as Draft, baseline: null as Saved | null, busy: false, checking: false, error: '', notice: '', uncertain: null as { command: Command; value: Saved } | null });
  const dirty = computed(() => !!draft.baseline && !same(draft.values, form.fields(draft.baseline)));
  const stale = computed(() => !!draft.baseline && !!ports.saved() && !same(draft.baseline, ports.saved()));
  const locked = computed(() => !ports.unlocked() || draft.busy || draft.checking || !!draft.uncertain);
  const validation = computed(() => form.validate(draft.values, draft.baseline));
  const canSave = computed(() => !!ports.saved() && dirty.value && !stale.value && !locked.value && !validation.value);
  function accept(saved: Saved, notice = '') {
    draft.values = reactive(form.fields(saved)) as Draft; draft.baseline = copy(saved);
    draft.uncertain = null; draft.error = ''; draft.notice = notice;
  }
  function observe() {
    const saved = ports.saved();
    if (!saved || !ports.unlocked() || draft.busy) return;
    if (draft.uncertain && same(saved, draft.uncertain.value)) accept(saved, form.savedMessage);
    else if (!draft.baseline || !dirty.value && !draft.uncertain && !same(draft.baseline, saved)) accept(saved);
  }
  const stopSaved = watch(() => [ports.unlocked(), JSON.stringify(ports.saved())], observe, { immediate: true });
  const stopEpoch = watch(ports.epoch, () => Object.assign(draft, { values: reactive(form.empty()) as Draft, baseline: null, busy: false, checking: false, error: '', notice: '', uncertain: null }), { flush: 'sync' });
  function reload() { if (ports.unlocked() && !draft.busy && !draft.checking && ports.saved()) accept(ports.saved()!); }
  async function check() {
    if (!ports.unlocked() || draft.busy || draft.checking) return;
    const epoch = ports.epoch(); draft.checking = true;
    try { await ports.refresh(); if (epoch === ports.epoch()) observe(); }
    catch (error) { if (epoch === ports.epoch() && ports.unlocked()) draft.error = (error as Error).message; }
    finally { if (epoch === ports.epoch()) draft.checking = false; }
  }
  async function send(submitted: { command: Command; value: Saved }) {
    if (!ports.unlocked() || draft.busy || draft.checking) return;
    const epoch = ports.epoch(), fieldsAtSubmit = JSON.stringify(draft.values);
    draft.busy = true; draft.error = ''; draft.notice = ''; draft.uncertain = copy(submitted);
    try {
      const saved = await ports.write(copy(submitted.command));
      if (epoch !== ports.epoch() || !ports.unlocked()) return;
      if (!saved) { draft.error = 'The save could not be confirmed. Refresh saved settings or retry the same save.'; return; }
      if (JSON.stringify(draft.values) === fieldsAtSubmit) accept(saved, form.savedMessage);
      else { draft.baseline = copy(saved); draft.uncertain = null; draft.notice = form.savedMessage + ' Your newer edits are not saved.'; }
    } catch (error) {
      if (epoch !== ports.epoch() || !ports.unlocked()) return;
      const status = (error as Error & { status?: number }).status;
      draft.error = (error as Error).message;
      if (status && status >= 400 && status < 500 && status !== 401) draft.uncertain = null;
      if (status === 409) {
        try { await ports.refresh(); } catch { /* Keep the conflict and submitted draft available for explicit recovery. */ }
        if (epoch === ports.epoch() && ports.unlocked() && same(ports.saved(), submitted.value)) accept(ports.saved()!, form.savedMessage);
      }
    } finally { if (epoch === ports.epoch()) { draft.busy = false; observe(); } }
  }
  async function save() {
    if (!canSave.value || !draft.baseline) return;
    const value = form.value(draft.values, draft.baseline);
    await send({ value, command: form.command(value, draft.baseline) });
  }
  async function retry() { if (draft.uncertain) await send(draft.uncertain); }
  return { draft, dirty, stale, locked, validation, canSave, save, retry, reload, check, dispose: () => { stopSaved(); stopEpoch(); } };
}
