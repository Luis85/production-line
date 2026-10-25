<script setup lang="ts">
import { computed, shallowRef } from 'vue';
import { useRoute } from 'vue-router';
import UButton from '@nuxt/ui/components/Button.vue';
import UIcon from '@nuxt/ui/components/Icon.vue';
import AcceptedModelSelection from '../components/AcceptedModelSelection.vue';
import MessageContent from '../components/MessageContent.vue';
import AssistantMessage from '../components/AssistantMessage.vue';
import CandidateEvidence from '../components/CandidateEvidence.vue';
import FeatureRequestNote from '../components/FeatureRequestNote.vue';
import PatchReview from '../components/PatchReview.vue';
import RequestGatePanel from '../components/RequestGatePanel.vue';
import RequestGateEvidence from '../components/RequestGateEvidence.vue';
import DeliveryRunPanel from '../components/DeliveryRunPanel.vue';
import RequestActivityPanel from '../components/RequestActivityPanel.vue';
import DeliveryReviewEvidence from '../components/DeliveryReviewEvidence.vue';
import { buildFeatureReviewView } from '../feature-review';
import { readFeatureReview, reviewActionHref, reviewIdentity } from '../review-reader';
import { useWorkerSnapshot } from '../useWorkerSnapshot';
import { state, request, date } from '../store';
import type { WorkerRequest } from '../../application/request-gates';

