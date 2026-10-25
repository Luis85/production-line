<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ReleasePolicy } from '../../application/release-policy';
import type { RemoteDeliveryPolicy } from '../../application/remote-delivery-policy';
const props = defineProps<{ modelValue?: ReleasePolicy; remoteDelivery?: RemoteDeliveryPolicy }>();
const emit = defineEmits<{ change: [{ remoteDelivery?: RemoteDeliveryPolicy; release?: ReleasePolicy }] }>();
const enabled = computed(() => !!props.remoteDelivery || !!props.modelValue);
const defaultsRemote = (): RemoteDeliveryPolicy => ({ remote: 'origin', repository: props.modelValue?.repository ?? '', base: props.modelValue?.base ?? 'main', push: true, pullRequest: true, draft: true, automatic: false });
const remote = computed(() => props.remoteDelivery ?? defaultsRemote());
const defaults = (): ReleasePolicy => ({ repository: remote.value.repository, base: remote.value.base, mergeMethod: 'squash', tagPrefix: 'v', prerelease: false, build: { executable: 'node', args: ['scripts/build.mjs'], timeoutMs: 600000, artifacts: [] } });
const value = computed(() => props.modelValue ?? defaults());
const retained = ref<ReleasePolicy>(), retainedRemote = ref<RemoteDeliveryPolicy>(), restoreRelease = ref(false);
const copy = <T,>(input: T): T => JSON.parse(JSON.stringify(input)) as T;
function integration(on: boolean) {
  if (!on) {
    retainedRemote.value = copy(remote.value); restoreRelease.value = !!props.modelValue;
    if (props.modelValue) retained.value = copy(props.modelValue);
    emit('change', {});
  } else emit('change', { remoteDelivery: retainedRemote.value ?? defaultsRemote(), release: restoreRelease.value ? retained.value : undefined });
}
function toggle(on: boolean) {
  if (!on && props.modelValue) retained.value = copy(props.modelValue);
  emit('change', { remoteDelivery: remote.value, release: on ? { ...(retained.value ?? defaults()), repository: remote.value.repository, base: remote.value.base } : undefined });
}
function editRemote(key: keyof RemoteDeliveryPolicy, input: string | boolean) {
  const target = { ...remote.value, [key]: input };
  if (key === 'push' && !input) { target.pullRequest = false; target.automatic = false; }
  if (key === 'pullRequest' && !input) target.automatic = false;
  if (props.modelValue && (!target.push || !target.pullRequest)) retained.value = copy(props.modelValue);
  emit('change', { remoteDelivery: target, release: props.modelValue && target.push && target.pullRequest ? { ...props.modelValue, repository: target.repository, base: target.base } : undefined });
}
function edit(key: 'mergeMethod' | 'tagPrefix' | 'prerelease', input: string | boolean) { emit('change', { remoteDelivery: remote.value, release: { ...value.value, [key]: input } as ReleasePolicy }); }
function build(key: keyof ReleasePolicy['build'], input: string) {
  emit('change', { remoteDelivery: remote.value, release: { ...value.value, build: { ...value.value.build, [key]: key === 'args' || key === 'artifacts' ? input.split('\n').filter(line => line.trim()) : key === 'timeoutMs' ? Number(input) * 1000 : input } } });
}
</script>
<template>
  <details class="release-policy-fields"><summary>GitHub integration · optional</summary>
    <p>Plain Git creates a Markdown pull request in the project’s review directory. A Git repository URL does not enable GitHub actions.</p>
    <label class="check-label"><input type="checkbox" :checked="enabled" @change="integration(($event.target as HTMLInputElement).checked)" /> Enable GitHub integration</label>
    <p>Commit this configuration and approve its exact digest on the worker before GitHub actions become available. Each request retains its accepted policy.</p>
    <template v-if="enabled">
      <label for="github-policy-repository">GitHub repository · owner/name</label><input id="github-policy-repository" :value="remote.repository" maxlength="140" placeholder="your-organization/your-project" @input="editRemote('repository', ($event.target as HTMLInputElement).value)" />
      <label for="github-policy-remote">Owned Git remote</label><input id="github-policy-remote" :value="remote.remote" maxlength="80" @input="editRemote('remote', ($event.target as HTMLInputElement).value)" />
      <label for="github-policy-base">Pull request base branch</label><input id="github-policy-base" :value="remote.base" maxlength="200" @input="editRemote('base', ($event.target as HTMLInputElement).value)" />
      <label class="check-label"><input type="checkbox" :checked="remote.push" @change="editRemote('push', ($event.target as HTMLInputElement).checked)" /> Permit candidate branch pushes</label>
      <label class="check-label"><input type="checkbox" :checked="remote.pullRequest" :disabled="!remote.push" @change="editRemote('pullRequest', ($event.target as HTMLInputElement).checked)" /> Permit GitHub pull request creation</label>
      <label v-if="remote.pullRequest" class="check-label"><input type="checkbox" :checked="remote.draft" @change="editRemote('draft', ($event.target as HTMLInputElement).checked)" /> Create pull requests as drafts</label>
      <label v-if="remote.pullRequest" class="check-label"><input type="checkbox" :checked="remote.automatic" @change="editRemote('automatic', ($event.target as HTMLInputElement).checked)" /> Automatically push and create the pull request after verification</label>
      <label class="check-label"><input type="checkbox" :checked="!!modelValue" :disabled="!remote.pullRequest" @change="toggle(($event.target as HTMLInputElement).checked)" /> Enable build and publish to GitHub Releases</label>
      <p v-if="!remote.pullRequest" class="caption">GitHub Releases requires branch push and pull request creation. Keep both permitted before enabling releases.</p>
    </template>
    <template v-if="enabled && modelValue">
      <label for="release-policy-method">Merge method</label><select id="release-policy-method" :value="value.mergeMethod" @change="edit('mergeMethod', ($event.target as HTMLSelectElement).value)"><option value="squash">Squash</option><option value="merge">Merge commit</option><option value="rebase">Rebase</option></select>
      <label for="release-policy-executable">Build executable</label><input id="release-policy-executable" :value="value.build.executable" maxlength="4096" @input="build('executable', ($event.target as HTMLInputElement).value)" />
      <label for="release-policy-args">Build arguments · one per line</label><textarea id="release-policy-args" aria-describedby="release-policy-args-help" :value="value.build.args.join('\n')" rows="4" spellcheck="false" @change="build('args', ($event.target as HTMLTextAreaElement).value)" /><p id="release-policy-args-help" class="caption">Arguments are passed directly to the executable. Choose a command available on the worker machine, including Windows.</p>
      <label for="release-policy-timeout">Build timeout · seconds</label><input id="release-policy-timeout" type="number" min="1" max="3600" :value="value.build.timeoutMs / 1000" @input="build('timeoutMs', ($event.target as HTMLInputElement).value)" />
      <label for="release-policy-assets">Build artifacts · exact relative paths, one per line</label><textarea id="release-policy-assets" aria-describedby="release-policy-assets-help" :value="value.build.artifacts.join('\n')" rows="4" spellcheck="false" placeholder="release/application.zip" @change="build('artifacts', ($event.target as HTMLTextAreaElement).value)" /><p id="release-policy-assets-help" class="caption">Configure 1–32 exact files with unique names. The worker retains their sizes and SHA-256 checksums before publication.</p>
      <label for="release-policy-prefix">Release tag prefix</label><input id="release-policy-prefix" :value="value.tagPrefix" maxlength="32" @input="edit('tagPrefix', ($event.target as HTMLInputElement).value)" />
      <label class="check-label"><input type="checkbox" :checked="value.prerelease" @change="edit('prerelease', ($event.target as HTMLInputElement).checked)" /> Publish as a prerelease</label>
    </template>
  </details>
</template>
<style scoped src="./delivery-detail.css"></style>
<style scoped>
input:not([type=checkbox]),select { width:100%; }input[type=checkbox] { min-height:18px;width:18px;flex:0 0 18px;margin-top:.3rem;accent-color:var(--ui-primary); }.check-label { display:flex;align-items:flex-start;gap:var(--space-3);line-height:1.6;min-height:44px; }.release-policy-fields { margin-block:var(--space-4); }textarea { max-width:100%;resize:vertical; }
</style>
