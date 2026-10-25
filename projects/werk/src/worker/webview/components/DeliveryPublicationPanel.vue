<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import type { LocalMergeView, LocalMergeOperation } from '../../application/local-merge-contracts';
import { localMergeCommand, localMergeStatusLabels } from '../local-merge-view';
import { deliveryCandidateMatches } from '../delivery-candidate-view';
import type { WorkerRequest } from '../../application/request-gates';
import { remotePublicationBranch, type RemotePublication, type RemotePublicationCommand, type RemotePublicationView } from '../../application/remote-delivery-contracts';
import type { GateCommandFields } from '../request-gate-controller';
import { request, state, date } from '../store';
import { acceptedDeliveryPolicy } from '../delivery-policy-view';
import { deliveryReviewStages } from '../delivery-review-stages';
import MessageContent from './MessageContent.vue';
import { useWorkerSnapshot } from '../useWorkerSnapshot';
import { publicationCandidateMatches, publicationCommand, publicationLink, publicationStatusLabels } from '../delivery-publication-view';
const props = defineProps<{ subject: WorkerRequest; disabled: boolean; pending: (action: string) => boolean }>();
const emit = defineEmits<{ command: [GateCommandFields] }>();
const snapshot = useWorkerSnapshot(() => request<RemotePublicationView>('/api/requests', 'POST', { action: 'publication', requestId: props.subject.id }), [() => props.subject.id], [() => props.subject.revision]);
const { data, error, loading, refreshing, readAt, now, refresh } = snapshot;
const stale = computed(() => props.disabled || state.paused || !!error.value || !data.value || !readAt.value || now.value - Date.parse(readAt.value) > 15000);
const local = useWorkerSnapshot(() => request<LocalMergeView>('/api/requests', 'POST', { action: 'local_merge', requestId: props.subject.id }), [() => props.subject.id], [() => props.subject.revision]);
const confirmLocalMerge = ref(false);
watch([() => props.subject.id, () => local.data.value?.target?.checkoutPath, () => local.data.value?.target?.branch, () => local.data.value?.target?.head, () => props.subject.delivery?.review?.candidate.candidateCommit, () => state.draftEpoch], () => { confirmLocalMerge.value = false; });
const localFresh = computed(() => !props.disabled && !state.paused && !local.error.value && !!local.data.value && !!local.readAt.value && local.now.value - Date.parse(local.readAt.value) <= 15000 && deliveryCandidateMatches(props.subject, local.data.value));
function mergeLocal(receipt?: LocalMergeOperation) { if (!localFresh.value || !local.data.value || !receipt && !confirmLocalMerge.value) return; const fields = localMergeCommand(props.subject, local.data.value, receipt); if (fields) emit('command', fields); }
const markdownOpen = ref(false), markdownId = computed(() => 'markdown-pr-' + encodeURIComponent(props.subject.id));
watch(() => props.subject.id, () => { markdownOpen.value = false; });
const review = computed(() => props.subject.delivery ? deliveryReviewStages(props.subject).review : null);
const github = computed(() => !!acceptedDeliveryPolicy(props.subject.input.context)?.configuration.remoteDelivery || !!data.value?.configured || !!data.value?.publications.length);
const updatingPullRequest = computed(() => data.value?.publications.some(item => !!item.predecessor) || props.subject.deliveryHistory?.some(run => run.publications?.some(item => item.status === 'confirmed' && item.action === 'pull_request')) || false);
const matches = computed(() => !!data.value && publicationCandidateMatches(props.subject, data.value));
function command(action: RemotePublicationCommand, receipt?: RemotePublication) {
  if (stale.value || !data.value) return;
  const fields = publicationCommand(props.subject, data.value, action, receipt);
  if (fields) emit('command', fields);
}
</script>
<template>
  <section class="delivery-publication" aria-labelledby="delivery-publication-title">
    <header><h3 id="delivery-publication-title">{{ github ? 'GitHub delivery' : 'Markdown pull request' }}</h3><UButton v-if="github" type="button" color="neutral" variant="ghost" :loading="refreshing" :disabled="!state.unlocked" @click="refresh">Refresh publication</UButton></header>
    <template v-if="!github">
      <p>Plain Git uses a Markdown pull request for the verified candidate. GitHub integration is optional and has not been enabled for this request.</p>
      <template v-if="review"><p v-if="review.reviewNotePath">Created in the project at <code>{{ review.reviewNotePath }}</code>.</p><a :href="'#' + markdownId" @click="markdownOpen = true">Open Markdown pull request</a><details :id="markdownId" :open="markdownOpen" @toggle="markdownOpen = ($event.target as HTMLDetailsElement).open"><summary>Read Markdown pull request</summary><MessageContent :text="review.markdown" /></details></template>
      <p v-else>The worker prepares the Markdown pull request after verification. No current review file is confirmed yet.</p>
    </template>
      <section v-if="!acceptedDeliveryPolicy(subject.input.context)?.configuration.release && review || local.data.value?.state.operations.length" class="local-merge" aria-labelledby="local-merge-title"><header><h4 id="local-merge-title">Merge into main checkout</h4><UButton type="button" color="neutral" variant="ghost" :loading="local.refreshing.value" :disabled="!state.unlocked" @click="local.refresh">Refresh main checkout</UButton></header>
        <p v-if="local.error.value" role="alert" class="error-text">{{ local.error.value }} Refresh before approving a merge.</p><p v-else-if="local.loading.value && !local.data.value" role="status">Inspecting the assigned project’s main checkout…</p>
        <template v-if="local.data.value"><p v-if="local.data.value.reason" role="status">{{ local.data.value.reason }}</p><dl v-if="local.data.value.target"><div><dt>Main checkout</dt><dd>{{ local.data.value.target.checkoutPath }}</dd></div><div><dt>Target branch</dt><dd>{{ local.data.value.target.branch }}</dd></div><div><dt>Current main head</dt><dd><code>{{ local.data.value.target.head }}</code></dd></div><div v-if="local.data.value.candidate"><dt>Reviewed candidate</dt><dd><code>{{ local.data.value.candidate.candidateCommit }}</code></dd></div></dl>
          <div v-if="local.data.value.target && !local.data.value.state.merged"><label class="local-merge-consent"><input v-model="confirmLocalMerge" type="checkbox" :disabled="!localFresh || !local.data.value.canMerge" /> I approve merging this reviewed candidate into this project’s main checkout on {{ local.data.value.target.branch }}.</label><UButton type="button" :disabled="!localFresh || !local.data.value.canMerge || !confirmLocalMerge" :loading="pending('merge_local_candidate')" @click="mergeLocal()">Merge reviewed candidate into main checkout</UButton></div>
          <p v-if="local.data.value.state.merged" role="status">Main checkout merge confirmed on {{ local.data.value.state.merged.branch }} at <code>{{ local.data.value.state.merged.mergeCommit }}</code>.</p>
          <ol v-if="local.data.value.state.operations.length" class="publication-history" aria-label="Recorded main checkout merges"><li v-for="receipt in local.data.value.state.operations" :key="receipt.operationId"><strong>{{ localMergeStatusLabels[receipt.status] }}</strong><p>{{ receipt.detail }}</p><p class="caption">{{ date(receipt.updatedAt) }} · {{ receipt.checkoutPath }} · {{ receipt.mainBranch }} · <code>{{ receipt.mainHead }}</code></p><UButton v-if="['pending', 'unknown'].includes(receipt.status)" type="button" color="neutral" variant="outline" :disabled="!localFresh || !local.data.value.canReconcile" :loading="pending('reconcile_local_merge')" @click="mergeLocal(receipt)">Reconcile main checkout merge</UButton></li></ol>
        </template>
      </section>
    <p v-if="github">A local review note, a published branch, a remote pull request and human acceptance are separate outcomes. These actions do not merge or release changes.</p>
    <p v-if="error" class="error-text" role="alert">{{ error }} Refresh to inspect remote action availability.</p>
    <p v-else-if="loading && !data" role="status">Checking this candidate’s delivery policy…</p>
    <template v-if="data && github">
      <p v-if="!data.configured">Recorded GitHub delivery evidence is retained. GitHub actions are not enabled by the current policy.</p>
      <p v-if="data.reason" role="status">{{ data.reason }}</p>
      <template v-if="data.target">
        <dl><div><dt>Destination</dt><dd>{{ data.target.repository }} · {{ data.target.remote }}</dd></div><div><dt>PR base branch</dt><dd>{{ data.target.base }}</dd></div><div v-if="data.candidate"><dt>Local candidate branch</dt><dd>{{ data.candidate.branch }}</dd></div><div v-if="data.candidate"><dt>Candidate commit</dt><dd><code>{{ data.candidate.candidateCommit }}</code></dd></div></dl>
        <p v-if="!data.authorized"><RouterLink to="/settings#delivery-policy">Review and approve this project policy</RouterLink> before publishing.</p>
        <p v-else-if="!matches" class="caption">No current matching review candidate is available to publish. Retained publication receipts remain historical facts.</p>
        <div class="publication-actions">
          <UButton v-if="data.target.push" type="button" color="neutral" variant="outline" :disabled="stale || !matches || !data.canPush" :loading="pending('push_candidate')" @click="command('push_candidate')">Push candidate branch</UButton>
          <UButton v-if="data.target.pullRequest" type="button" color="neutral" variant="outline" :disabled="stale || !matches || !data.canCreatePullRequest" :loading="pending('create_pull_request')" @click="command('create_pull_request')">{{ updatingPullRequest ? 'Update pull request evidence' : data.target.draft ? 'Create draft pull request' : 'Create pull request' }}</UButton>
        </div>
      </template>
      <ol v-if="data.publications.length" class="publication-history" aria-label="Recorded remote delivery actions">
        <li v-for="receipt in data.publications" :key="receipt.operationId">
          <h4>{{ receipt.action === 'push' ? 'Candidate branch push' : receipt.predecessor ? 'Pull request evidence update' : 'Pull request creation' }} · {{ publicationStatusLabels[receipt.status] }}</h4>
          <p>{{ receipt.detail }}</p><p class="caption">{{ date(receipt.updatedAt) }} · {{ receipt.target.repository }} / {{ receipt.target.base }} · Request revision {{ receipt.candidate.inputRevision }}</p>
          <p class="caption">{{ remotePublicationBranch(receipt) }} · <code>{{ receipt.candidate.candidateCommit }}</code></p>
          <a v-if="publicationLink(receipt)" :href="publicationLink(receipt)!" target="_blank" rel="noopener noreferrer">Open confirmed pull request #{{ receipt.observation!.pullRequest!.number }} · {{ receipt.observation!.pullRequest!.state }}</a>
          <UButton v-if="['pending', 'unknown'].includes(receipt.status)" type="button" color="neutral" variant="outline" :disabled="stale || !data.canReconcile || !data.authorized" :loading="pending('reconcile_publication')" @click="command('reconcile_publication', receipt)">Reconcile this publication</UButton>
          <details><summary>Publication identity</summary><code>{{ receipt.operationId }}</code><p>Approved policy: <code>{{ receipt.configurationDigest }}</code></p></details>
        </li>
      </ol>
      <p v-if="stale && data.configured" class="caption">Actions require a fresh matching request and policy. Refresh publication to check the latest availability.</p>
    </template>
  </section>