const route = useRoute();
const identity = computed(() => reviewIdentity(route.query));
const { data, error, loading, refreshing, readAt, now, refresh } = useWorkerSnapshot(
  () => readFeatureReview(identity.value, request), [() => identity.value.sessionId, () => identity.value.fileId],
);
const gateRevision = shallowRef<{ id: string; revision: number } | null>(null);
const gateMismatch = computed(() => gateRevision.value?.id === data.value?.request?.id && gateRevision.value?.revision !== data.value?.request?.revision);
const stale = computed(() => state.paused || !!error.value || gateMismatch.value || !readAt.value || now.value - Date.parse(readAt.value) > 15000);
const review = computed(() => buildFeatureReviewView({ ...data.value, interaction: data.value?.session.interaction, freshness: { stale: stale.value, error: error.value, readAt: readAt.value } }));
const conversation = computed(() => '/taskboard?session=' + encodeURIComponent(data.value?.session.id ?? identity.value.sessionId));
const action = computed(() => review.value.nextStep.action);
const nextHref = computed(() => {
  const href = reviewActionHref(action.value?.kind, data.value?.session.id ?? '');
  return href.startsWith('#') ? { path: route.path, query: route.query, hash: href } : href;
});
const goal = computed(() => data.value?.request?.input.message ?? data.value?.task?.instruction);
const criteria = computed(() => data.value?.request?.input.criteria ?? data.value?.task?.criteria ?? []);
const currentResult = computed(() => {
  const request = data.value?.request, execution = request?.execution;
  if (request?.delivery && !review.value.evidence.deliveryReview) return null;
  return execution?.inputRevision === request?.inputRevision && execution?.result?.type === 'completed' ? execution.result.text : null;
});
const result = computed(() => currentResult.value ?? data.value?.chat.messages.findLast(message => message.role === 'assistant' && message.state === 'complete')?.text);
const actor = computed(() => ({ operator: 'Your next step', worker: 'Worker’s next step', owning_worker: 'Owning worker’s next step', orchestrator: 'Orchestrator’s next step' })[review.value.nextStep.actor]);
const stageLabels = { pending: 'Not yet', active: 'In progress', complete: 'Complete', blocked: 'Needs attention', unknown: 'Not confirmed' };
function requestChanged(value: WorkerRequest | null) {
  if (value) gateRevision.value = { id: value.id, revision: value.revision };
  if (value && data.value?.request?.id === value.id && data.value.request.revision !== value.revision && !loading.value) void refresh();
}
</script>
<template>
  <section class="feature-review" aria-labelledby="review-title">
    <nav class="review-breadcrumb" aria-label="Breadcrumb"><RouterLink to="/taskboard"><UIcon name="i-lucide-arrow-left" />Taskboard</RouterLink><span aria-hidden="true">/</span><span>Feature request review</span></nav>
    <header class="review-heading">
      <div><h1 id="review-title" tabindex="-1">{{ data ? review.title : 'Review a feature request' }}</h1></div>
      <div class="review-header-actions"><UButton v-if="data" :to="conversation" color="neutral" variant="outline" icon="i-lucide-message-circle">Open conversation</UButton><UButton color="neutral" variant="ghost" icon="i-lucide-refresh-cw" :loading="refreshing" :disabled="!state.unlocked" @click="refresh">Refresh review</UButton></div>
    </header>
    <p v-if="!state.unlocked" class="review-notice" role="status">Unlock the worker to inspect private request evidence.</p>
    <p v-else-if="loading && !data" class="review-notice" role="status">Loading this feature request and its saved evidence…</p>
    <p v-if="error" class="review-notice error-text" role="alert">{{ error }}{{ data ? ' The last matching review is shown; decisions are unavailable until refreshed.' : '' }}</p>
    <template v-if="data && state.unlocked">
      <div class="review-meta"><span>{{ review.ownership.label }}</span><span v-if="review.identity.featureId">FR {{ review.identity.featureId }}</span><span>{{ state.paused ? 'Updates paused · last successful update' : stale ? 'Evidence may be out of date · last successful update' : 'Last updated' }} {{ date(readAt) }}</span></div>
      <section class="review-next" aria-labelledby="review-next-title" :class="{ 'needs-refresh': stale }">
        <div><p class="eyebrow">{{ actor }}</p><h2 id="review-next-title">{{ review.nextStep.title }}</h2><p>{{ review.nextStep.description }}</p></div>
        <UButton v-if="action?.kind === 'refresh'" :loading="refreshing" :disabled="!state.unlocked" @click="refresh">{{ action.label }}</UButton>
        <UButton v-else-if="action" :to="nextHref">{{ action.label }}<UIcon name="i-lucide-arrow-down-right" /></UButton>
      </section>
      <ol v-if="!data.request?.delivery" class="review-stages" aria-label="Feature request progress">
        <li v-for="(stage, index) in review.stages" :key="stage.id" :class="'stage-' + stage.state"><span class="stage-number" aria-hidden="true"><UIcon v-if="stage.state === 'complete'" name="i-lucide-check" /><template v-else>{{ index + 1 }}</template></span><div><strong>{{ stage.label }}</strong><span class="stage-state">{{ stageLabels[stage.state] }}</span><p>{{ stage.detail }}</p></div></li>
      </ol>
      <nav class="review-sections" aria-label="Review sections"><a href="#review-goal">Accepted request</a><a v-if="data.request?.delivery" href="#review-progress">Delivery progress</a><a href="#review-changes">{{ data.task ? 'Changes' : 'Result' }}</a><a href="#review-checks">Checks</a><a href="#review-decision">Decision</a><a v-if="data.request?.delivery" href="#review-activity">Activity</a><a v-if="data.shared" href="#review-handoff">Team handoff</a></nav>
      <DeliveryRunPanel v-if="data.request?.delivery" :request="data.request" />
      <section id="review-goal" class="review-section" aria-labelledby="review-goal-title">
        <div class="section-heading"><h2 id="review-goal-title">Accepted request</h2><span v-if="data.request" class="section-caption">Scope revision {{ data.request.inputRevision }}</span></div>
        <AcceptedModelSelection :selection="review.selection" />
        <MessageContent v-if="goal" :text="goal" /><p v-else class="section-caption">Accepted instructions are not available in the retained evidence.</p>
        <h3>Acceptance criteria</h3><ul v-if="criteria.length" class="criteria"><li v-for="(criterion, index) in criteria" :key="index"><MessageContent :text="criterion" /></li></ul><p v-else class="section-caption">No acceptance criteria were recorded for this request.</p>
      </section>
      <section id="review-changes" class="review-section" tabindex="-1" aria-labelledby="review-changes-title">
        <h2 id="review-changes-title">{{ data.task ? 'Proposed changes' : 'Worker result' }}</h2>
        <p v-if="data.task?.patch" class="section-caption">Inspect this retained patch before applying or merging changes. Request checks and human code review are separate.</p>
        <p v-if="result && !currentResult" class="section-caption">{{ data.request?.delivery ? 'Retained model output. This reply is not a confirmed result for the current delivery run.' : 'Last completed reply from this conversation. It is not a confirmed result for the current request revision.' }}</p>
        <AssistantMessage v-if="result" :text="result" :file-task="data.task ? data.task.implementation ? 'implementation' : 'proposal' : undefined" />
        <PatchReview v-if="data.task?.patch" :patch="data.task.patch" :task-id="data.task.id" />
        <p v-else class="review-empty">{{ data.task ? 'No patch is retained for this request. Inspect the worker result and checks for what happened.' : result ? 'This request has no retained file changes.' : 'No completed worker result is available yet.' }}</p>
      </section>
      <section id="review-checks" class="review-section" aria-labelledby="review-checks-title">
        <h2 id="review-checks-title">Checks and evidence</h2>
        <details v-if="data.task && data.request?.delivery"><summary>Retained task candidate evidence</summary><p class="section-caption">These task checks are retained history. They do not establish verification or handoff for the current delivery run; inspect its candidate review package for current evidence.</p><CandidateEvidence :task="data.task" /></details>
        <CandidateEvidence v-else-if="data.task" :task="data.task" />
        <p v-else class="section-caption">This request has no repository candidate checks.</p>
        <DeliveryReviewEvidence v-if="review.evidence.deliveryReview" :review="review.evidence.deliveryReview" />
        <details v-else-if="data.request?.delivery?.review"><summary>Retained delivery review package</summary><p class="section-caption">This package does not establish a reviewable candidate for the current delivery run and accepted input. Its results and prior human observations remain historical evidence.</p><DeliveryReviewEvidence :review="data.request.delivery.review" /></details>
        <RequestGateEvidence stage="ready" :evaluation="review.evidence.ready ?? undefined" />
        <details v-if="data.request?.delivery && review.evidence.done"><summary>Retained completion gate evaluation</summary><p class="section-caption">This evaluation records an invocation’s input and output. The current delivery candidate and its criterion matrix determine current verification and review readiness.</p><RequestGateEvidence stage="done" :evaluation="review.evidence.done" /></details>
        <RequestGateEvidence v-else-if="!data.request?.delivery" stage="done" :evaluation="review.evidence.done ?? undefined" />
        <RouterLink class="text-link" :to="'/history?view=runs&runSession=' + encodeURIComponent(data.session.id)">Inspect execution attempts<UIcon name="i-lucide-arrow-up-right" /></RouterLink>
      </section>
      <section id="review-decision" class="review-section" aria-labelledby="review-decision-title">
        <h2 id="review-decision-title">Review decision</h2>
        <p v-if="review.ownership.readOnly" class="section-caption">{{ review.ownership.label }}. Inspect the evidence here; use the owning workflow to continue.</p>
        <RequestGatePanel v-if="data.request" :key="data.request.id" :request-id="data.request.id" :session-id="data.session.id" :feature-source="review.identity.source" :summary="false" :disabled="stale || review.ownership.readOnly" @change="requestChanged" />
        <p v-else class="section-caption">No retained request checks are available for this conversation. Inspect its result and execution history before taking action.</p>
      </section>
      <section v-if="data.shared" id="review-handoff" class="review-section" aria-labelledby="review-handoff-title">
        <h2 id="review-handoff-title">Team handoff</h2><p>Publication: <strong>{{ data.shared.publication === 'synced' ? 'Published to shared Git' : data.shared.publication === 'pending' ? 'Waiting to publish' : 'Publication needs attention' }}</strong></p>
        <p v-if="data.shared.error" class="error-text">{{ data.shared.error }}</p>
        <dl class="review-identities"><div v-if="data.shared.featureBranch"><dt>Feature branch</dt><dd>{{ data.shared.featureBranch }}</dd></div><div v-if="data.shared.reviewNote"><dt>Review note in the project</dt><dd>{{ data.shared.reviewNote }}</dd></div><div v-if="data.shared.taskNote"><dt>Task note for team input</dt><dd>{{ data.shared.taskNote }}</dd></div></dl>
        <p class="section-caption">The team reviews the shared notes and feature branch before merging. Publication does not merge changes.</p>
      </section>
      <FeatureRequestNote :key="data.session.id" :session="data.session" />
      <RequestActivityPanel v-if="data.request?.delivery" :request-id="data.request.id" :revision="data.request.revision" />
      <details class="review-technical"><summary>Technical identity and retained context</summary><dl class="review-identities"><div v-for="(value, key) in review.identity" :key="key"><dt>{{ key }}</dt><dd>{{ value || 'Not recorded' }}</dd></div><div v-if="data.task?.worktree"><dt>Worktree</dt><dd>{{ data.task.worktree }}</dd></div><div v-if="data.task?.baseCommit"><dt>Base commit</dt><dd>{{ data.task.baseCommit }}</dd></div></dl></details>
    </template>
  </section>
