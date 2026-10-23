<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import type { RequestEvent } from '../../application/request-gates';
import { date, request, state } from '../store';
const props = defineProps<{ requestId: string; revision: number }>();
type EventPage = { schemaVersion: 1; requestId: string; events: RequestEvent[]; nextAfter: number; hasMore: boolean };
const events = ref<RequestEvent[]>([]), after = ref(0), hasMore = ref(false), error = ref(''), loading = ref(false), filter = ref('');
let generation = 0, disposed = false, inFlight = false, pendingRefresh = false;
const visible = computed(() => events.value.filter(event => [event.type, event.phase, event.runId, event.deliveryRunId, event.deliveryStepId, event.turnId, event.inputRevision].join(' ').toLowerCase().includes(filter.value.trim().toLowerCase())));
async function load(manual = false) {
  if (!state.unlocked || disposed) return;
  if (inFlight) { pendingRefresh = true; return; }
  const identity = props.requestId, owner = generation, cursor = after.value;
  if (manual || !events.value.length) loading.value = true;
  inFlight = true;
  try {
    const page = await request<EventPage>('/api/requests', 'POST', { action: 'events', requestId: identity, after: cursor, limit: 100 });
    if (disposed || owner !== generation || identity !== props.requestId || !state.unlocked) return;
    if (page.requestId !== identity || page.events.some(event => event.requestId !== identity || event.sequence <= cursor))
      throw new Error('The activity response did not match this request. Refresh its activity to try again.');
    const retained = new Map(events.value.map(event => [event.id, event]));
    for (const event of page.events) retained.set(event.id, event);
    events.value = [...retained.values()].sort((a, b) => a.sequence - b.sequence);
    after.value = page.nextAfter; hasMore.value = page.hasMore; error.value = '';
  } catch (failure) {
    if (!disposed && owner === generation) error.value = (failure as Error).message;
  } finally {
    if (owner === generation) {
      loading.value = false; inFlight = false;
      const followUp = pendingRefresh && !hasMore.value; pendingRefresh = false;
      if (followUp) void load();
    }
  }
}
watch(() => [props.requestId, state.unlocked], () => {
  generation++; events.value = []; after.value = 0; hasMore.value = false; error.value = ''; loading.value = false; inFlight = false; pendingRefresh = false; filter.value = '';
  if (state.unlocked) void load();
}, { immediate: true });
watch(() => props.revision, () => { if (!hasMore.value) void load(); });
onBeforeUnmount(() => { disposed = true; generation++; });
</script>
<template>
  <section id="review-activity" class="request-activity" aria-labelledby="request-activity-title">
    <div class="activity-heading"><h2 id="request-activity-title">Request activity</h2><UButton color="neutral" variant="outline" :loading="loading" :disabled="loading || !state.unlocked" @click="load(true)">{{ hasMore ? 'Load more events' : 'Refresh activity' }}</UButton></div>
    <p class="activity-caption">Ordered events retained by this worker. Provider output and verification results are shown with their delivery steps and checks.</p>
    <label for="request-activity-filter">Filter activity by event, phase, run or revision</label><input id="request-activity-filter" v-model="filter" type="search" placeholder="Search recorded activity">
    <p v-if="error" role="alert" class="error-text">{{ error }} Previously loaded events remain visible.</p>
    <ol v-if="visible.length" class="activity-events"><li v-for="event in visible" :key="event.id"><div><strong>{{ event.type.replaceAll('_', ' ') }}</strong><time :datetime="event.at">{{ date(event.at) }}</time></div><p>Request revision {{ event.inputRevision }} · {{ event.phase.replaceAll('_', ' ') }}</p><details v-if="event.runId || event.deliveryRunId || event.deliveryStepId || event.turnId || event.evaluationId"><summary>Event correlation</summary><dl><div v-if="event.deliveryRunId"><dt>Delivery run</dt><dd>{{ event.deliveryRunId }}</dd></div><div v-if="event.deliveryStepId"><dt>Delivery step</dt><dd>{{ event.deliveryStepId }}</dd></div><div v-if="event.runId"><dt>Invocation run</dt><dd>{{ event.runId }}</dd></div><div v-if="event.turnId"><dt>Model turn</dt><dd>{{ event.turnId }}</dd></div><div v-if="event.evaluationId"><dt>Gate evaluation</dt><dd>{{ event.evaluationId }}</dd></div><div><dt>Event sequence</dt><dd>{{ event.sequence }}</dd></div></dl></details></li></ol>
    <p v-else class="activity-caption">{{ loading ? 'Reading this request’s saved activity…' : events.length ? 'No loaded events match this filter.' : 'No retained activity is available for this request yet.' }}</p>
    <p v-if="hasMore" class="activity-caption">Earlier-to-later order · more recorded events are available. Load more to continue this timeline.</p>
  </section>
</template>
<style scoped>
.request-activity { min-width: 0; padding-block: var(--space-6); border-bottom: 1px solid var(--ui-border); scroll-margin-top: var(--space-6); }.activity-heading, .activity-events li > div { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; } h2 { margin: 0; font-size: 1.125rem; font-weight: 650; }.activity-heading :deep(button), summary { min-height: 44px; }
.activity-caption, time, .activity-events p { color: var(--ui-text-muted); font-size: .8125rem; line-height: 1.65; }.request-activity label { display: block; margin-block: var(--space-4) var(--space-2); font-size: .875rem; }input { display: block; width: min(100%,36rem); min-height: 44px; padding: var(--space-3); border: 1px solid var(--ui-border); border-radius: 6px; background: var(--ui-bg); color: var(--ui-text); }
.activity-events { padding: 0; margin: var(--space-4) 0; list-style: none; }.activity-events li { padding-block: var(--space-4); border-bottom: 1px solid var(--ui-border); font-size: .875rem; overflow-wrap: anywhere; }.activity-events li:last-child { border-bottom: 0; }.activity-events p { margin-block: var(--space-2); }summary { padding-block: var(--space-3); cursor: pointer; }.activity-events dl { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: var(--space-3); }.activity-events dt { color: var(--ui-text-muted); }.activity-events dd { margin: var(--space-1) 0 0; }.error-text { overflow-wrap: anywhere; line-height: 1.65; }
@media (max-width: 560px) { .activity-events dl { grid-template-columns: 1fr; } }
</style>
