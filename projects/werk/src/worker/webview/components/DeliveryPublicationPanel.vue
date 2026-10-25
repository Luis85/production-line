<script setup lang="ts">
import { computed } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import type { WorkerRequest } from '../../application/request-gates';
import { remotePublicationBranch, type RemotePublication, type RemotePublicationCommand, type RemotePublicationView } from '../../application/remote-delivery-contracts';
import type { GateCommandFields } from '../request-gate-controller';
import { request, state, date } from '../store';
import { useWorkerSnapshot } from '../useWorkerSnapshot';
import { publicationCandidateMatches, publicationCommand, publicationLink, publicationStatusLabels } from '../delivery-publication-view';
const props = defineProps<{ subject: WorkerRequest; disabled: boolean; pending: (action: string) => boolean }>();
const emit = defineEmits<{ command: [GateCommandFields] }>();
const snapshot = useWorkerSnapshot(() => request<RemotePublicationView>('/api/requests', 'POST', { action: 'publication', requestId: props.subject.id }), [() => props.subject.id], [() => props.subject.revision]);
const { data, error, loading, refreshing, readAt, now, refresh } = snapshot;
const stale = computed(() => props.disabled || state.paused || !!error.value || !data.value || !readAt.value || now.value - Date.parse(readAt.value) > 15000);
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
    <header><h3 id="delivery-publication-title">Remote delivery</h3><UButton type="button" color="neutral" variant="ghost" :loading="refreshing" :disabled="!state.unlocked" @click="refresh">Refresh publication</UButton></header>
    <p>A local review note, a published branch, a remote pull request and human acceptance are separate outcomes. These actions do not merge or release changes.</p>
    <p v-if="error" class="error-text" role="alert">{{ error }} Refresh to inspect remote action availability.</p>
    <p v-else-if="loading && !data" role="status">Checking this candidate’s delivery policy…</p>
    <template v-if="data">
      <p v-if="!data.configured">This project uses local delivery. No remote publication is configured.</p>
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
.delivery-publication { margin-block: var(--space-6); padding-block: var(--space-4); border-top: 1px solid var(--ui-border); min-width: 0; }header,.publication-actions { display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap; }header { justify-content: space-between; }h3 { font-size: 1rem; margin: 0; }h4 { font-size: .875rem; margin-block: var(--space-3); }p { font-size: .875rem; line-height: 1.65; overflow-wrap: anywhere; }dl { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: var(--space-4); }dt,.caption { color: var(--ui-text-muted); font-size: .8125rem; }dd { margin: var(--space-1) 0 0; font-size: .875rem; overflow-wrap: anywhere; }.publication-history { list-style: none; padding: 0; }.publication-history li { padding-block: var(--space-4); border-top: 1px solid var(--ui-border); }a { color: var(--ui-primary); display: inline-flex; align-items: center; min-height: 44px; }summary { min-height: 44px; padding-block: var(--space-3); cursor: pointer; font-size: .8125rem; }code { overflow-wrap: anywhere; font-size: .8125rem; }:deep(button) { min-height: 44px; }@media(max-width:560px) { dl { grid-template-columns: 1fr; } }
</style>
