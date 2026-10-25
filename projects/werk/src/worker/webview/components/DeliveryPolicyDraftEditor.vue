<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import DeliveryReleasePolicyFields from './DeliveryReleasePolicyFields.vue';
import type { RemoteDeliveryPolicy } from '../../application/remote-delivery-policy';
import type { ReleasePolicy } from '../../application/release-policy';
import type { DeliveryProjectPolicy } from '../../application/delivery-policy';
import type { DeliveryNode } from '../../application/delivery-contracts';
import type { DeliveryPolicyDraft } from '../delivery-project-view';
import { deliveryBehaviorNodes } from '../delivery-behavior-view';
import { request, state } from '../store';
const props = defineProps<{ projectId: string }>();
const emit = defineEmits<{ dirty: [boolean]; saved: [] }>();
const baseline = ref<DeliveryPolicyDraft | null>(null), content = ref(''), busy = ref(false), error = ref(''), notice = ref(''), selectedBehavior = ref('');
let revision = 0;
const fieldsEpoch = ref(0);
const dirty = computed(() => !!baseline.value && content.value !== baseline.value.content);
watch(dirty, value => emit('dirty', value));
const parsed = computed(() => { try { const value: unknown = JSON.parse(content.value); return value && typeof value === 'object' && !Array.isArray(value) ? value as DeliveryProjectPolicy : null; } catch { return null; } });
const qualityProfiles = computed(() => Array.isArray(parsed.value?.profiles) ? parsed.value.profiles.filter(item => item && typeof item === 'object' && typeof item.id === 'string') : []);
const behaviorProfiles = computed(() => Array.isArray(parsed.value?.behaviors?.profiles) ? parsed.value.behaviors.profiles.filter(item => item && typeof item === 'object' && typeof item.id === 'string' && item.root) : []);
const behavior = computed(() => behaviorProfiles.value.find(item => item.id === selectedBehavior.value) ?? behaviorProfiles.value[0]);
const nodes = computed(() => { try { return behavior.value ? deliveryBehaviorNodes(behavior.value) : []; } catch { return []; } });
watch([() => props.projectId, () => state.draftEpoch], () => { revision++; baseline.value = null; content.value = ''; error.value = ''; notice.value = ''; busy.value = false; });
async function load() {
  if (!state.unlocked || busy.value) return;
  const attempt = ++revision; busy.value = true; error.value = '';
  try { const value = await request<DeliveryPolicyDraft>('/api/requests', 'POST', { action: 'delivery_policy_draft', projectId: props.projectId }); if (attempt === revision && state.unlocked) { baseline.value = value; fieldsEpoch.value++; content.value = value.content || JSON.stringify(value.configuration, null, 2); notice.value = ''; } }
  catch (cause) { if (attempt === revision) error.value = (cause as Error).message; }
  finally { if (attempt === revision) busy.value = false; }
}
function edit(key: 'version' | 'defaultProfile' | 'reviewDirectory', value: string) { if (!parsed.value) return; content.value = JSON.stringify({ ...parsed.value, [key]: key === 'version' ? Number(value) : value }, null, 2) + '\n'; }
function editLocalMerge(localMerge: boolean) { if (parsed.value) content.value = JSON.stringify({ ...parsed.value, localMerge }, null, 2) + '\n'; }
function editGitHub(value: { remoteDelivery?: RemoteDeliveryPolicy; release?: ReleasePolicy }) { if (!parsed.value) return; const configuration = { ...parsed.value }; delete configuration.remoteDelivery; delete configuration.release; if (value.remoteDelivery) configuration.remoteDelivery = value.remoteDelivery; if (value.release) configuration.release = value.release; content.value = JSON.stringify(configuration, null, 2) + '\n'; }
function editNode(id: string, field: 'reason' | 'waitingFor', value: string) {
  if (!parsed.value || !behavior.value) return;
  const config = JSON.parse(content.value) as DeliveryProjectPolicy, profile = config.behaviors?.profiles.find(item => item.id === behavior.value!.id);
  let visited = 0; const walk = (node: DeliveryNode, depth = 0): void => { if (!node || typeof node !== 'object' || ++visited > 128 || depth > 8) return; if (node.id === id && node.type === 'action') { if (field === 'reason') node.reason = value; else node.waitingFor = value || undefined; } if ('children' in node && Array.isArray(node.children)) node.children.forEach(child => walk(child, depth + 1)); };
  if (profile) walk(profile.root); content.value = JSON.stringify(config, null, 2) + '\n';
}
function actionText(id: string, field: 'reason' | 'waitingFor') { let visited = 0; const walk = (node: DeliveryNode, depth = 0): string => { if (!node || typeof node !== 'object' || ++visited > 128 || depth > 8) return ''; return node.id === id && node.type === 'action' ? node[field] ?? '' : 'children' in node && Array.isArray(node.children) ? node.children.map(child => walk(child, depth + 1)).find(Boolean) ?? '' : ''; }; return behavior.value ? walk(behavior.value.root) : ''; }
async function save() {
  if (!baseline.value || !dirty.value || busy.value || !parsed.value || !state.unlocked) return;
  const attempt = ++revision; busy.value = true; error.value = '';
  try { const value = await request<DeliveryPolicyDraft>('/api/requests', 'POST', { action: 'save_delivery_policy_draft', projectId: props.projectId, expectedFileDigest: baseline.value.fileDigest, configuration: parsed.value }); if (attempt === revision && state.unlocked) { baseline.value = value; content.value = value.content; notice.value = 'Draft saved in the project. Review and commit the change, then refresh the committed policy and approve its exact version on this worker.'; emit('saved'); } }
  catch (cause) { if (attempt === revision) error.value = (cause as Error).message + ' Your draft is retained. Reload only after saving a copy if another editor changed the file.'; }
  finally { if (attempt === revision) busy.value = false; }
}
</script>
<template><details class="delivery-detail"><summary>Edit project policy draft</summary><p>Save bounded, validated configuration to the project. Saving does not stage, commit or approve it, and does not change an active request’s accepted policy.</p><UButton type="button" variant="outline" :disabled="busy || dirty || !state.unlocked" :loading="busy && !baseline" @click="load">{{ baseline ? 'Reload saved draft' : 'Load project draft' }}</UButton><UButton v-if="dirty" type="button" variant="ghost" color="neutral" :disabled="busy" @click="content = baseline!.content; fieldsEpoch++">Discard unsaved edits</UButton><p v-if="error" role="alert" class="error-text">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p><template v-if="baseline"><p class="caption">{{ baseline.path }} · {{ baseline.isCommitted ? 'Matches committed configuration' : 'Uncommitted or new configuration' }}</p><p v-if="baseline.committedValidationError" class="error-text">Committed policy needs repair: {{ baseline.committedValidationError }}</p><p v-if="baseline.validationError" class="error-text">Saved draft needs repair: {{ baseline.validationError }}</p><fieldset :disabled="busy" style="border:0;padding:0;min-width:0"><template v-if="parsed"><label for="policy-edit-version">Policy version</label><input id="policy-edit-version" type="number" min="1" :value="parsed.version" @input="edit('version', ($event.target as HTMLInputElement).value)" /><label for="policy-edit-default">Default quality profile</label><select id="policy-edit-default" :value="parsed.defaultProfile" @change="edit('defaultProfile', ($event.target as HTMLSelectElement).value)"><option v-for="profile in qualityProfiles" :key="profile.id" :value="profile.id">{{ profile.id }}</option></select><label for="policy-edit-directory">Review note directory</label><input id="policy-edit-directory" :value="parsed.reviewDirectory" @input="edit('reviewDirectory', ($event.target as HTMLInputElement).value)" />
<label class="check-label"><input type="checkbox" :checked="parsed.localMerge === true" @change="editLocalMerge(($event.target as HTMLInputElement).checked)" /> Require explicit main checkout merge before completing requests</label><p class="caption">Human candidate acceptance and approval to change the assigned main checkout are separate decisions. A configured GitHub release workflow uses its own merge and publication receipts.</p>
<DeliveryReleasePolicyFields :key="fieldsEpoch" :model-value="parsed.release" :remote-delivery="parsed.remoteDelivery" @change="editGitHub" />
<details v-if="behaviorProfiles.length"><summary>Behavior library · visual profile editor</summary><p>Profile structure and condition/action mappings must retain the worker’s safety precedence. Edit action explanations here; the validator rejects unsupported executable behavior.</p><label for="policy-behavior-choice">Behavior profile</label><select id="policy-behavior-choice" :value="behavior?.id" @change="selectedBehavior = ($event.target as HTMLSelectElement).value"><option v-for="profile in behaviorProfiles" :key="profile.id" :value="profile.id">{{ profile.id }} · v{{ profile.version }}</option></select><ol class="behavior-editor"><li v-for="node in nodes" :key="node.id" :style="{paddingLeft: Math.min(node.depth,4) * 12 + 'px'}"><strong>{{ node.label }}</strong> · <code>{{ node.id }}</code><template v-if="node.type === 'action'"><label :for="'behavior-reason-' + node.id">Action explanation</label><input :id="'behavior-reason-' + node.id" :value="actionText(node.id, 'reason')" @input="editNode(node.id, 'reason', ($event.target as HTMLInputElement).value)" /><label :for="'behavior-wait-' + node.id">Expected next event · optional</label><input :id="'behavior-wait-' + node.id" :value="actionText(node.id, 'waitingFor')" @input="editNode(node.id, 'waitingFor', ($event.target as HTMLInputElement).value)" /></template></li></ol></details></template>
<label for="policy-draft-json">Complete declarative configuration</label><p class="caption">Configure named execution/review profiles, routing rules, limits, check inputs and policy-permitted decisions here. No credentials or executable scripts belong in this file.</p><textarea id="policy-draft-json" v-model="content" rows="18" maxlength="262144" spellcheck="false" /><p v-if="!parsed" class="error-text">Enter a JSON configuration object before saving. Your text remains editable.</p><UButton type="button" :loading="busy && !!baseline" :disabled="!dirty || !parsed || !state.unlocked" @click="save">Validate and save draft</UButton></fieldset></template></details></template>
<style scoped src="./delivery-detail.css"></style>

<style scoped>
.check-label { display:flex;align-items:flex-start;gap:var(--space-3);min-height:44px;line-height:1.65; }.check-label input { flex:0 0 18px;width:18px;height:18px;min-height:18px;margin-top:.25rem;accent-color:var(--ui-primary); }
</style>
