<script setup lang="ts">
withDefaults(
  defineProps<{ healthy?: boolean; label: string; detail?: string }>(),
  { healthy: false, detail: "" },
);
</script>
<template>
  <div class="connection">
    <span class="status-dot" :class="{ healthy }" aria-hidden="true"></span
    ><strong>{{ label }}</strong
    ><span v-if="detail" class="muted">{{ detail }}</span
    ><slot />
  </div>
</template>