</template>
<style scoped>
.feature-review { max-width: 1280px; margin-inline: auto; min-width: 0; }
.review-breadcrumb, .review-meta, .review-header-actions, .review-sections { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
.review-breadcrumb { font-size: .8125rem; color: var(--ui-text-muted); margin-bottom: var(--space-6); }
.review-breadcrumb a, .text-link { display: inline-flex; align-items: center; gap: var(--space-2); min-height: 44px; color: var(--ui-primary); }
.review-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-6); }
.review-heading > div:first-child { min-width: 0; flex: 1; }
.eyebrow { color: var(--ui-text-muted); font-size: .8125rem; font-weight: 600; margin: 0 0 var(--space-2); }
h1 { font-size: 2rem; line-height: 1.25; letter-spacing: -.025em; overflow-wrap: anywhere; margin: 0; }
h2 { font-size: 1.125rem; line-height: 1.4; font-weight: 650; margin: 0 0 var(--space-3); }
h3 { font-size: .9375rem; font-weight: 600; margin: var(--space-6) 0 var(--space-2); }
.review-next p:not(.eyebrow) { color: var(--ui-text-muted); line-height: 1.65; margin: var(--space-2) 0 0; }
.review-header-actions :deep(a), .review-header-actions :deep(button), .review-next :deep(a), .review-next :deep(button) { min-height: 44px; }
.review-meta { margin-block: var(--space-4) var(--space-6); font-size: .8125rem; color: var(--ui-text-muted); }
.review-meta > :last-child { margin-left: auto; }
.review-next { display: flex; align-items: center; justify-content: space-between; gap: var(--space-6); padding: var(--space-6); border: 1px solid var(--ui-primary); border-radius: 10px; background: var(--ui-bg-elevated); }
.review-next h2 { margin: 0; }.review-next > div { min-width: 0; }.review-next :deep(a), .review-next :deep(button) { flex-shrink: 0; }
.review-next.needs-refresh { border-color: var(--ui-warning); }
.review-stages { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: var(--space-4); padding: 0; margin: var(--space-6) 0; list-style: none; }
.review-stages li { display: flex; align-items: flex-start; gap: var(--space-3); border-top: 2px solid var(--ui-border); padding-top: var(--space-4); min-width: 0; }
.review-stages li.stage-complete { border-color: var(--ui-primary); }.review-stages li.stage-blocked { border-color: var(--ui-warning); }
.stage-number { flex-shrink: 0; display: grid; place-items: center; width: 28px; height: 28px; border: 1px solid var(--ui-border); border-radius: 50%; font-size: .8125rem; }
.stage-complete .stage-number { color: var(--ui-primary); }.stage-blocked .stage-number { color: var(--ui-warning); }
.review-stages strong { display: block; font-size: .9375rem; }.stage-state { display: block; font-size: .8125rem; color: var(--ui-text-muted); margin-top: var(--space-1); }
.review-stages p { color: var(--ui-text-muted); font-size: .8125rem; line-height: 1.6; margin: var(--space-2) 0 0; }
.review-sections { border-bottom: 1px solid var(--ui-border); gap: var(--space-2); padding-bottom: var(--space-3); }
.review-sections a { display: inline-flex; align-items: center; min-height: 44px; padding: var(--space-2) var(--space-3); color: var(--ui-primary); font-size: .875rem; border-radius: 6px; background: var(--ui-bg-elevated); }
.review-section { padding-block: var(--space-6); border-bottom: 1px solid var(--ui-border); scroll-margin-top: var(--space-6); min-width: 0; overflow-wrap: anywhere; }
.section-caption, .review-empty { color: var(--ui-text-muted); font-size: .875rem; line-height: 1.65; }.review-empty { margin-top: var(--space-4); }
.criteria { list-style: disc; padding-left: var(--space-6); }.criteria li { margin-block: var(--space-2); padding-left: var(--space-1); }
.review-notice { padding: var(--space-4); border: 1px solid var(--ui-border); border-radius: 8px; margin-block: var(--space-4); overflow-wrap: anywhere; line-height: 1.65; }
.review-technical { margin-top: var(--space-6); }.review-technical summary { min-height: 44px; padding-block: var(--space-3); cursor: pointer; font-size: .875rem; }
.review-identities { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: var(--space-4); margin-block: var(--space-4); }.review-identities dt { color: var(--ui-text-muted); font-size: .8125rem; }.review-identities dd { margin: var(--space-1) 0 0; overflow-wrap: anywhere; font-size: .875rem; }
.review-section :deep(.request-gate-panel) { margin-top: 0; }.review-section :deep(.candidate-evidence) { margin-top: var(--space-4); }
@media (max-width: 900px) { .review-heading { flex-direction: column; }.review-stages { grid-template-columns: repeat(2,minmax(0,1fr)); }.review-meta > :last-child { margin-left: 0; width: 100%; } }
@media (max-width: 560px) { .review-next { align-items: stretch; flex-direction: column; padding: var(--space-4); }.review-next :deep(a), .review-next :deep(button) { justify-content: center; }.review-stages { gap: var(--space-4) var(--space-3); }.review-stages li { gap: var(--space-2); }.stage-number { width: 24px; height: 24px; }.review-identities { grid-template-columns: 1fr; }.review-header-actions { width: 100%; }.review-header-actions :deep(a), .review-header-actions :deep(button) { flex-grow: 1; justify-content: center; } }
</style>
