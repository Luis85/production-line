import { computed, onActivated, onDeactivated, onUnmounted, ref, shallowRef, toRaw, watch } from 'vue';
import { request, state } from '../store';
import type { ServiceRecord } from '../../application/process-supervision';

interface ServiceOperation { action: 'stop' | 'restart'; id: string; expectedRevision: number; operationId: string; }
// Preserve an uncertain command when navigating away, so a retry cannot restart twice.
const pendingOperations = new Map<string, ServiceOperation>();
export function useServiceControls(refresh: () => Promise<void>) {
  const pending = shallowRef<ServiceOperation | null>(pendingOperations.values().next().value ?? null);
  const confirmation = shallowRef<{ action: 'stop' | 'restart'; service: ServiceRecord } | null>(null);
  const busy = ref(''), error = ref(''), notice = ref('');
  let active = true, disposed = false, generation = 0;
  const blocked = computed(() => !!busy.value || !!pending.value || !state.unlocked);
  const current = () => { pending.value = pendingOperations.values().next().value ?? null; };
  function confirm(action: 'stop' | 'restart', service: ServiceRecord) {
    if (blocked.value || !active || disposed) return;
    confirmation.value = { action, service: structuredClone(toRaw(service)) };
    notice.value = ''; error.value = '';
  }
  async function send(command: ServiceOperation) {
    if (busy.value || !state.unlocked || !active || disposed) return;
    const epoch = ++generation;
    busy.value = command.id + ':' + command.action; error.value = ''; notice.value = '';
    try {
      const result = await request<{ service?: { id?: string; revision?: number } }>('/api/processes', 'POST', command);
      if (!result?.service || result.service.id !== command.id || !Number.isSafeInteger(result.service.revision) || result.service.revision! < command.expectedRevision)
        throw Error('The worker returned an inconsistent service acknowledgement. Retry the same operation to confirm its outcome.');
      if (pendingOperations.get(command.id)?.operationId === command.operationId) pendingOperations.delete(command.id);
      if (!active || disposed || epoch !== generation || !state.unlocked) return;
      current(); confirmation.value = null;
      notice.value = command.action === 'stop' ? 'Stop request acknowledged. Check the current service state below.' : 'Restart request acknowledged. The worker rechecks its permissions and Feature Request before starting.';
      await refresh();
    } catch (failure) {
      const status = (failure as Error & { status?: number }).status;
      if (status && status >= 400 && status < 500 && status !== 401 && pendingOperations.get(command.id)?.operationId === command.operationId) pendingOperations.delete(command.id);
      if (!active || disposed || epoch !== generation || !state.unlocked) return;
      current(); error.value = failure instanceof Error ? failure.message : 'The service operation could not be confirmed.';
      if (status === 409) { confirmation.value = null; await refresh(); }
    } finally { if (epoch === generation) busy.value = ''; }
  }
  async function execute() {
    if (!confirmation.value || blocked.value) return;
    const { action, service } = confirmation.value;
    const command = { action, id: service.id, expectedRevision: service.revision, operationId: crypto.randomUUID() };
    pendingOperations.set(command.id, command); current();
    await send(command);
  }
  const retry = async () => { if (pending.value) await send(pending.value); };
  function invalidate() { generation++; busy.value = ''; confirmation.value = null; error.value = ''; notice.value = ''; }
  onDeactivated(() => { active = false; invalidate(); });
  onActivated(() => { if (!disposed) { active = true; current(); } });
  onUnmounted(() => { disposed = true; active = false; invalidate(); });
  watch(() => state.unlocked, unlocked => { invalidate(); if (!unlocked) pendingOperations.clear(); current(); }, { flush: 'sync' });
  return { pending, confirmation, busy, error, notice, blocked, confirm, execute, retry };
}
