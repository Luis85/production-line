<script setup lang="ts">
import UIcon from "@nuxt/ui/components/Icon.vue";
withDefaults(
  defineProps<{
    title: string;
    lead?: string;
    helpTitle?: string;
    caption?: string;
  }>(),
  { lead: "", helpTitle: "Where do I find my token?", caption: "" },
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
  <main id="main" tabindex="-1" class="unlock-page">
    <div class="unlock-brand wordmark">werk<span>.</span></div>
    <section class="unlock-card" aria-labelledby="access-title">
      <div class="unlock-symbol"><UIcon name="i-lucide-lock-keyhole" /></div>
      <h1 id="access-title" tabindex="-1">{{ title }}</h1>
      <p v-if="lead" class="unlock-lead">{{ lead }}</p>
      <slot />
      <details v-if="$slots.help" class="unlock-help">
        <summary>{{ helpTitle }}</summary>
        <slot name="help" />
      </details>
      <div v-if="$slots.privacy" class="unlock-privacy">
        <UIcon name="i-lucide-shield-check" />
        <div><slot name="privacy" /></div>
      </div>
    </section>
    <p v-if="caption" class="unlock-caption">{{ caption }}</p>
  </main>
</template>
