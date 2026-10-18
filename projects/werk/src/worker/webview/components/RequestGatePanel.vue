<script setup lang="ts">
import UButton from '@nuxt/ui/components/Button.vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import USelect from '@nuxt/ui/components/Select.vue';
import UTextarea from '@nuxt/ui/components/Textarea.vue';
import UAlert from '@nuxt/ui/components/Alert.vue';
import RequestGateEvidence from './RequestGateEvidence.vue';
import MessageContent from './MessageContent.vue';
import type { WorkerRequest } from '../../application/request-gates';
import { useRequestGatePanel } from './useRequestGatePanel';
const props = defineProps<{ requestId?: string; sessionId?: string; featureSource?: string; summary?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ change: [WorkerRequest | null] }>();
const {
  sharedRequest, scopeMutable, activeExecution, activeReview, attest, busy, canAttest,
  chooseRequest, command, currentEvaluation, date, draft, error, gateLabel, gateState,
  identity, load, loading, mutable, notice, openFindings, operation, pendingCandidates,
  pendingModel, phaseLabel, propose, proposedMessage, resolveFinding, rows, send,
  setDraft, stage, view, acceptanceFinding, isPending, review,
} = useRequestGatePanel(props, emit);
</script>
<template>
  <section v-if="view || loading || error" class="request-gate-panel" aria-labelledby="request-gate-title">
    <div class="request-gate-heading">
      <div>
        <h2 id="request-gate-title">{{ props.summary === false ? 'Review actions' : 'Feature Request review' }}</h2>
        <p v-if="view && props.summary !== false">{{ phaseLabel(view.phase) }} · input revision {{ view.inputRevision }}</p>
      </div>
      <UButton variant="outline" size="sm" :loading="loading" :disabled="busy" @click="load(true)">Refresh request</UButton>
    </div>
    <UAlert v-if="error" color="error" variant="subtle" :description="error" />
    <p v-if="gateState.stale && view" class="request-gate-note">These are the last saved details. Refresh the request before making another change.</p>
    <p v-if="notice" class="request-gate-notice" role="status">{{ notice }}</p>
    <template v-if="view">
      <div v-if="!props.requestId && rows.length > 1" class="request-selection">
        <label for="request-selector">Request in this conversation</label>
        <USelect
          id="request-selector"
          :model-value="identity"
          :items="rows.map(row => ({ value: row.id, label: row.title + ' · ' + phaseLabel(row.phase) }))"
          :disabled="busy"
          @update:model-value="chooseRequest(String($event))"
        />
      </div>
      <div v-if="props.summary !== false" class="request-next-step">
        <p class="request-next-label">Next step</p>
        <h3>{{ review.nextStep.title }}</h3>
        <p>{{ review.nextStep.description }}</p>
        <div class="request-gate-badges" aria-label="Current request checks">
          <UBadge :color="currentEvaluation('ready')?.passed ? 'success' : 'neutral'" variant="subtle">Readiness · {{ gateLabel('ready') }}</UBadge>
          <UBadge :color="currentEvaluation('done')?.passed ? 'success' : 'neutral'" variant="subtle">Completion · {{ gateLabel('done') }}</UBadge>
        </div>
      </div>
      <div v-if="operation" class="request-operation">
        <p>The worker's acknowledgement is uncertain. Your original action is retained. Retry it to confirm the result without submitting duplicate work.</p>
        <UButton variant="outline" :loading="isPending('retry')" :disabled="busy || props.disabled" @click="send(operation)">Retry saved action</UButton>
      </div>
      <form v-if="canAttest" id="request-attestation" class="request-attestation" @submit.prevent="attest">
        <h3>Record your review</h3>
        <p>This request requires human acceptance. Review its result and evidence, then record your acceptance note for this exact input and output.</p>
        <label for="request-attestation-note">Acceptance note</label>
        <UTextarea
          id="request-attestation-note"
          :model-value="draft('attestation')"
          maxlength="8000"
          :rows="3"
          :disabled="!mutable"
          @update:model-value="setDraft('attestation', String($event))"
        />
        <p class="request-gate-note">Recording acceptance re-evaluates the saved completion evidence. It does not run verification commands or merge changes.</p>
        <UButton type="submit" :disabled="!mutable || !draft('attestation').trim()" :loading="isPending('attest')">Record acceptance</UButton>
      </form>
      <div v-else-if="review.evidence.attested" id="request-acceptance-recorded" class="request-attestation-recorded" tabindex="-1">
        <h3>Acceptance recorded for this result</h3>
        <p>Your note is saved for the current input and output. {{ currentEvaluation('done')?.passed ? 'The configured completion rules passed; merge remains a separate human action.' : 'Completion still needs attention. Inspect the remaining findings before evaluating again.' }}</p>
        <details><summary>Read acceptance note</summary><MessageContent :text="view.attestation!.note" /></details>
      </div>
      <p v-if="pendingModel">The model is waiting for input. Answer its checkpoint in the interaction or the linked Task note.</p>
      <p v-if="activeExecution">The worker is {{ view.execution?.status === 'prepared' ? 'queued' : 'running' }} with its accepted scope. Its task controls can stop the invocation.</p>
      <p v-if="activeReview" role="status">An instruction review or proposal is queued or running. It cannot accept its own proposal or satisfy verified checks.</p>
      <div v-if="!['done', 'cancelled'].includes(view.phase) && !pendingModel && !activeExecution && !activeReview" class="request-gate-actions">
        <UButton
          v-if="scopeMutable && stage === 'ready' && !view.owner.remote"
          :disabled="!mutable"
          :loading="isPending('execute')"
          @click="command({ action: 'execute' })"
        >Check readiness and queue work</UButton>
        <UButton
          :variant="review.evidence.attested ? 'solid' : 'outline'"
          :disabled="!mutable"
          :loading="isPending('evaluate:' + stage)"
          @click="command({ action: 'evaluate', stage })"
        >{{ stage === 'done' ? 'Evaluate completion rules' : 'Evaluate readiness rules' }}</UButton>
      </div>
      <p v-if="sharedRequest" class="request-gate-note">This shared Feature Request keeps its accepted scope. Use its Task checkpoint to continue; changed scope belongs in a new Feature Request.</p>
      <details class="request-evidence" :open="view.phase === 'needs_rework' && !canAttest">
        <summary>Checks and findings · {{ openFindings.length }} open</summary>
        <p>Model completion, verified checks, human acceptance and merge are separate. Unknown or outdated evidence cannot pass a check.</p>
        <RequestGateEvidence v-for="stageName in ['ready', 'done'] as const" :key="stageName" :stage="stageName" :evaluation="currentEvaluation(stageName)" />
        <article v-for="finding in openFindings" :key="finding.id" class="request-finding">
          <div class="request-gate-badges">
            <UBadge :color="finding.blocking ? 'warning' : 'neutral'" variant="subtle">{{ finding.blocking ? 'Blocking finding' : 'Advisory finding' }}</UBadge>
            <small>{{ finding.source === 'deterministic' ? 'Configured rule' : finding.source === 'reviewer' ? 'Model review' : 'Operator' }}</small>
          </div>
          <MessageContent :text="finding.message" />
          <p v-if="acceptanceFinding(finding)">
            {{ review.evidence.attested ? 'Acceptance is recorded. Evaluate completion rules to update this finding.' : 'Use the acceptance note above to record your review. A finding resolution cannot substitute for acceptance.' }}
          </p>
          <details v-else-if="finding.source !== 'deterministic'">
            <summary>Record a resolution for this finding</summary>
            <p>This note resolves the finding only. It does not record acceptance or satisfy a failed verification rule.</p>
            <form @submit.prevent="resolveFinding(finding.id)">
              <label :for="'finding-' + finding.id">Resolution note</label>
              <UTextarea
                :id="'finding-' + finding.id"
                :model-value="draft(finding.id)"
                maxlength="8000"
                :rows="3"
                :disabled="!mutable"
                @update:model-value="setDraft(finding.id, String($event))"
              />
              <UButton type="submit" variant="outline" :loading="isPending('resolve_finding:' + finding.id)" :disabled="!mutable || !draft(finding.id).trim()">Record resolution</UButton>
            </form>
          </details>
        </article>
        <p v-if="!openFindings.length">No open findings are recorded. The current check results determine whether the request can proceed.</p>
      </details>
      <details class="request-advanced">
        <summary>Advanced request controls</summary>
        <p v-if="scopeMutable">Rework owner: {{ view.assignee === 'operator' ? 'Human operator' : 'Model' }}. Instruction proposals change the request text; they do not implement a coding fix.</p>
        <div v-if="scopeMutable && !['done', 'cancelled'].includes(view.phase)" class="request-gate-actions">
          <UButton
            variant="outline"
            :disabled="!mutable || view.assignee === 'operator'"
            :loading="isPending('assign:operator')"
            @click="command({ action: 'assign', assignee: 'operator' })"
          >Assign instruction rework to human</UButton>
          <UButton
            variant="outline"
            :disabled="!mutable || view.assignee === 'llm'"
            :loading="isPending('assign:llm')"
            @click="command({ action: 'assign', assignee: 'llm' })"
          >Assign instruction rework to model</UButton>
          <UButton
            v-if="['needs_rework', 'review'].includes(view.phase)"
            variant="outline"
            :disabled="!mutable || view.reworkCount >= view.policy.rework.maxAttempts"
            :loading="isPending('rework:' + stage)"
            @click="command({ action: 'rework', stage })"
          >Ask model for an instruction proposal</UButton>
        </div>
        <p v-if="scopeMutable && ['needs_rework', 'review'].includes(view.phase)" class="request-gate-note">A model proposal uses the worker's execution slot and provider allowance. Accepting it is a separate action.</p>
        <details v-if="scopeMutable && !view.owner.remote && !['done', 'cancelled'].includes(view.phase)">
          <summary>Propose a revised instruction</summary>
          <form @submit.prevent="propose">
            <label for="request-candidate-message">Candidate instruction</label>
            <UTextarea id="request-candidate-message" v-model="proposedMessage" maxlength="64000" :rows="5" :disabled="!mutable" />
            <p>A proposal leaves accepted scope unchanged. Acceptance creates an explicit input revision; approved files and captured context stay frozen.</p>
            <UButton
              type="submit"
              variant="outline"
              :loading="isPending('propose')"
              :disabled="!mutable || !proposedMessage.trim() || proposedMessage === view.input.message"
            >Save instruction proposal</UButton>
          </form>
        </details>
        <article v-for="candidate in pendingCandidates" :key="candidate.id" class="request-candidate">
          <h3>Instruction proposal · {{ candidate.source === 'reviewer' ? 'Model' : 'Operator' }}</h3>
          <p>Based on input revision {{ candidate.basedOnInputRevision }} · {{ date(candidate.createdAt) }}</p>
          <details><summary>Read proposed instruction</summary><MessageContent :text="candidate.input.message" /></details>
          <p v-if="!scopeMutable">This earlier proposal is retained as evidence. Changed shared scope requires a new Feature Request.</p>
          <p v-else>Accepting queues work only if readiness passes. The original feature body and approved file snapshots remain retained.</p>
          <UButton
            v-if="scopeMutable"
            :disabled="!mutable || !!view.owner.remote || candidate.basedOnInputRevision !== view.inputRevision || view.reworkCount >= view.policy.rework.maxAttempts"
            :loading="isPending('accept_candidate:' + candidate.id)"
            @click="command({ action: 'accept_candidate', candidateId: candidate.id })"
          >Accept instruction and evaluate readiness</UButton>
        </article>
        <details v-if="view.reviews.length">
          <summary>Model review and instruction proposals · {{ view.reviews.length }}</summary>
          <article v-for="attempt in view.reviews" :key="attempt.id" class="request-review-attempt">
            <h3>{{ attempt.kind === 'rework' ? 'Instruction proposal' : 'Model review' }} · {{ attempt.status }}</h3>
            <p>{{ attempt.provider.id }} · {{ attempt.provider.model }} · {{ date(attempt.createdAt) }}</p>
            <p v-if="attempt.errorCode">Attempt did not complete: {{ attempt.errorCode }}. This does not satisfy any check.</p>
            <MessageContent v-if="attempt.result?.summary" :text="attempt.result.summary" />
          </article>
        </details>
        <p v-if="view.owner.remote">This request belongs to an orchestrator assignment. Changed input requires an explicit successor and fresh upstream lease.</p>
        <details>
          <summary>Frozen policy and request identity</summary>
          <p>{{ view.id }} · request revision {{ view.revision }} · policy {{ view.policy.id }} v{{ view.policy.version }} · {{ view.policyDigest }}</p>
          <p v-if="view.execution?.outputDigest">Input {{ view.inputHash }} · output {{ view.execution.outputDigest }}. An acceptance note does not prove verified human identity or that tests ran.</p>
          <pre tabindex="0" aria-label="Frozen request gate policy">{{ JSON.stringify(view.policy, null, 2) }}</pre>
        </details>
      </details>
      <details v-if="!['done', 'cancelled'].includes(view.phase)">
        <summary>Cancel this request</summary>
        <p>Stop a running invocation through its task controls first. Cancellation keeps the recorded evidence and does not imply completion.</p>
        <UButton
          color="error"
          variant="outline"
          :loading="isPending('cancel')"
          :disabled="activeExecution || busy || loading || gateState.stale || !!operation || props.disabled"
          @click="command({ action: 'cancel' })"
        >Cancel request</UButton>
      </details>
    </template>
  </section>
</template>
<style scoped src="./request-gate-panel.css"></style>
