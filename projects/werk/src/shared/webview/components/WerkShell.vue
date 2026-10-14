<script setup lang="ts">
import { useRoute } from "vue-router";
import { nextTick, ref, watch } from "vue";
import UIcon from "@nuxt/ui/components/Icon.vue";
import type { NavigationLink } from "../types";
withDefaults(
  defineProps<{
    links?: NavigationLink[];
    homePath?: string;
    homeLabel?: string;
    navLabel?: string;
  }>(),
  {
    links: () => [],
    homePath: "/",
    homeLabel: "Werk home",
    navLabel: "Workspace pages",
  },
);
const route = useRoute();
const navigation = ref<HTMLElement>();
watch(
  () => route.path,
  async () => {
    await nextTick();
    const nav = navigation.value;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active || nav.scrollWidth <= nav.clientWidth) return;
    const container = nav.getBoundingClientRect(),
      item = active.getBoundingClientRect();
    if (item.left < container.left)
      nav.scrollLeft -= container.left - item.left;
    else if (item.right > container.right)
      nav.scrollLeft += item.right - container.right;
  },
  { immediate: true },
);
function skipToContent() {
  const main = document.getElementById("main");
  main?.focus({ preventScroll: true });
  main?.scrollIntoView({ block: "start" });
}
</script>
<template>
  <a class="skip-link" href="#main" @click.prevent="skipToContent"
    >Skip to content</a
  >
  <div class="workspace-shell">
    <aside class="sidebar">
      <RouterLink class="wordmark" :to="homePath" :aria-label="homeLabel"
        >werk<span>.</span></RouterLink
      >
      <slot name="identity" />
      <nav v-if="links.length" ref="navigation" :aria-label="navLabel">
        <RouterLink
          v-for="link in links"
          :key="link.path"
          :to="link.path"
          class="page-link"
          :aria-current="route.path === link.path ? 'page' : undefined"
          ><UIcon v-if="link.icon" :name="link.icon" /><span>{{
            link.label
          }}</span></RouterLink
        >
      </nav>
      <slot name="sidebarBody" />
      <div class="sidebar-foot"><slot name="sidebarFooter" /></div>
    </aside>
    <div class="workspace-content">
      <header class="utility-bar">
        <slot name="status" />
        <div class="actions"><slot name="actions" /></div>
      </header>
      <main id="main" tabindex="-1"><slot name="notices" /><slot /></main>
      <footer v-if="$slots.footer" class="workspace-footer">
        <slot name="footer" />
      </footer>
    </div>
  </div>
</template>
