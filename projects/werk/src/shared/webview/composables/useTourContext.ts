import { watch } from "vue";
import type { createTourController } from "../tour-controller";
/** Close before rendering a changed route/scope's tour copy; old activations stay fenced. */
export function watchTourContext(
  controller: ReturnType<typeof createTourController>,
  context: () => unknown,
) {
  return watch(
    context,
    () => {
      if (controller.snapshot().open) controller.close();
    },
    { deep: true },
  );
}
