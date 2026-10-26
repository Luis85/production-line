<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import UButton from '@nuxt/ui/components/Button.vue';
import NewFeatureRequestPanel from '../components/NewFeatureRequestPanel.vue';
const route = useRoute(), router = useRouter(), busy = ref(false);
const projectId = computed(() => typeof route.query.project === 'string' ? route.query.project : undefined);
const draftName = computed(() => typeof route.query.draft === 'string' ? route.query.draft : undefined);
async function back() { await router.push('/workboard'); await nextTick(); document.getElementById('new-feature-request')?.focus(); }
async function created(id: string) { if (route.path === '/requests/new') await router.push({ path: '/request', query: { session: id } }); }
</script>
<template>
  <section class="new-request-page" aria-labelledby="new-feature-request-title">
    <header class="page-heading"><div><h1 id="new-feature-request-title" tabindex="-1">New Feature Request</h1><p>Describe the outcome, check the request, then explicitly publish it to Git.</p></div><UButton color="neutral" variant="ghost" @click="back">Back to Workboard</UButton></header>
    <NewFeatureRequestPanel :initial-project-id="projectId" :draft-name="draftName" @busy="busy = $event" @created="created" />
    <p v-if="busy" class="page-note" role="status">The current operation is being recorded. Returning to Workboard retains this draft.</p>
  </section>
</template>
<style scoped>
.new-request-page { max-width:900px;margin-inline:auto;min-width:0; }.page-heading { display:flex;justify-content:space-between;gap:var(--space-4);flex-wrap:wrap;margin-bottom:var(--space-6); }.page-heading h1 { font-size:2rem;line-height:1.25;letter-spacing:-.025em; }.page-heading p { color:var(--ui-text-muted);font-size:.875rem;line-height:1.65;max-width:65ch; }:deep(button),:deep(a) { min-height:44px; }
</style>
