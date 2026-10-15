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
const props = withDefaults(
  defineProps<{ title: string; steps: TourStep[]; locale?: "en" | "de" }>(),
  { locale: "en" },
);
const labels = computed(() =>
  props.locale === "de"
    ? { back: "Zurück", next: "Weiter", finish: "Fertig", close: "Tour schließen", opening: "Ansicht wird geöffnet…", error: "Diese Ansicht konnte nicht geöffnet werden. Schließe die Tour und versuche es über die Seitennavigation erneut." }
    : { back: "Back", next: "Next", finish: "Finish", close: "Close tour", opening: "Opening this view…", error: "This view could not be opened. Close the tour and retry from the page navigation." },
);
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
const errorMessage = computed(() => state.value.error ? labels.value.error : "");
const description = computed(() =>
  [state.value.step?.text, errorMessage.value].filter(Boolean).join(" "),
);
function keepTourOpen(event: Event) {
  event.preventDefault();
}
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
    :modal="false"
    :overlay="false"
    :content="{ onInteractOutside: keepTourOpen }"
    :ui="{ content: 'top-auto bottom-4 left-4 right-4 translate-x-0 translate-y-0 sm:left-auto sm:right-6 sm:bottom-6 sm:max-w-md' }"
  >
    <template #close>
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        :aria-label="labels.close"
      />
    </template>
    <template #body
      ><p class="tour-progress">
        {{ title }} · {{ state.index + 1 }} / {{ steps.length }}
      </p>
      <p v-if="state.busy" role="status">{{ labels.opening }}</p>
      <p v-if="errorMessage" role="alert">{{ errorMessage }}</p></template
    >
    <template #footer
      ><div class="tour-actions">
        <UButton
          color="neutral"
          variant="outline"
          :disabled="state.busy || state.index === 0"
          @click="controller.go(state.index - 1)"
          >{{ labels.back }}</UButton
        ><UButton :disabled="state.busy" @click="next">{{
          state.index === steps.length - 1 ? labels.finish : labels.next
        }}</UButton
        ><UButton color="neutral" variant="ghost" @click="open = false"
          >{{ labels.close }}</UButton
        >
      </div></template
    >
  </UModal>
</template>
