import { reactive, watch } from 'vue';
import type { FeatureTrackingNote } from '../application/feature-tracking';
interface Ports {
  sessionId: () => string; revision?: () => string | undefined; unlocked: () => boolean; epoch: () => number;
  read: (sessionId: string) => Promise<FeatureTrackingNote>;
}
/** Read-only request records follow selection and access, with quiet updates while the note is open. */
export function createFeatureRequestNoteReader(ports: Ports) {
  const view = reactive({ note: null as FeatureTrackingNote | null, loading: false, stale: false, error: '' });
  let generation = 0, pending: { promise: Promise<FeatureTrackingNote | undefined> } | null = null;
  function clear() { generation++; pending = null; view.note = null; view.loading = false; view.stale = false; view.error = ''; }
  async function load(background = false): Promise<FeatureTrackingNote | undefined> {
    if (!ports.unlocked() || !ports.sessionId()) return;
    if (pending) { if (!background) view.loading = true; return pending.promise; }
    const current = generation, sessionId = ports.sessionId(), epoch = ports.epoch();
    const reading = { promise: Promise.resolve(undefined as FeatureTrackingNote | undefined) };
    pending = reading; view.loading = !background || !view.note;
    reading.promise = (async () => {
      try {
        const note = await ports.read(sessionId);
        if (current !== generation || epoch !== ports.epoch() || !ports.unlocked() || sessionId !== ports.sessionId()) return;
        if (note.sessionId !== sessionId) throw Error('The worker returned a different request record. Refresh to retry.');
        view.note = note; view.stale = false; view.error = ''; return note;
      } catch (error) {
        if (current === generation && epoch === ports.epoch() && ports.unlocked()) { view.stale = !!view.note; view.error = (error as Error).message; }
      } finally { if (pending === reading) { pending = null; view.loading = false; } }
    })();
    return reading.promise;
  }
  const stopIdentity = watch([ports.sessionId, ports.epoch], clear, { flush: 'sync' });
  const stopRevision = watch(() => ports.revision?.(), revision => { generation++; pending = null; view.loading = false; view.stale = !!view.note && view.note.revision !== revision; }, { flush: 'sync' });
  const stopAccess = watch(ports.unlocked, unlocked => { if (!unlocked) clear(); }, { flush: 'sync' });
  return { view, load, dispose: () => { clear(); stopIdentity(); stopRevision(); stopAccess(); } };
}

/** Obsidian metadata stays inspectable without being mistaken for the readable request body. */
export function splitFeatureRequestMarkdown(markdown: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  return match && /^[A-Za-z_][\w-]*:/m.test(match[1])
    ? { metadata: match[1], body: markdown.slice(match[0].length) }
    : { metadata: '', body: markdown };
}
