import { reactive, watch as watchPrivateDrafts } from "vue";
import { state as privateWorkerState } from "../store";
import type { GateActionCommand } from "../request-gate-controller";
export const requestDrafts = reactive(new Map<string, string>());
export const requestOperations = reactive(new Map<string, GateActionCommand>());
watchPrivateDrafts(
  () => privateWorkerState.draftEpoch,
  () => {
    requestDrafts.clear();
    requestOperations.clear();
  },
  { flush: "sync" },
);
