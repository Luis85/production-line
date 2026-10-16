import { reactive, watch } from 'vue';
import type { ProviderAccountStatus } from '../application/provider-account';
import type { ProviderId } from '../infrastructure/providers';
interface Ports { id: () => ProviderId; identity: () => string; enabled: () => boolean; unlocked: () => boolean; epoch: () => number; read: (id: ProviderId) => Promise<ProviderAccountStatus>; }
/** Account observations belong to the saved provider identity and never survive an access change. */
export function createProviderAccountView(ports: Ports) {
  const state = reactive({ value: null as ProviderAccountStatus | null, loading: false, error: '' });
  let generation = 0;
  function clear() { generation++; state.value = null; state.loading = false; state.error = ''; }
  async function refresh() {
    if (state.loading || !ports.unlocked() || !ports.enabled()) return;
    const current = generation, id = ports.id(), identity = ports.identity(), epoch = ports.epoch(); state.loading = true; state.error = '';
    try { const value = await ports.read(id); if (current === generation && id === ports.id() && identity === ports.identity() && epoch === ports.epoch() && ports.unlocked() && ports.enabled()) state.value = value; }
    catch (error) { if (current === generation && ports.unlocked()) { state.value = null; state.error = (error as Error).message; } }
    finally { if (current === generation) state.loading = false; }
  }
  const stop = watch(() => [ports.id(), ports.identity(), ports.enabled(), ports.unlocked(), ports.epoch()], clear, { flush: 'sync' });
  return { state, refresh, clear, dispose: () => { clear(); stop(); } };
}
