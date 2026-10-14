<script setup lang="ts">
import UCard from "@nuxt/ui/components/Card.vue";
withDefaults(
  defineProps<{ value: string | number; label: string; detail?: string }>(),
  { detail: "" },
);
</script>
<template>
  <UCard class="stat-card"
    ><div class="numeric stat-value">{{ value }}</div>
    <h2 class="stat-label">{{ label }}</h2>
    <p v-if="detail" class="muted">{{ detail }}</p>
    <slot
  /></UCard>
</template>
