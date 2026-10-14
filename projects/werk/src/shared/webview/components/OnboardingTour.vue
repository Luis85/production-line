<script setup lang="ts">
import { computed, nextTick, onUnmounted, shallowRef, watch } from "vue";
import UModal from "@nuxt/ui/components/Modal.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import type { TourStep } from "../types";
import { watchTourContext } from "../composables/useTourContext";
import {
  createTourController,
  hasActiveTour,
  type TourSnapshot,
} from "../tour-controller";
const props = defineProps<{ title: string; steps: TourStep[] }>();
const open = defineModel<boolean>("open", { default: false });
const state = shallowRef<TourSnapshot>({
  open: false,
  index: 0,
  busy: false,
  error: "",
  revision: 0,
  step: null,
});
let highlighted: Element | null = null,
  trigger: HTMLElement | null = null;
function clearHighlight() {
  highlighted?.classList.remove("werk-tour-target");
  highlighted = null;
}
const controller = createTourController(
  () => props.steps,
  () => {
    state.value = controller.snapshot();
    if (!state.value.open) open.value = false;
    clearHighlight();
    void reveal();
  },
);
watchTourContext(controller, () => [props.title, props.steps]);
async function reveal() {
  const own = state.value.revision;
  if (!state.value.open || state.value.busy) return;
  await nextTick();
  if (!state.value.open || state.value.busy || state.value.revision !== own)
    return;
  highlighted = state.value.step?.target
    ? document.querySelector(state.value.step.target)
    : null;
  highlighted?.classList.add("werk-tour-target");
}
const description = computed(() =>
  [state.value.step?.text, state.value.error].filter(Boolean).join(" "),
);
watch(open, (value) => {
  if (value) {
    trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    void controller.start();
  } else {
    controller.close();
    clearHighlight();
    void nextTick(() => {
      if (!hasActiveTour() && trigger?.isConnected)
        trigger.focus({ preventScroll: true });
    });
  }
});
onUnmounted(() => {
  controller.close();
  clearHighlight();
});
function next() {
  if (state.value.index === props.steps.length - 1) open.value = false;
  else void controller.go(state.value.index + 1);
}
</script>
<template>
  <UModal
    v-model:open="open"
    :title="state.step?.title ?? title"
    :description="description"
  >
    <template #body
      ><p class="tour-progress">
        {{ title }} · {{ state.index + 1 }} / {{ steps.length }}
      </p>
      <p v-if="state.busy" role="status">Opening this view…</p>
      <p v-if="state.error" role="alert">{{ state.error }}</p></template
    >
    <template #footer
      ><div class="tour-actions">
        <UButton
          color="neutral"
          variant="outline"
          :disabled="state.busy || state.index === 0"
          @click="controller.go(state.index - 1)"
          >Back</UButton
        ><UButton :disabled="state.busy" @click="next">{{
          state.index === steps.length - 1 ? "Finish" : "Next"
        }}</UButton
        ><UButton color="neutral" variant="ghost" @click="open = false"
          >Close tour</UButton
        >
      </div></template
    >
  </UModal>
</template>
