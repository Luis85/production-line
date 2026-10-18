<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import UTextarea from "@nuxt/ui/components/Textarea.vue";
import UAlert from "@nuxt/ui/components/Alert.vue";
import RequestGateEvidence from './RequestGateEvidence.vue';
import MessageContent from "./MessageContent.vue";
import type { WorkerRequest } from "../../application/request-gates";
import { useRequestGatePanel } from "./useRequestGatePanel";
const props = defineProps<{ requestId?: string; sessionId?: string }>();
const emit = defineEmits<{ change: [WorkerRequest | null] }>();
const {
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
} = useRequestGatePanel(props, emit);
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
      <p v-if="sharedRequest" class="request-gate-note">This shared Feature Request keeps its accepted scope and checks. Answer its Task checkpoint to continue; create a new Feature Request for changed scope. Evidence, attestation and cancellation remain available here.</p>
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
        <RequestGateEvidence
          v-for="stageName in ['ready', 'done'] as const"
          :key="stageName"
          :stage="stageName"
          :evaluation="currentEvaluation(stageName)"
        />
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
        The model is waiting for input. Answer its checkpoint here or use the
        linked Task note when available.
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
          v-if="scopeMutable && stage === 'ready' && !view.owner.remote"
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
          v-if="scopeMutable"
          :disabled="!mutable || view.assignee === 'operator'"
          @click="command({ action: 'assign', assignee: 'operator' })"
          >Assign rework to human</UButton
        ><UButton
          variant="outline"
          v-if="scopeMutable"
          :disabled="!mutable || view.assignee === 'llm'"
          @click="command({ action: 'assign', assignee: 'llm' })"
          >Assign rework to LLM</UButton
        ><UButton
          v-if="scopeMutable && ['needs_rework', 'review'].includes(view.phase)"
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
        v-if="scopeMutable && !view.owner.remote && !['done', 'cancelled'].includes(view.phase)"
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
        <p v-if="!scopeMutable">This earlier proposal is retained as evidence. Changed shared scope requires a new Feature Request.</p>
        <p v-else>
          Accepting queues a new invocation only if its ready gate passes. The
          original feature body and approved file snapshots remain retained.
        </p>
        <UButton
          v-if="scopeMutable"
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
<style scoped src="./request-gate-panel.css"></style>
