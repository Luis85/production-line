<script setup lang="ts">
withDefaults(defineProps<{ title: string; description?: string }>(), {
  description: "",
});
</script>
<template>
  <header class="page-heading">
    <div>
      <slot name="eyebrow" />
      <h1 tabindex="-1">{{ title }}</h1>
      <p v-if="description">{{ description }}</p>
      <slot />
    </div>
    <div v-if="$slots.actions" class="actions"><slot name="actions" /></div>
  </header>
</template>
