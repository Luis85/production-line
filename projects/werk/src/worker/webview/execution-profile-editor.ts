import { computed, reactive, watch } from 'vue';

import type { ExecutionProfile as EditableExecutionProfile, ExecutionProfilesView } from '../application/execution-profiles';
export type { ExecutionProfilesView };
export interface ProfileCommand { expectedConfigurationHash: string; profiles: EditableExecutionProfile[]; }
interface EditorPorts {
  view: () => ExecutionProfilesView | null;
  unlocked: () => boolean;
  epoch: () => number;
  write: (command: ProfileCommand) => Promise<ExecutionProfilesView | undefined>;
  refresh: () => Promise<unknown>;
}
const copy = (profiles: EditableExecutionProfile[]) => profiles.map(profile => ({ ...profile }));
const serialized = (profiles: EditableExecutionProfile[]) => JSON.stringify(profiles);

/** Keep unsent edits across polling and access expiry; explicit Lock clears the private draft. */
export function createExecutionProfileEditor(ports: EditorPorts) {
  const draft = reactive({ profiles: [] as EditableExecutionProfile[], baseline: '', hash: '', busy: false, checking: false, error: '', notice: '', uncertain: null as ProfileCommand | null });
  const dirty = computed(() => serialized(draft.profiles) !== draft.baseline);
  const stale = computed(() => !!draft.hash && !!ports.view() && draft.hash !== ports.view()!.configurationHash);
  const locked = computed(() => !ports.unlocked() || draft.busy || draft.checking || !!draft.uncertain || !!ports.view()?.pending);
  const validation = computed(() => {
    const view = ports.view();
    if (!view) return '';
    if (!draft.profiles.length) return 'Keep at least one execution profile.';
    if (draft.profiles.length > view.maxProfiles) return `This worker supports up to ${view.maxProfiles} execution profile${view.maxProfiles === 1 ? '' : 's'}.`;
    const ids = new Set<string>();
    for (const profile of draft.profiles) {
      const id = profile.id.trim();
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return 'Use 1–100 letters, numbers, underscores or hyphens for each profile ID.';
      if (ids.has(id)) return 'Give each execution profile a different ID.';
      ids.add(id);
      if (!view.allowedProviders.includes(profile.provider)) return 'Choose a provider supported by this worker’s execution mode.';
    }
    return '';
  });
  const canSave = computed(() => !locked.value && !!ports.view()?.canEdit && dirty.value && !stale.value && !validation.value);
  function accept(view: ExecutionProfilesView, message = '') {
    draft.profiles = copy(view.pending?.profiles ?? view.profiles);
    draft.baseline = serialized(draft.profiles); draft.hash = view.configurationHash;
    draft.uncertain = null; draft.error = ''; draft.notice = message;
  }
  function observe() {
    const view = ports.view();
    if (!ports.unlocked() || !view || draft.busy) return;
    if (draft.uncertain && serialized(view.pending?.profiles ?? view.profiles) === serialized(draft.uncertain.profiles)) {
      accept(view, view.pending ? 'Profiles saved. Waiting for the orchestrator to accept the update.' : 'Execution profiles saved. New assignments use these profiles.');
    } else if (!draft.hash || (!dirty.value && !draft.uncertain && (draft.hash !== view.configurationHash || draft.baseline !== serialized(view.pending?.profiles ?? view.profiles)))) accept(view);
  }
  const stopView = watch(() => [ports.unlocked(), JSON.stringify(ports.view())], observe, { immediate: true });
  const stopEpoch = watch(ports.epoch, () => {
    Object.assign(draft, { profiles: [], baseline: '', hash: '', busy: false, checking: false, error: '', notice: '', uncertain: null });
  }, { flush: 'sync' });
  async function check() {
    if (!ports.unlocked() || draft.busy || draft.checking) return;
    draft.checking = true;
    const epoch = ports.epoch();
    try { await ports.refresh(); if (epoch === ports.epoch()) observe(); }
    catch (failure) { if (epoch === ports.epoch() && ports.unlocked()) draft.error = (failure as Error).message; }
    finally { if (epoch === ports.epoch()) draft.checking = false; }
  }
  function reload() {
    if (locked.value || !ports.view()) return;
    accept(ports.view()!);
  }
  function add() {
    const view = ports.view();
    if (locked.value || !view || draft.profiles.length >= view.maxProfiles) return;
    const provider = view.allowedProviders[0];
    let number = draft.profiles.length + 1;
    while (draft.profiles.some(profile => profile.id === `${provider}-${number}`)) number++;
    draft.profiles.push({ id: `${provider}-${number}`, provider, mode: view.mode, maxParallel: 1 });
    draft.notice = '';
  }
  function remove(index: number) {
    if (!locked.value && draft.profiles.length > 1) { draft.profiles.splice(index, 1); draft.notice = ''; }
  }
  async function send(command: ProfileCommand) {
    if (!ports.unlocked() || draft.busy || draft.checking) return;
    const epoch = ports.epoch();
    draft.busy = true; draft.error = ''; draft.notice = ''; draft.uncertain = command;
    try {
      const result = await ports.write(command);
      if (epoch !== ports.epoch() || !ports.unlocked()) return;
      if (result) accept(result, result.pending ? 'Profiles saved. Waiting for the orchestrator to accept the update.' : 'Execution profiles saved. New assignments use these profiles.');
      else draft.error = 'The save could not be confirmed. Check saved profiles or retry the same save.';
    } catch (failure) {
      if (epoch !== ports.epoch() || !ports.unlocked()) return;
      const status = (failure as Error & { status?: number }).status;
      if (status && status >= 400 && status < 500 && status !== 401) draft.uncertain = null;
      draft.error = (failure as Error).message;
      if (status === 409) await ports.refresh();
    } finally { if (epoch === ports.epoch()) { draft.busy = false; observe(); } }
  }
  async function save() {
    if (!canSave.value) return;
    await send({ expectedConfigurationHash: draft.hash, profiles: draft.profiles.map(profile => ({ id: profile.id.trim(), provider: profile.provider, mode: ports.view()!.mode, maxParallel: 1 })) });
  }
  async function retry() { if (draft.uncertain) await send(draft.uncertain); }
  return { draft, dirty, stale, locked, validation, canSave, reload, add, remove, save, retry, check, dispose: () => { stopView(); stopEpoch(); } };
}
