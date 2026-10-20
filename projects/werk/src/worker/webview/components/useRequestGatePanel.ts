import { reactive, computed, nextTick, onActivated, onDeactivated, onBeforeUnmount, onMounted, ref, watch, toRaw, toRef } from "vue";
import { useBoundedPolling } from '../../../shared/webview/composables/useBoundedPolling';
import type {
  WorkerRequest,
  GateStage,
  RequestFinding,
} from "../../application/request-gates";
import { state, request, refresh, date } from "../store";
import {
  RequestGateController,
  initialGateState,
  type GateCommandFields,
} from "../request-gate-controller";
import { buildFeatureReviewView, currentRequestEvaluation } from '../feature-review';
import { requestDrafts, requestOperations } from "./request-gate-drafts";
import type { GateActionCommand } from "../request-gate-controller";
import type { DeliveryControl } from "../../application/delivery-contracts";
import { acceptedDeliveryPolicy } from '../delivery-policy-view';
import { reportedReviewMinutes } from '../delivery-readiness-view';
import { deliveryHumanOutcomes, deliveryHumanReviewReady } from '../delivery-human-review';

/** Owns this page's state, actions and lifecycle; the Vue component owns rendering. */
export function useRequestGatePanel(props: { requestId?: string; sessionId?: string; featureSource?: string; disabled?: boolean }, emit: (event: "change", value: WorkerRequest | null) => void) {
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
  const session = computed(() => state.sessions?.records.find(row => row.id === (view.value?.owner.sessionId ?? sessionId.value)));
  const sharedRequest = computed(() => props.featureSource === 'shared_git' || session.value?.feature?.source === 'shared_git');
  const review = computed(() => buildFeatureReviewView({ request: view.value ?? undefined, session: session.value, freshness: { stale: gateState.stale, error: error.value } }));
  const pendingKey = ref('');
  let pendingAttempt: symbol | undefined;
  const isPending = (key: string) => busy.value && pendingKey.value === key;
  const scopeMutable = computed(() => !sharedRequest.value && !view.value?.delivery);
  const scopeActions = new Set(['propose', 'accept_candidate', 'rework', 'execute']);
  function allowed(action: string) {
    if (view.value?.delivery && ['execute', 'evaluate', 'rework', 'propose', 'accept_candidate', 'assign'].includes(action)) {
      error.value = 'This Feature Request has a delivery run. Use its exact delivery controls or human review actions.';
      return false;
    }
    if (scopeMutable.value || !scopeActions.has(action)) return true;
    error.value = 'The accepted shared Feature Request owns its scope. Create a new Feature Request for different work.';
    return false;
  }
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
      !props.disabled &&
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
  const canAttest = computed(() =>
    !!view.value?.execution?.outputDigest &&
    view.value.execution.result?.type === 'completed' &&
    view.value.execution.inputRevision === view.value.inputRevision &&
    (!view.value.delivery || !!review.value.evidence.deliveryReview && view.value.lifecycle === 'in_review') &&
    review.value.evidence.attestationRequired && !review.value.evidence.attested &&
    !['done', 'cancelled'].includes(view.value.phase),
  );
  function acceptanceFinding(finding: RequestFinding) {
    const evaluation = view.value?.evaluations.find(item => item.id === finding.evaluationId);
    return evaluation?.rules.some(rule => rule.ruleId === finding.ruleId && rule.fact === 'operator.accepted') ?? false;
  }
  const draftKey = (part: string) =>
    identity.value + ":" + (view.value?.inputRevision ?? 0) + ":" + part;
  function draft(part: string) {
    return requestDrafts.get(draftKey(part)) ?? "";
  }
  function setDraft(part: string, value: string) {
    requestDrafts.set(draftKey(part), value);
  }
  const humanReviewReady = computed(() => !view.value?.delivery?.review || deliveryHumanReviewReady(view.value.delivery.review, draft, { policy: acceptedDeliveryPolicy(view.value.input.context)?.profile.exceptions, decisions: view.value.delivery.criterionDecisions }));
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
  const currentEvaluation = (stage: GateStage) => currentRequestEvaluation(view.value, stage);
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
  function actionKey(fields: GateCommandFields) {
    const detail = 'findingId' in fields ? fields.findingId : 'candidateId' in fields ? fields.candidateId :
      'assignee' in fields ? fields.assignee : 'stage' in fields ? fields.stage : undefined;
    return fields.action + (detail ? ':' + detail : '');
  }
  async function perform(key: string, action: string, invoke: () => Promise<void>, retainedRetry = false) {
    if (props.disabled && !retainedRetry || busy.value || !retainedRetry && !allowed(action)) return;
    const attempt = Symbol(key);
    pendingAttempt = attempt;
    pendingKey.value = key;
    try { await invoke(); }
    finally { if (pendingAttempt === attempt) pendingKey.value = ''; }
  }
  const command = (fields: GateCommandFields) => perform(actionKey(fields), fields.action, () => controller.mutate(fields));
  async function deliveryCommand(action: DeliveryControl, note?: string) {
    const delivery = view.value?.delivery;
    if (!delivery || !delivery.allowedControls.includes(action)) return;
    if (action === 'confirm_stopped' && !note?.trim()) return;
    await command({ action, deliveryRunId: delivery.id, inputRevision: delivery.inputRevision, ...(action === 'confirm_stopped' ? { note: note!.trim() } : {}) });
  }
  const send = (value: GateActionCommand) => {
    if (value.requestId !== identity.value || requestOperations.get(identity.value)?.operationId !== value.operationId) return;
    return perform('retry', value.action, () => controller.send(value), true);
  };
  async function propose() {
    if (!scopeMutable.value || !mutable.value || !view.value || !proposedMessage.value.trim()) return;
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
    const note = draft("attestation").trim(), effort = reportedReviewMinutes(draft("review-minutes"));
    if (
      !mutable.value || !effort.valid ||
      !canAttest.value ||
      !humanReviewReady.value ||
      !note ||
      !view.value?.execution?.outputDigest
    )
      return;
    const requestId = view.value.id;
    await command({
      action: "attest", ...(effort.minutes === undefined ? {} : { reviewDurationMinutes: effort.minutes }),
      inputHash: view.value.inputHash,
      outputDigest: view.value.execution.outputDigest,
      ...(view.value.delivery?.review ? {
        inputRevision: view.value.inputRevision,
        candidateCommit: view.value.delivery.review.candidate.candidateCommit,
        candidateDigest: view.value.delivery.review.candidate.candidateDigest,
        humanOutcomes: deliveryHumanOutcomes(view.value.delivery.review, draft),
      } : {}),
      note,
    });
    if (view.value?.id === requestId && !error.value && review.value.evidence.attested) {
      notice.value = currentEvaluation('done')?.passed
        ? 'Acceptance recorded. The configured completion checks passed; merge remains separate.'
        : 'Acceptance recorded. Completion still needs attention; inspect the remaining findings.';
      await nextTick();
      document.getElementById('request-acceptance-recorded')?.focus();
    }
  }
  async function requestChanges() {
    const viewValue = view.value, review = viewValue?.delivery?.review, note = draft('attestation').trim();
    const effort = reportedReviewMinutes(draft('review-minutes'));
    if (!viewValue || !review || !mutable.value || !note || !effort.valid) return;
    const observations = deliveryHumanOutcomes(review, draft).filter(outcome => outcome.outcome === 'failed');
    const feedback = [note, ...observations.map(outcome => `${outcome.criterionId}: ${outcome.reason}`)].join('\n\n');
    if (feedback.length > 8000) { error.value = 'The review note and criterion observations must total 8,000 characters or fewer.'; return; }
    await command({
      action: 'request_changes', inputRevision: viewValue.inputRevision,
      candidateCommit: review.candidate.candidateCommit, candidateDigest: review.candidate.candidateDigest,
      note: feedback, humanOutcomes: observations, ...(effort.minutes === undefined ? {} : { reviewDurationMinutes: effort.minutes }),
    });
  }
  function chooseRequest(id: string) {
    void controller.select(id);
  }
  watch([sessionId, () => props.requestId, () => state.unlocked], () => {
    pendingKey.value = '';
    controller.invalidate();
    if (state.unlocked) void load(true);
  });
  useBoundedPolling(() => load(), computed(() => state.paused || !state.unlocked || !active.value), 1000);
  onMounted(() => { void load(true); });
  onDeactivated(() => { active.value = false; controller.suspend(); });
  onActivated(() => { if (!active.value) { active.value = true; controller.resume(); void load(true); } });
  onBeforeUnmount(() => controller.dispose());

  return {
    acceptanceFinding,
    isPending,
    review,
    sharedRequest,
    scopeMutable,
    activeExecution,
    activeReview,
    attest,
    busy,
    canAttest,
    chooseRequest,
    command,
    currentEvaluation,
    date,
    deliveryCommand,
    draft,
    error,
    gateLabel,
    gateState,
    humanReviewReady,
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
    requestChanges,
    rows,
    send,
    setDraft,
    stage,
    view,
  };
}
