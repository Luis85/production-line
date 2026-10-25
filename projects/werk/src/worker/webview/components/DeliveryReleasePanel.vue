<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import UTextarea from '@nuxt/ui/components/Textarea.vue';
import type { WorkerRequest } from '../../application/request-gates';
import type { ReleaseOperation, ReleaseView } from '../../application/release-contracts';
import type { GateCommandFields } from '../request-gate-controller';
import { date, request, state } from '../store';
import { acceptedDeliveryPolicy } from '../delivery-policy-view';
import { useWorkerSnapshot } from '../useWorkerSnapshot';
import { deliveryCandidateMatches } from '../delivery-candidate-view';
import { releaseCommand, releaseLink, releaseStatusLabels, releaseTagIssue, type ReleaseCommand } from '../delivery-release-view';
const props = defineProps<{ subject: WorkerRequest; disabled: boolean; pending: (action: string) => boolean }>();
const emit = defineEmits<{ command: [GateCommandFields] }>();
const { data, error, loading, refreshing, refresh, readAt, now } = useWorkerSnapshot(() => request<ReleaseView>('/api/requests', 'POST', { action: 'release', requestId: props.subject.id }), [() => props.subject.id], [() => props.subject.revision]);
const visible = computed(() => !!acceptedDeliveryPolicy(props.subject.input.context)?.configuration.release || !!props.subject.delivery?.release || !!data.value?.configured || !!data.value?.state.operations.length || !!data.value?.state.merge || !!data.value?.state.build || !!data.value?.state.published);
const tag = ref(''), stopNote = ref(''), confirmMerge = ref(false), confirmPublish = ref(false), confirmStopped = ref(false);
const stale = computed(() => props.disabled || state.paused || !!error.value || !data.value || !readAt.value || now.value - Date.parse(readAt.value) > 15000);
const matches = computed(() => !!data.value && deliveryCandidateMatches(props.subject, data.value));
const tagIssue = computed(() => releaseTagIssue(tag.value, data.value?.target?.tagPrefix ?? ''));
const publishedLink = computed(() => data.value ? releaseLink(data.value) : null);
watch([() => props.subject.id, () => props.subject.delivery?.review?.candidate.candidateCommit, () => state.draftEpoch], () => { tag.value = ''; stopNote.value = ''; confirmMerge.value = false; confirmPublish.value = false; confirmStopped.value = false; });
function command(action: ReleaseCommand, receipt?: ReleaseOperation) {
  if (stale.value || !data.value || action === 'merge_candidate' && !confirmMerge.value || action === 'publish_release' && !confirmPublish.value || action === 'confirm_release_stopped' && !confirmStopped.value) return;
  const fields = releaseCommand(props.subject, data.value, action, { receipt, tag: tag.value, note: stopNote.value });
  if (fields) emit('command', fields);
}
</script>
<template>
  <section v-if="visible" class="delivery-release" aria-labelledby="delivery-release-title">
    <header><h3 id="delivery-release-title">Merge, build and publish</h3><UButton type="button" color="neutral" variant="ghost" :loading="refreshing" :disabled="!state.unlocked" @click="refresh">Refresh release</UButton></header>
    <p>Follow the reviewed candidate into its merged commit, verified build and published GitHub Release. Each action retains its own result.</p>
    <p v-if="error" class="error-text" role="alert">{{ error }} Refresh before continuing.</p><p v-else-if="loading && !data" role="status">Checking this candidate’s release policy…</p>
    <template v-if="data">
      <p v-if="!data.configured">Retained release evidence is shown below. GitHub release actions are not enabled by the current policy.</p>
      <p v-if="data.reason" role="status">{{ data.reason }}</p>
      <template v-if="data.target">
        <dl><div><dt>Release repository</dt><dd>{{ data.target.repository }}</dd></div><div><dt>Merge destination</dt><dd>{{ data.target.base }} · {{ data.target.mergeMethod }}</dd></div><div v-if="data.state.merge"><dt>Confirmed merge commit</dt><dd><code>{{ data.state.merge.mergeCommit }}</code></dd></div><div v-if="data.state.build"><dt>Built commit</dt><dd><code>{{ data.state.build.commit }}</code></dd></div></dl>
        <p v-if="!data.authorized"><RouterLink to="/settings#delivery-policy">Approve the exact committed project policy</RouterLink> before release actions.</p>
        <p v-else-if="!matches" class="caption">Current candidate evidence is unavailable or changed. Refresh the request before acting.</p>
        <div v-if="!data.state.merge" class="release-action"><label class="check-label"><input v-model="confirmMerge" type="checkbox" :disabled="stale || !data.canMerge || !matches" /> I reviewed this exact candidate and want to merge its pull request.</label><UButton type="button" :disabled="stale || !matches || !data.canMerge || !confirmMerge" :loading="pending('merge_candidate')" @click="command('merge_candidate')">Merge reviewed candidate</UButton></div>
        <div v-else-if="!data.state.build" class="release-action"><p>Build the confirmed merged commit using this project’s approved build configuration.</p><UButton type="button" :disabled="stale || !matches || !data.canBuild" :loading="pending('build_release')" @click="command('build_release')">Build merged commit</UButton></div>
        <div v-else-if="!data.state.published" class="release-action"><label for="delivery-release-tag">Release tag</label><UInput id="delivery-release-tag" v-model="tag" :placeholder="(data.target.tagPrefix || '') + '1.0.0'" maxlength="100" :aria-invalid="!!tagIssue || undefined" :aria-describedby="tagIssue ? 'delivery-release-tag-help delivery-release-tag-error' : 'delivery-release-tag-help'" :disabled="stale || !data.canPublish || !matches" class="w-full" /><p id="delivery-release-tag-help" class="caption">Choose the project version. Publication uses the verified build’s retained assets and checksums.</p><p v-if="tagIssue" id="delivery-release-tag-error" class="error-text" role="status">{{ tagIssue }}</p><label class="check-label"><input v-model="confirmPublish" type="checkbox" :disabled="stale || !data.canPublish || !matches" /> Publish this build to {{ data.target.repository }}{{ data.target.prerelease ? ' as a prerelease' : '' }}.</label><UButton type="button" :disabled="stale || !matches || !data.canPublish || !tag.trim() || !!tagIssue || !confirmPublish" :loading="pending('publish_release')" @click="command('publish_release')">Publish verified release</UButton></div>
        <p v-if="data.state.published" role="status">Release {{ data.state.published.tag }} is recorded as published at {{ date(data.state.published.publishedAt) }}. <a v-if="publishedLink" :href="publishedLink" target="_blank" rel="noopener noreferrer">Open confirmed GitHub Release</a></p>
        <details v-if="data.state.build"><summary>Verified build assets · {{ data.state.build.artifacts.length }}</summary><ul class="assets"><li v-for="asset in data.state.build.artifacts" :key="asset.name"><strong>{{ asset.name }}</strong><span>{{ asset.bytes.toLocaleString() }} bytes</span><code>{{ asset.sha256 }}</code></li></ul><p class="caption">Manifest digest: <code>{{ data.state.build.manifestDigest }}</code></p></details>
      </template>
      <ol v-if="data.state.operations.length" class="release-history" aria-label="Recorded release operations"><li v-for="receipt in data.state.operations" :key="receipt.operationId"><h4>{{ receipt.action === 'merge' ? 'Merge' : receipt.action === 'build' ? 'Build' : 'Publish' }} · {{ releaseStatusLabels[receipt.status] }}</h4><p>{{ receipt.detail }}</p><p class="caption">{{ date(receipt.updatedAt) }} · {{ receipt.operationId }}</p>
        <UButton v-if="['pending', 'unknown'].includes(receipt.status)" type="button" color="neutral" variant="outline" :disabled="stale || !data.canReconcile || !data.authorized" :loading="pending('reconcile_release')" @click="command('reconcile_release', receipt)">Reconcile saved {{ receipt.action }}</UButton>
        <details v-if="receipt.action === 'build' && receipt.status === 'unknown' && data.canConfirmStopped"><summary>Confirm build processes stopped</summary><p>Inspect the worker machine and stop any remaining processes from this build before recording your confirmation. This marks the uncertain build attempt as stopped; a new build is a separate action.</p><label :for="'build-stop-note-' + receipt.operationId">Inspection note</label><UTextarea :id="'build-stop-note-' + receipt.operationId" v-model="stopNote" :rows="3" maxlength="8000" :disabled="stale" class="w-full" /><label class="check-label"><input v-model="confirmStopped" type="checkbox" :disabled="stale" /> I inspected the machine and stopped this build’s remaining processes.</label><UButton type="button" color="neutral" variant="outline" :disabled="stale || !confirmStopped || !stopNote.trim()" :loading="pending('confirm_release_stopped')" @click="command('confirm_release_stopped', receipt)">Record stopped-build confirmation</UButton></details>
      </li></ol>
      <p v-if="stale && data.configured" class="caption">Release actions require fresh request and policy evidence. Refresh to check availability.</p>
    </template>
  </section>
