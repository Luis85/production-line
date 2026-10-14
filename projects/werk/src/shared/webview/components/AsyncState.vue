<script setup lang="ts">
import UAlert from "@nuxt/ui/components/Alert.vue";
import UIcon from "@nuxt/ui/components/Icon.vue";
withDefaults(
  defineProps<{
    loading?: boolean;
    error?: string | null;
    empty?: boolean;
    emptyTitle?: string;
    emptyDescription?: string;
  }>(),
  {
    loading: false,
    error: "",
    empty: false,
    emptyTitle: "Nothing here yet",
    emptyDescription: "",
  },
);
</script>
<template>
  <UAlert
    v-if="error"
    color="error"
    variant="soft"
    title="This view is unavailable"
    :description="error"
    icon="i-lucide-wifi-off"
    class="notice"
  />
  <div v-if="loading" class="async-loading" role="status">
    <UIcon name="i-lucide-loader-circle" /> Loading…
  </div>
  <div v-else-if="empty" class="empty-state">
    <slot name="empty"
      ><h2>{{ emptyTitle }}</h2>
      <p v-if="emptyDescription">{{ emptyDescription }}</p>
      <slot name="emptyAction"
    /></slot>
  </div>
  <slot v-else />
</template>
