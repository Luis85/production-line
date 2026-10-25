<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ReleasePolicy } from '../../application/release-policy';
const props = defineProps<{ modelValue?: ReleasePolicy; repository?: string; base?: string }>();
const emit = defineEmits<{ 'update:modelValue': [ReleasePolicy | undefined] }>();
const defaults = (): ReleasePolicy => ({ repository: props.repository ?? '', base: props.base ?? 'main', mergeMethod: 'squash', tagPrefix: 'v', prerelease: false, build: { executable: 'node', args: ['scripts/build.mjs'], timeoutMs: 600000, artifacts: [] } });
const value = computed(() => props.modelValue ?? defaults());
const retained = ref<ReleasePolicy>();
watch([() => props.repository, () => props.base], () => { retained.value = undefined; });
function toggle(enabled: boolean) {
  if (!enabled && props.modelValue) retained.value = JSON.parse(JSON.stringify(props.modelValue)) as ReleasePolicy;
  emit('update:modelValue', enabled ? retained.value ?? defaults() : undefined);
}
function edit(key: 'repository' | 'base' | 'mergeMethod' | 'tagPrefix' | 'prerelease', input: string | boolean) { emit('update:modelValue', { ...value.value, [key]: input } as ReleasePolicy); }
function build(key: keyof ReleasePolicy['build'], input: string) {
  emit('update:modelValue', { ...value.value, build: { ...value.value.build, [key]: key === 'args' || key === 'artifacts' ? input.split('\n').filter(line => line.trim()) : key === 'timeoutMs' ? Number(input) * 1000 : input } });
}
</script>
<template>
  <details class="release-policy-fields"><summary>Merge, build and publish configuration</summary>
    <label class="check-label"><input type="checkbox" :checked="!!modelValue" @change="toggle(($event.target as HTMLInputElement).checked)" /> Enable the project release workflow</label>
    <p>Commit this configuration and approve its exact digest on the worker. Each request retains the approved version it was accepted with.</p>
    <template v-if="modelValue">
      <label for="release-policy-repository">GitHub release repository · owner/name</label><input id="release-policy-repository" :value="value.repository" maxlength="140" @input="edit('repository', ($event.target as HTMLInputElement).value)" />
      <label for="release-policy-base">Merge base branch</label><input id="release-policy-base" :value="value.base" maxlength="200" @input="edit('base', ($event.target as HTMLInputElement).value)" />
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
