<script setup lang="ts">
import DeliveryMetricsPanel from '../components/DeliveryMetricsPanel.vue';
</script>
<template><section class="workflow-quality-page" data-page-goal="Inspect delivery quality evidence"><header class="page-heading"><div><RouterLink to="/workflow">Back to Workflow health</RouterLink><h1 tabindex="-1">Delivery quality evidence</h1><p>Inspect readiness, repair and review observations for a submission cohort.</p></div></header><DeliveryMetricsPanel /></section></template>
<style scoped>.workflow-quality-page { max-width:1400px;margin-inline:auto;min-width:0; }.page-heading p { max-width:65ch; }.page-heading a { display:inline-flex;min-height:44px;align-items:center;color:var(--ui-primary);font-size:.8125rem; }</style>
