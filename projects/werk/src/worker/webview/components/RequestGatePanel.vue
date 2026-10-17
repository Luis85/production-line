<script lang="ts">
import { reactive, watch as watchPrivateDrafts } from "vue";
import { state as privateWorkerState } from "../store";
import type { GateActionCommand } from "../request-gate-controller";
const requestDrafts = reactive(new Map<string, string>());
const requestOperations = reactive(new Map<string, GateActionCommand>());
watchPrivateDrafts(
  () => privateWorkerState.draftEpoch,
  () => {
    requestDrafts.clear();
    requestOperations.clear();
  },
  { flush: "sync" },
);
</script>
<script setup lang="ts">
import { computed, onActivated, onDeactivated, onBeforeUnmount, onMounted, ref, watch, toRaw, toRef } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import UTextarea from "@nuxt/ui/components/Textarea.vue";
import UAlert from "@nuxt/ui/components/Alert.vue";
import MessageContent from "./MessageContent.vue";
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
const props = defineProps<{ requestId?: string; sessionId?: string }>();
const emit = defineEmits<{ change: [WorkerRequest | null] }>();
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
function observed(value: string | number | boolean | null) {
  return value === null ? "Unknown" : String(value);
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
</script>
<template>
  <section
    v-if="view || loading || error"
    class="request-gate-panel"
    aria-labelledby="request-gate-title"
  >
    <div class="request-gate-heading">
      <div>
        <h2 id="request-gate-title">Request lifecycle</h2>
        <p v-if="view">
          <strong>{{ phaseLabel(view.phase) }}</strong> ·
          {{ view.input.kind }} · input revision {{ view.inputRevision }}
        </p>
      </div>
      <UButton
        variant="outline"
        size="sm"
        :loading="loading"
        :disabled="busy"
        @click="load(true)"
        >Refresh request</UButton
      >
    </div>
    <UAlert v-if="error" color="error" variant="subtle" :description="error" />
    <p v-if="gateState.stale && view" class="request-gate-note">Request data needs revalidation before another change. Refresh the request to retry.</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <template v-if="view">
      <div v-if="!props.requestId && rows.length > 1" class="request-selection">
        <label for="request-selector">Request in this conversation</label
        ><USelect
          id="request-selector"
          :model-value="identity"
          :items="
            rows.map((row) => ({
              value: row.id,
              label: row.title + ' · ' + phaseLabel(row.phase),
            }))
          "
          :disabled="busy"
          @update:model-value="chooseRequest(String($event))"
        />
      </div>
      <p class="request-gate-note">
        Request phase is separate from the model outcome:
        <strong>{{
          view.execution?.outcome ?? "no invocation outcome recorded"
        }}</strong
        >. A completed model turn does not prove tests, acceptance or merge.
      </p>
      <div class="request-gate-badges">
        <UBadge
          :color="currentEvaluation('ready')?.passed ? 'success' : 'warning'"
          variant="subtle"
          >Ready · {{ gateLabel("ready") }}</UBadge
        ><UBadge
          :color="currentEvaluation('done')?.passed ? 'success' : 'warning'"
          variant="subtle"
          >Done · {{ gateLabel("done") }}</UBadge
        ><UBadge color="neutral" variant="subtle"
          >Rework owner ·
          {{ view.assignee === "operator" ? "Human operator" : "LLM" }}</UBadge
        >
      </div>
      <details :open="view.phase === 'needs_rework' || view.phase === 'review'">
        <summary>
          Gate evidence and open findings · {{ openFindings.length }}
        </summary>
        <section
          v-for="stageName in ['ready', 'done'] as const"
          :key="stageName"
          class="request-gate-stage"
        >
          <h3>
            {{
              stageName === "ready"
                ? "Definition of ready"
                : "Definition of done"
            }}
          </h3>
          <p v-if="!currentEvaluation(stageName)">
            No evaluation for the current approved input{{
              stageName === "done" ? " and known output" : ""
            }}.
          </p>
          <div
            v-else
            class="request-gate-table"
            tabindex="0"
            role="region"
            :aria-label="stageName + ' gate evidence'"
          >
            <table>
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Expected</th>
                  <th>Observed evidence</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="rule in currentEvaluation(stageName)!.rules"
                  :key="rule.ruleId"
                >
                  <td>
                    {{ rule.ruleId }}<small>{{ rule.fact }}</small>
                  </td>
                  <td>{{ observed(rule.expected) }}</td>
                  <td>{{ observed(rule.observed) }}</td>
                  <td>{{ rule.result }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <p>
          Unknown facts are not success. Deterministic failures require actual
          changed evidence; dismissing a finding cannot satisfy its rule.
        </p>
        <article
          v-for="finding in openFindings"
          :key="finding.id"
          class="request-finding"
        >
          <div class="request-gate-badges">
            <UBadge
              :color="finding.blocking ? 'warning' : 'neutral'"
              variant="subtle"
              >{{ finding.kind }} ·
              {{ finding.blocking ? "blocking" : "advisory" }}</UBadge
            ><small>{{ finding.source }} · {{ finding.id }}</small>
          </div>
          <MessageContent :text="finding.message" />
          <form
            v-if="finding.source !== 'deterministic'"
            @submit.prevent="resolveFinding(finding.id)"
          >
            <label :for="'finding-' + finding.id"
              >Operator resolution note</label
            ><UTextarea
              :id="'finding-' + finding.id"
              :model-value="draft(finding.id)"
              maxlength="8000"
              :rows="3"
              :disabled="!mutable"
              @update:model-value="setDraft(finding.id, String($event))"
            /><UButton
              type="submit"
              variant="outline"
              :loading="busy"
              :disabled="!mutable || !draft(finding.id).trim()"
              >Record finding resolution</UButton
            >
          </form>
        </article>
        <p v-if="!openFindings.length">
          No open findings are recorded. Check the gate results before treating
          the request as ready or done.
        </p>
      </details>
      <p v-if="pendingModel">
        The model is waiting for input. Answer its checkpoint in the interaction
        controls; request companion edits do not answer it.
      </p>
      <p v-if="activeExecution">
        The prepared or running invocation retains its approved input and
        policy. Finish or stop that invocation before changing the request.
      </p>
      <div v-if="activeReview" role="status">
        <p>
          LLM review/rework is queued or running in the same worker execution
          slot. Its suggestions cannot satisfy deterministic facts or accept
          their own candidate.
        </p>
      </div>
      <div v-if="!['done', 'cancelled'].includes(view.phase)" class="request-gate-actions">
        <UButton
          v-if="stage === 'ready' && !view.owner.remote"
          :disabled="!mutable"
          :loading="busy"
          @click="command({ action: 'execute' })"
          >Evaluate ready and queue execution</UButton
        ><UButton
          variant="outline"
          :disabled="!mutable"
          :loading="busy"
          @click="command({ action: 'evaluate', stage })"
          >Evaluate {{ stage }} gate</UButton
        ><UButton
          variant="outline"
          :disabled="!mutable || view.assignee === 'operator'"
          @click="command({ action: 'assign', assignee: 'operator' })"
          >Assign rework to human</UButton
        ><UButton
          variant="outline"
          :disabled="!mutable || view.assignee === 'llm'"
          @click="command({ action: 'assign', assignee: 'llm' })"
          >Assign rework to LLM</UButton
        ><UButton
          v-if="['needs_rework', 'review'].includes(view.phase)"
          variant="outline"
          :disabled="
            !mutable || view.reworkCount >= view.policy.rework.maxAttempts
          "
          :loading="busy"
          @click="command({ action: 'rework', stage })"
          >Queue one LLM rework proposal</UButton
        >
      </div>
      <details
        v-if="!view.owner.remote && !['done', 'cancelled'].includes(view.phase)"
      >
        <summary>Propose a revised instruction</summary>
        <form @submit.prevent="propose">
          <label for="request-candidate-message">Candidate instruction</label
          ><UTextarea
            id="request-candidate-message"
            v-model="proposedMessage"
            maxlength="64000"
            :rows="5"
            :disabled="!mutable"
          />
          <p>
            A proposal does not change accepted input. Kind, approved files and
            captured context stay frozen; acceptance creates an explicit input
            revision.
          </p>
          <UButton
            type="submit"
            variant="outline"
            :disabled="
              !mutable ||
              !proposedMessage.trim() ||
              proposedMessage === view.input.message
            "
            >Propose candidate for review</UButton
          >
        </form>
      </details>
      <article
        v-for="candidate in pendingCandidates"
        :key="candidate.id"
        class="request-candidate"
      >
        <h3>Candidate · {{ candidate.source }}</h3>
        <p>
          Based on input revision {{ candidate.basedOnInputRevision }} ·
          {{ date(candidate.createdAt) }}
        </p>
        <details>
          <summary>Review candidate instruction</summary>
          <MessageContent :text="candidate.input.message" />
        </details>
        <p>
          Accepting queues a new invocation only if its ready gate passes. The
          original feature body and approved file snapshots remain retained.
        </p>
        <UButton
          :disabled="
            !mutable ||
            !!view.owner.remote ||
            candidate.basedOnInputRevision !== view.inputRevision ||
            view.reworkCount >= view.policy.rework.maxAttempts
          "
          :loading="busy"
          @click="
            command({ action: 'accept_candidate', candidateId: candidate.id })
          "
          >Accept candidate and evaluate readiness</UButton
        >
      </article>
      <form
        v-if="canAttest && !['done', 'cancelled'].includes(view.phase)"
        class="request-attestation"
        @submit.prevent="attest"
      >
        <h3>Operator attestation</h3>
        <p>
          This policy includes operator acceptance. Your explicit note applies
          to input {{ view.inputHash.slice(0, 12) }} and output
          {{ view.execution!.outputDigest!.slice(0, 12) }}. It does not claim
          verified human identity or prove that tests ran.
        </p>
        <label for="request-attestation-note">Acceptance note</label
        ><UTextarea
          id="request-attestation-note"
          :model-value="draft('attestation')"
          maxlength="8000"
          :rows="3"
          :disabled="!mutable"
          @update:model-value="setDraft('attestation', String($event))"
        /><UButton
          type="submit"
          :disabled="!mutable || !draft('attestation').trim()"
          :loading="busy"
          >Record attestation for this input and output</UButton
        >
      </form>
      <details v-if="view.reviews.length">
        <summary>
          Reviewer and rework attempts · {{ view.reviews.length }}
        </summary>
        <article
          v-for="attempt in view.reviews"
          :key="attempt.id"
          class="request-review-attempt"
        >
          <h3>
            {{ attempt.kind === "rework" ? "Rework proposal" : "Reviewer" }} ·
            {{ attempt.status }}
          </h3>
          <p>
            {{ attempt.provider.id }} · {{ attempt.provider.model }} ·
            {{ date(attempt.createdAt) }}
          </p>
          <p>
            Stage {{ attempt.stage }} · intent {{ attempt.id }} · run
            {{ attempt.runId ?? "not admitted" }}
          </p>
          <p v-if="attempt.errorCode" role="status">
            Attempt did not complete: {{ attempt.errorCode }}. Its failure does
            not satisfy any gate.
          </p>
          <MessageContent
            v-if="attempt.result?.summary"
            :text="attempt.result.summary"
          />
        </article>
      </details>
      <p v-if="view.owner.remote">
        This request belongs to an orchestrator assignment. Changed input
        requires an explicit successor and fresh upstream lease; local
        candidates do not reroute it.
      </p>
      <details>
        <summary>Frozen policy and request identity</summary>
        <p>
          {{ view.id }} · request revision {{ view.revision }} · policy
          {{ view.policy.id }} v{{ view.policy.version }} ·
          {{ view.policyDigest }}
        </p>
        <pre tabindex="0" aria-label="Frozen request gate policy">{{
          JSON.stringify(view.policy, null, 2)
        }}</pre>
      </details>
      <div v-if="operation" class="request-operation">
        <p>
          The acknowledgement is uncertain. Retry this same operation ID; no new
          operation has been created.
        </p>
        <UButton variant="outline" :loading="busy" @click="send(operation)"
          >Retry same request operation</UButton
        >
      </div>
      <details v-if="!['done', 'cancelled'].includes(view.phase)">
        <summary>Cancel this request</summary>
        <p>
          Stop a running invocation through its task controls first.
          Cancellation does not imply successful completion or erase retained
          evidence.
        </p>
        <UButton
          color="error"
          variant="outline"
          :disabled="activeExecution || busy || loading || gateState.stale || !!operation"
          @click="command({ action: 'cancel' })"
          >Cancel request</UButton
        >
      </details>
    </template>
  </section>
</template>
<style scoped>
.request-gate-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  padding-block: 24px;
  border-block: 1px solid var(--line, #3b4b56);
  min-width: 0;
}
.request-gate-panel > *,
.request-gate-stage {
  min-width: 0;
}
.request-gate-panel p,
.request-gate-panel small,
.request-gate-panel summary {
  overflow-wrap: anywhere;
}
.request-gate-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.request-gate-heading h2 {
  margin: 0 0 8px;
  font-size: 18px;
}
.request-gate-panel p {
  margin: 0;
  max-width: 75ch;
  line-height: 1.65;
  color: var(--muted, #b5c4cd);
}
.request-gate-panel h3 {
  margin: 20px 0 12px;
  font-size: 16px;
}
.request-gate-badges,
.request-gate-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.request-selection {
  display: grid;
  gap: 8px;
  max-width: 620px;
}
summary {
  min-height: 44px;
  cursor: pointer;
  padding-block: 12px;
  font-weight: 600;
}
.request-gate-table {
  min-width: 0;
  width: 100%;
  overflow: auto;
  max-width: 100%;
  margin: 16px 0;
}
.request-gate-table table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  text-align: left;
  font-size: 13px;
}
.request-gate-table th,
.request-gate-table td {
  padding: 12px 8px;
  border-bottom: 1px solid var(--line, #3b4b56);
  vertical-align: top;
  min-width: 0;
  overflow-wrap: anywhere;
}
.request-gate-table small {
  display: block;
  margin-top: 6px;
  color: var(--muted, #b5c4cd);
}
.request-finding,
.request-candidate {
  padding-block: 20px;
  border-top: 1px solid var(--line, #3b4b56);
  display: grid;
  gap: 12px;
  min-width: 0;
}
form {
  display: grid;
  gap: 12px;
  margin-top: 16px;
  min-width: 0;
}
form > button,
.request-operation > button {
  justify-self: start;
}
label {
  font-weight: 600;
  font-size: 14px;
}
pre {
  white-space: pre;
  overflow: auto;
  max-width: 100%;
  padding: 16px;
  border: 1px solid var(--line, #3b4b56);
  border-radius: 12px;
  font-size: 13px;
  margin: 16px 0;
}
.request-operation {
  display: grid;
  gap: 12px;
}
@media (max-width: 600px) {
  .request-gate-heading > button {
    width: 100%;
    justify-content: center;
  }
  .request-gate-actions > button {
    width: 100%;
    justify-content: center;
  }
}
</style>
