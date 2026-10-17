import { computed, reactive, ref, watch } from 'vue';
import type { SharedIntakeConfig, SharedIntakeNote, SharedIntakeUpdate, SharedIntakeView } from '../application/shared-intake-contract';
interface Ports {
  unlocked: () => boolean;
  epoch: () => number;
  repositories: () => { id: string }[];
  read: () => Promise<SharedIntakeView>;
  write: (command: SharedIntakeUpdate | { action: 'sync' }) => Promise<SharedIntakeView>;
  note: (id: string) => Promise<SharedIntakeNote>;
}
export const defaultSharedIntakeConfig = (): SharedIntakeConfig => ({ enabled: false, repositoryId: '', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 5000 });
const json = (value: unknown) => JSON.stringify(value);
const same = (a: SharedIntakeConfig, b: SharedIntakeConfig) => (Object.keys(a) as (keyof SharedIntakeConfig)[]).every(key => a[key] === b[key]);
export function createSharedIntakeEditor(ports: Ports) {
  const view = ref<SharedIntakeView | null>(null);
  const draft = reactive({ config: defaultSharedIntakeConfig(), revision: -1, baseline: '', loading: false, saving: false, syncing: false, error: '', notice: '', uncertain: null as SharedIntakeUpdate | null, note: null as SharedIntakeNote | null, noteId: '', noteLoading: false, noteError: '' });
  let generation = 0, noteGeneration = 0;
  let pendingRead: { promise: Promise<void> } | null = null;
  const dirty = computed(() => draft.revision >= 0 && json(draft.config) !== draft.baseline);
  const stale = computed(() => draft.revision >= 0 && !!view.value && draft.revision !== view.value.revision);
  const busy = computed(() => draft.loading || draft.saving || draft.syncing);
  const validation = computed(() => {
    if (!draft.config.enabled) return '';
    if (!ports.repositories().some(item => item.id === draft.config.repositoryId)) return 'Choose a repository assigned to this worker.';
    if (!draft.config.remote.trim() || !draft.config.branch.trim()) return 'Enter the Git remote name and shared branch.';
    const path = draft.config.workflowPath.trim();
    if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\') || path.split('/').some(part => !part || part === '..' || part === '.') || /[\x00-\x1f\x7f]/.test(path)) return 'Use a repository-relative workflow file path without parent directories.';
    if (!Number.isInteger(draft.config.pollMs) || draft.config.pollMs < 1000 || draft.config.pollMs > 300000) return 'Set the check interval between 1 and 300 seconds.';
    return '';
  });
  const canSave = computed(() => ports.unlocked() && !!view.value?.canEdit && !busy.value && !draft.uncertain && dirty.value && !stale.value && !validation.value);
  const canSync = computed(() => ports.unlocked() && !busy.value && !draft.uncertain && !!view.value && (view.value.config.enabled || view.value.requests.some(item => item.isLocal)));
  const clearBlockedReason = computed(() => {
    if (!view.value?.config.repositoryId) return 'No shared connection is saved.';
    if (view.value.config.enabled) return 'Turn off accepting new shared requests and save before clearing the connection.';
    if (!view.value.canEdit) return view.value.blockedReason || 'Pause new starts and finish or stop queued and running work before clearing the connection.';
    if (view.value.requests.some(item => item.isLocal && (!['ready_for_review', 'failed', 'cancelled'].includes(item.status) || item.publication !== 'synced'))) return 'Finish owned requests and publish their notes before clearing the connection.';
    if (dirty.value || stale.value) return 'Save or reload the current edits before clearing the connection.';
    return '';
  });
  const canClear = computed(() => ports.unlocked() && !busy.value && !draft.uncertain && !clearBlockedReason.value);
  function clearConnection() {
    if (!canClear.value) return;
    draft.config = { ...draft.config, enabled: false, repositoryId: '' };
    draft.notice = 'Connection removal is staged. Save to clear it. Local ready files may enter the queue when new starts resume.';
    draft.error = '';
  }
  function accept(next: SharedIntakeView, notice = '') {
    draft.config = { ...next.config }; draft.revision = next.revision; draft.baseline = json(draft.config); draft.uncertain = null; draft.notice = notice;
  }
  function observe(next: SharedIntakeView) {
    const previous = view.value;
    view.value = next;
    if (previous && !same(previous.config, next.config)) closeNote();
    if (draft.uncertain) {
      const submitted = draft.uncertain;
      draft.uncertain = null;
      if (same(next.config, submitted.config)) { accept(next, 'Saved connection confirmed.'); draft.error = ''; }
      else draft.error = 'The saved connection differs from your draft. Your edits are retained; review the current revision before saving again.';
    } else if (draft.revision < 0 || !dirty.value) accept(next, draft.notice);
  }
  /** Polls keep existing controls steady; an explicit refresh may join the same read. */
  async function load(options: { background?: boolean } = {}) {
    if (!ports.unlocked() || draft.saving || draft.syncing) return;
    if (pendingRead) {
      if (!options.background) draft.loading = true;
      return pendingRead.promise;
    }
    const current = generation, epoch = ports.epoch();
    const reading = { promise: Promise.resolve() };
    pendingRead = reading;
    draft.loading = !options.background || !view.value;
    reading.promise = (async () => {
      try { const next = await ports.read(); if (current === generation && epoch === ports.epoch() && ports.unlocked()) { draft.error = ''; observe(next); } }
      catch (error) { if (current === generation && epoch === ports.epoch() && ports.unlocked()) draft.error = (error as Error).message; }
      finally { if (pendingRead === reading) { pendingRead = null; draft.loading = false; } }
    })();
    return reading.promise;
  }
  function invalidateRead() { generation++; pendingRead = null; draft.loading = false; return generation; }
  function reloadSaved() { if (!busy.value && ports.unlocked() && view.value) { accept(view.value); draft.error = ''; } }
  async function save() {
    if (!canSave.value) return;
    const command: SharedIntakeUpdate = { action: 'configure', expectedRevision: draft.revision, config: { ...draft.config, remote: draft.config.remote.trim(), branch: draft.config.branch.trim(), workflowPath: draft.config.workflowPath.trim() } };
    const current = invalidateRead(), epoch = ports.epoch(); draft.saving = true; draft.error = ''; draft.notice = ''; draft.uncertain = command;
    try {
      const next = await ports.write(command);
      if (current === generation && epoch === ports.epoch() && ports.unlocked()) { view.value = next; closeNote(); accept(next, command.config.repositoryId ? 'Shared intake connection saved. Checked-in workflow files remain the source of request rules.' : 'Shared intake connection cleared. Local ready files may enter the queue when new starts resume.'); }
    } catch (error) {
      if (current !== generation || !ports.unlocked()) return;
      const status = (error as Error & { status?: number }).status;
      if (status && status >= 400 && status < 500 && status !== 401) draft.uncertain = null;
      draft.error = (error as Error).message;
    } finally { if (current === generation) draft.saving = false; }
  }
  async function sync() {
    if (!canSync.value) return;
    const current = invalidateRead(), epoch = ports.epoch(); draft.syncing = true; draft.error = ''; draft.notice = '';
    try { const next = await ports.write({ action: 'sync' }); if (current === generation && epoch === ports.epoch() && ports.unlocked()) { observe(next); draft.notice = next.state === 'error' ? '' : 'Shared request check finished. Review the publication and check results below.'; } }
    catch (error) { if (current === generation && ports.unlocked()) draft.error = (error as Error).message; }
    finally { if (current === generation) draft.syncing = false; }
  }
  async function openNote(id: string) {
    if (!ports.unlocked() || !view.value?.requests.some(item => item.id === id && item.reviewNote)) return;
    const current = ++noteGeneration, epoch = ports.epoch(); draft.noteId = id; draft.note = null; draft.noteLoading = true; draft.noteError = '';
    try { const note = await ports.note(id); if (current === noteGeneration && epoch === ports.epoch() && ports.unlocked()) draft.note = note; }
    catch (error) { if (current === noteGeneration && ports.unlocked()) draft.noteError = (error as Error).message; }
    finally { if (current === noteGeneration) draft.noteLoading = false; }
  }
  function closeNote() { noteGeneration++; draft.noteId = ''; draft.note = null; draft.noteLoading = false; draft.noteError = ''; }
  const stopAccess = watch(ports.unlocked, unlocked => { if (!unlocked) { invalidateRead(); draft.saving = false; draft.syncing = false; view.value = null; closeNote(); } }, { flush: 'sync' });
  const stopEpoch = watch(ports.epoch, () => { invalidateRead(); view.value = null; closeNote(); Object.assign(draft, { config: defaultSharedIntakeConfig(), revision: -1, baseline: '', loading: false, saving: false, syncing: false, error: '', notice: '', uncertain: null }); }, { flush: 'sync' });
  return { view, draft, dirty, stale, busy, validation, canSave, canSync, canClear, clearBlockedReason, clearConnection, load, reloadSaved, save, sync, openNote, closeNote, dispose: () => { invalidateRead(); noteGeneration++; stopAccess(); stopEpoch(); } };
}