</template>
<style scoped>
.delivery-release { margin-block:var(--space-6);padding-block:var(--space-4);border-top:1px solid var(--ui-border);min-width:0; }header { display:flex;justify-content:space-between;gap:var(--space-3);align-items:center;flex-wrap:wrap; }h3 { font-size:1rem;margin:0; }h4 { font-size:.875rem;margin-block:var(--space-3); }p { font-size:.875rem;line-height:1.65;overflow-wrap:anywhere; }dl { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4); }dt,.caption { color:var(--ui-text-muted);font-size:.8125rem; }dd { margin:var(--space-1) 0 0;font-size:.875rem;overflow-wrap:anywhere; }.release-action { margin-block:var(--space-6); }.release-action > label:not(.check-label) { display:block;font-size:.875rem;margin-bottom:var(--space-2); }.check-label { display:flex;align-items:flex-start;gap:var(--space-3);font-size:.875rem;line-height:1.65;min-height:44px;margin-block:var(--space-3); }.check-label input { margin-top:.25rem;flex:0 0 18px;width:18px;height:18px;accent-color:var(--ui-primary); }a { color:var(--ui-primary);text-underline-offset:3px; }.assets,.release-history { list-style:none;padding:0; }.assets li { display:grid;gap:var(--space-2);padding-block:var(--space-3);font-size:.8125rem; }.release-history li { border-top:1px solid var(--ui-border);padding-block:var(--space-4); }summary { cursor:pointer;min-height:44px;padding-block:var(--space-3);font-size:.8125rem; }code { overflow-wrap:anywhere;font-size:.8125rem; }:deep(button),:deep(input) { min-height:44px; }@media(max-width:560px) { dl { grid-template-columns:1fr; } }
</style>
