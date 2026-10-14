<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
import type { Page } from "../store";
withDefaults(
  defineProps<{ page: Page; busy?: boolean; label?: string; limit?: number }>(),
  { busy: false, label: "Einträge", limit: 50 },
);
defineEmits<{ move: [direction: "next" | "previous"]; refresh: [] }>();
</script>
<template>
  <div class="pagination">
    <p role="status" tabindex="-1" data-page-state>
      {{
        page.loaded
          ? `Seite ${page.previous.length + 1} · ${page.count} ${label}, maximal ${limit}. ${page.hasMore ? "Weitere Seiten vorhanden." : "Ende dieses Lesestands."}`
          : "Noch keine Seite geladen."
      }}
    </p>
    <div class="actions">
      <UButton
        color="neutral"
        variant="outline"
        :disabled="busy || !page.previous.length"
        @click="$emit('move', 'previous')"
        >Vorherige</UButton
      ><UButton
        color="neutral"
        variant="outline"
        :disabled="busy || !page.hasMore"
        @click="$emit('move', 'next')"
        >Nächste</UButton
      ><UButton
        color="neutral"
        variant="ghost"
        :loading="busy"
        :disabled="busy"
        @click="$emit('refresh')"
        >Neueste laden</UButton
      >
    </div>
  </div>
</template>
