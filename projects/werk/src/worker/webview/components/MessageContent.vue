<script setup lang="ts">
import SharedMessageContent from '../../../shared/webview/components/MessageContent.vue';
withDefaults(defineProps<{ text: string; markdown?: boolean }>(), { markdown: true });
</script>
<template><SharedMessageContent :text="text" :markdown="markdown" /></template>
