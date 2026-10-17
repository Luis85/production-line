import { reactive, computed, onActivated, onDeactivated, onBeforeUnmount, onMounted, ref, watch, toRaw, toRef } from "vue";
import { useBoundedPolling } from '../../../shared/webview/composables/useBoundedPolling';
import type {
  WorkerRequest,
  GateEvaluation,
  GateStage,
} from "../../application/request-gates";
import { state, request, refresh, date } from "../store";
import {
  RequestGateController,
  initialGateState,
  type GateCommandFields,
} from "../request-gate-controller";
import { requestDrafts, requestOperations } from "./request-gate-drafts";
import type { GateActionCommand } from "../request-gate-controller";

/** Owns this page's state, actions and lifecycle; the Vue component owns rendering. */
export function useRequestGatePanel(props: { requestId?: string; sessionId?: string }, emit: (event: "change", value: WorkerRequest | null) => void) {
  const gateState = reactive(initialGateState());
  const view = toRef(gateState, "view"),
    rows = toRef(gateState, "rows"),
    selected = toRef(gateState, "selected"),
    loading = toRef(gateState, "loading"),
    busy = toRef(gateState, "busy"),
    error = toRef(gateState, "error"),
    notice = toRef(gateState, "notice");
  const active = ref(true);
  const sessionId = computed(
    () => props.sessionId ?? state.sessions?.selected ?? "",
  );
  const identity = computed(() => props.requestId || selected.value);
  const operation = computed(() => requestOperations.get(identity.value));
  const activeExecution = computed(
    () =>
      !!view.value?.execution &&
      ["prepared", "running"].includes(view.value.execution.status),
  );
  const activeReview = computed(
    () =>
      view.value?.reviews.some((review) =>
        ["queued", "running"].includes(review.status),
      ) ?? false,
  );
  const pendingModel = computed(() =>
    ["waiting_input", "escalated"].includes(view.value?.phase ?? ""),
  );
  const mutable = computed(
    () =>
      !!view.value &&
      !busy.value &&
      !loading.value &&
      !gateState.stale &&
      !operation.value &&
      !activeExecution.value &&
      !pendingModel.value &&
      !activeReview.value &&
      !["done", "cancelled"].includes(view.value.phase),
  );
  const stage = computed<GateStage>(() =>
    view.value?.execution?.result?.type === "completed" ? "done" : "ready",
  );
  const openFindings = computed(
    () =>
      view.value?.findings.filter((finding) => finding.status === "open") ?? [],
  );
  const pendingCandidates = computed(
    () =>
      view.value?.candidates.filter(
        (candidate) => candidate.status === "pending",
      ) ?? [],
  );
  const canAttest = computed(
    () =>
      !!view.value?.execution?.outputDigest &&
      view.value.execution.result?.type === "completed" &&
      view.value.policy.done[view.value.input.kind].some(
        (rule) => rule.fact === "operator.accepted",
      ),
  );
  const draftKey = (part: string) =>
    identity.value + ":" + (view.value?.inputRevision ?? 0) + ":" + part;
  function draft(part: string) {
    return requestDrafts.get(draftKey(part)) ?? "";
  }
  function setDraft(part: string, value: string) {
    requestDrafts.set(draftKey(part), value);
  }
  const proposedMessage = computed({
    get: () =>
      requestDrafts.get(draftKey("candidate")) ?? view.value?.input.message ?? "",
    set: (value) => setDraft("candidate", value),
  });
  const phaseLabel = (phase: string) =>
    ({
      readiness: "Readiness check",
      needs_rework: "Needs rework",
      ready: "Ready for execution",
      running: "Executing",
      waiting_input: "Waiting for model input",
      escalated: "Model escalation",
      review: "Request review",
      done: "Request done",
      failed: "Execution failed",
      cancelled: "Request cancelled",
      interrupted: "Worker interrupted",
    })[phase] ?? phase;
  function currentEvaluation(stage: GateStage): GateEvaluation | undefined {
    return view.value?.evaluations.findLast(
      (value) =>
        value.stage === stage &&
        value.inputHash === view.value!.inputHash &&
        value.inputRevision === view.value!.inputRevision &&
        value.policyDigest === view.value!.policyDigest &&
        (stage === "ready" ||
          value.outputDigest === view.value!.execution?.outputDigest),
    );
  }
  function gateLabel(stage: GateStage) {
    const value = currentEvaluation(stage);
    return !value
      ? "Not evaluated"
      : value.passed
        ? "Passed"
        : value.rules.some((rule) => rule.result === "unknown")
          ? "Unknown evidence · blocked"
          : "Failed";
  }

  const controller = new RequestGateController({
    state: gateState,
    current: () => ({
      sessionId: sessionId.value,
      requestId: props.requestId,
      unlocked: state.unlocked,
    }),
    api: (command) => request("/api/requests", "POST", command),
    operations: requestOperations,
    operationId: () => crypto.randomUUID(),
    changed: (value) => emit("change", value),
    refresh,
  });
  const load = (force = false) => controller.load(force);
  const command = (fields: GateCommandFields) => controller.mutate(fields);
  const send = (value: GateActionCommand) => controller.send(value);
  async function propose() {
    if (!mutable.value || !view.value || !proposedMessage.value.trim()) return;
    if (proposedMessage.value === view.value.input.message) {
      error.value = "Revise the instruction before proposing a candidate.";
      return;
    }
    await command({
      action: "propose",
      input: {
        ...structuredClone(toRaw(view.value.input)),
        message: proposedMessage.value,
      },
    });
  }
  async function resolveFinding(findingId: string) {
    const note = draft(findingId).trim();
    if (!mutable.value || !note) return;
    await command({ action: "resolve_finding", findingId, note });
  }
  async function attest() {
    const note = draft("attestation").trim();
    if (
      !mutable.value ||
      !canAttest.value ||
      !note ||
      !view.value?.execution?.outputDigest
    )
      return;
    await command({
      action: "attest",
      inputHash: view.value.inputHash,
      outputDigest: view.value.execution.outputDigest,
      note,
    });
  }
  function chooseRequest(id: string) {
    void controller.select(id);
  }
  watch([sessionId, () => props.requestId, () => state.unlocked], () => {
    controller.invalidate();
    if (state.unlocked) void load(true);
  });
  useBoundedPolling(() => load(), computed(() => state.paused || !state.unlocked || !active.value), 2500);
  onMounted(() => { void load(true); });
  onDeactivated(() => { active.value = false; controller.suspend(); });
  onActivated(() => { if (!active.value) { active.value = true; controller.resume(); void load(true); } });
  onBeforeUnmount(() => controller.dispose());

  return {
    activeExecution,
    activeReview,
    attest,
    busy,
    canAttest,
    chooseRequest,
    command,
    currentEvaluation,
    date,
    draft,
    error,
    gateLabel,
    gateState,
    identity,
    load,
    loading,
    mutable,
    notice,
    openFindings,
    operation,
    pendingCandidates,
    pendingModel,
    phaseLabel,
    propose,
    proposedMessage,
    resolveFinding,
    rows,
    send,
    setDraft,
    stage,
    view,
  };
}
