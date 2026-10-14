import type { TourStep } from "./types";
export interface TourSnapshot {
  open: boolean;
  index: number;
  busy: boolean;
  error: string;
  revision: number;
  step: TourStep | null;
}
let active: ReturnType<typeof createTourController> | undefined;
export function hasActiveTour() {
  return active?.snapshot().open ?? false;
}
/** Route activation is fenced: closed or replaced tours cannot publish late steps. */
export function createTourController(
  steps: () => TourStep[],
  changed: () => void = () => {},
) {
  let open = false,
    index = 0,
    busy = false,
    error = "",
    revision = 0;
  const controller = {
    snapshot(): TourSnapshot {
      return {
        open,
        index,
        busy,
        error,
        revision,
        step: steps()[index] ?? null,
      };
    },
    async start() {
      active?.close();
      active = controller;
      open = true;
      index = 0;
      await controller.go(0);
    },
    async go(next: number) {
      if (!open || next < 0 || next >= steps().length) return;
      const own = ++revision;
      index = next;
      busy = true;
      error = "";
      changed();
      try {
        await steps()[index]?.activate?.();
      } catch {
        if (revision === own && open)
          error =
            "This view could not be opened. Close the tour and retry from the page navigation.";
      }
      if (revision !== own || !open) return;
      busy = false;
      changed();
    },
    close() {
      revision++;
      open = false;
      busy = false;
      if (active === controller) active = undefined;
      changed();
    },
  };
  return controller;
}
