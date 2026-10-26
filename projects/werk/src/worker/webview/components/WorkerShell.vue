<script setup lang="ts">
import { useRoute } from 'vue-router';
import UIcon from '@nuxt/ui/components/Icon.vue';
import type { NavigationLink } from '../../../shared/webview/types';
defineProps<{ links: NavigationLink[]; homePath: string; homeLabel: string; navLabel: string }>();
const route = useRoute();
function primaryDestination(path: string) {
  if (path === '/request' || path.startsWith('/request/') || path.startsWith('/requests/') || path === '/review') return '/workboard';
  if (path === '/project' || path.startsWith('/projects/')) return '/projects';
  if (path.startsWith('/workflow/')) return '/workflow';
  return path;
}
function skipToContent() { document.getElementById('main')?.focus(); }
</script>
<template>
  <a class="skip-link" href="#main" @click.prevent="skipToContent">Skip to content</a>
  <div class="worker-shell">
    <header class="worker-header">
      <RouterLink class="wordmark" :to="homePath" :aria-label="homeLabel">werk<span>.</span></RouterLink>
      <div class="worker-header-identity"><slot name="identity" /></div>
      <nav :aria-label="navLabel">
        <RouterLink v-for="link in links" :key="link.path" :to="link.path" :aria-current="route.path === link.path ? 'page' : primaryDestination(route.path) === link.path ? 'location' : undefined"><UIcon v-if="link.icon" :name="link.icon" /><span>{{ link.label }}</span></RouterLink>
      </nav>
      <div class="worker-header-actions"><slot name="actions" /></div>
    </header>
    <main id="main" tabindex="-1" :class="{ 'worker-detail-page': !['/taskboard', '/workboard'].includes(route.path) }">
      <div class="worker-notices"><slot name="notices" /></div>
      <slot />
    </main>
    <footer class="worker-footer">
      <div class="worker-footer-status"><slot name="status" /><slot name="mode" /></div>
      <div class="worker-footer-evidence" aria-label="Worker evidence"><RouterLink to="/dashboard">Worker health</RouterLink><RouterLink to="/history">History</RouterLink></div>
      <div class="worker-footer-refresh"><slot name="footer" /></div>
    </footer>
  </div>
</template>
<style scoped>
.worker-shell { min-height: 100dvh; display: flex; flex-direction: column; }
.worker-header { min-height: 84px; display: flex; align-items: center; gap: 26px; padding: 12px 32px; border-bottom: 1px solid var(--ui-border); background: #121e26; }
.wordmark { flex: 0 0 auto; font-size: 2rem; line-height: 1; letter-spacing: -.04em; }
.worker-header-identity { border-left: 1px solid var(--ui-border); padding-left: 24px; }
.worker-header-identity :deep(.worker-identity) { margin: 0; }
.worker-header-identity :deep(.worker-identity strong) { font-size: .8125rem; }
.worker-header-identity :deep(.worker-identity span:not(.worker-icon)) { font-size: .6875rem; }
nav { display: flex; align-self: stretch; align-items: center; gap: 6px; margin-left: 12px; }
nav a { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 10px 14px; border-radius: 6px; color: var(--ui-text-muted); font-size: .875rem; font-weight: 550; white-space: nowrap; text-decoration: none; }
nav a:hover { background: #1d2c35; color: var(--ui-text-highlighted); }
nav a[aria-current] { background: #243b37; color: #b3f1cf; }
.worker-header-actions :deep(button), .worker-header-actions :deep(a) { min-width: 44px; min-height: 44px; justify-content: center; }
.worker-header-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
#main { flex: 1; min-width: 0; width: 100%; max-width: none; margin: 0; padding: 0; }
#main.worker-detail-page { padding: 32px; }
.worker-notices:has(> *) { padding: 20px 32px 0; }
.worker-detail-page .worker-notices:has(> *) { padding: 0; }
.worker-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; border-top: 1px solid var(--ui-border); padding: 14px 32px; color: var(--ui-text-muted); font-size: .6875rem; }
.worker-footer-status { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.worker-footer-evidence { display:flex;flex-wrap:wrap;gap:16px; }.worker-footer-evidence a { display:inline-flex;align-items:center;min-height:44px;color:var(--ui-primary);font-size:.75rem; }
.worker-footer-refresh { display: flex; gap: 20px; flex-wrap: wrap; }
.worker-footer-status :deep(.connection-status) { font-size: .6875rem; }
@media (max-width: 1150px) { .worker-header { gap: 16px; padding-inline: 24px; } .worker-header-identity { padding-left: 16px; } nav { margin-left: 0; } nav a { padding-inline: 10px; } }
@media (max-width: 1050px) {
  .worker-header { flex-wrap: wrap; gap: 14px; padding: 16px 20px 0; }
  .worker-header-identity { border: 0; padding: 0; }
  nav { width: 100%; order: 3; flex-wrap: wrap; padding-bottom: 12px; justify-content: space-between; }
  .worker-header-actions { gap: 2px; }
  #main.worker-detail-page { padding: 24px 20px; }
  .worker-footer { padding: 16px 20px; }
  .worker-footer-refresh :deep(span) { display: none; }
  .worker-notices:has(> *) { padding-inline: 20px; }
}
@media (max-width: 560px) {
  .worker-header-identity { display: none; }
  .worker-header { gap: 12px; }
  .wordmark { font-size: 1.875rem; }
  nav { gap: 2px; } nav a { flex: 1 0 auto; justify-content:center; } nav a { font-size: .75rem; padding-inline: 8px; gap: 5px; }
  .worker-header-actions :deep(button), .worker-header-actions :deep(a) { font-size: .75rem; }
}
@media (max-width: 420px) { nav a :deep(.iconify) { display: none; } }
@media (max-width: 360px) { .worker-header { padding-inline: 12px; gap: 8px; } .wordmark { font-size: 1.625rem; } .worker-header-actions { gap: 0; } .worker-header-actions :deep(.worker-tour-label) { display: none; } }
</style>
