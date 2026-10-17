<script setup lang="ts">
import ConceptRepositoryWorkflow from "./ConceptRepositoryWorkflow.vue";
import ConceptRuntimeBoundaries from "./ConceptRuntimeBoundaries.vue";
import ConceptAgentDelivery from "./ConceptAgentDelivery.vue";
</script>
<template>
  <div class="concept-system-documentation">
    <p class="concept-note">
      Zielarchitektur und lokale Konzeptsimulation: Die folgenden Git-, Quota-
      und Check-Abläufe sind illustrative Entwurfsregeln. Der
      Live-Runtime-Vertrag steht im Systemguide und in den ausgelieferten
      Referenzen; diese Demo startet keine Provider und publiziert keine PRs.
    </p>
    <ConceptRepositoryWorkflow />
    <ConceptRuntimeBoundaries />
    <ConceptAgentDelivery />
  </div>
</template>