</template>
<style scoped>
.local-merge { border-top:1px solid var(--ui-border);margin-top:var(--space-4);padding-top:var(--space-3); }.local-merge-consent { display:flex;align-items:flex-start;gap:var(--space-3);min-height:44px;font-size:.875rem;line-height:1.65;margin-block:var(--space-4); }.local-merge-consent input { flex:0 0 18px;width:18px;height:18px;accent-color:var(--ui-primary);margin-top:.25rem; }
.delivery-publication { margin-block: var(--space-6); padding-block: var(--space-4); border-top: 1px solid var(--ui-border); min-width: 0; }header,.publication-actions { display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap; }header { justify-content: space-between; }h3 { font-size: 1rem; margin: 0; }h4 { font-size: .875rem; margin-block: var(--space-3); }p { font-size: .875rem; line-height: 1.65; overflow-wrap: anywhere; }dl { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: var(--space-4); }dt,.caption { color: var(--ui-text-muted); font-size: .8125rem; }dd { margin: var(--space-1) 0 0; font-size: .875rem; overflow-wrap: anywhere; }.publication-history { list-style: none; padding: 0; }.publication-history li { padding-block: var(--space-4); border-top: 1px solid var(--ui-border); }a { color: var(--ui-primary); display: inline-flex; align-items: center; min-height: 44px; }summary { min-height: 44px; padding-block: var(--space-3); cursor: pointer; font-size: .8125rem; }code { overflow-wrap: anywhere; font-size: .8125rem; }:deep(button) { min-height: 44px; }@media(max-width:560px) { dl { grid-template-columns: 1fr; } }
</style>
