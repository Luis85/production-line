<script setup lang="ts">
import { computed, onActivated, onDeactivated, onMounted, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import { state, request } from '../store';
type FilePlan = { path: string; state: 'missing' | 'current' | 'update' | 'conflict' | 'blocked'; action: string; content: string; reason?: string };
type Plan = { schemaVersion: 1; enabled: boolean; reason?: string; projectDirectory?: string; planId?: string; canApply?: boolean; files?: FilePlan[]; applied?: boolean; seedOnly?: boolean; written?: string[]; skipped?: string[] };
const report = ref<Plan | null>(null), reviewed = ref<Plan | null>(null), loading = ref(false), applying = ref(false), readError = ref(''), error = ref(''), notice = ref('');
let active = true, generation = 0;
const readiness = computed(() => report.value?.files?.every(file => file.state === 'current') ? 'Project instructions are current' : 'Project instructions need review');
async function load() {
  if (!active || !state.unlocked || loading.value || applying.value) return;
  const current = ++generation; loading.value = true;
  try { const result = await request('/api/integrations'); if (current === generation && state.unlocked) { report.value = result; readError.value = ''; } }
  catch (failure) { if (current === generation && state.unlocked) readError.value = (failure as Error).message; }
  finally { if (current === generation) loading.value = false; }
}
async function preview() {
  if (applying.value || loading.value) return;
  const current = ++generation; loading.value = true; error.value = ''; notice.value = '';
  try { const result = await request('/api/integrations', 'POST', { action: 'plan' }); if (current === generation && state.unlocked) { report.value = result; reviewed.value = result; } }
  catch (failure) { if (current === generation && state.unlocked) error.value = (failure as Error).message; }
  finally { if (current === generation) loading.value = false; }
}
async function apply() {
  if (!reviewed.value?.canApply || !reviewed.value.planId || applying.value) return;
  const expectedPlan = reviewed.value.planId, current = ++generation; applying.value = true; error.value = ''; notice.value = '';
  try { const result: Plan = await request('/api/integrations', 'POST', { action: 'apply', expectedPlan }); if (current === generation && state.unlocked) { report.value = result; reviewed.value = null; notice.value = 'Project instructions synchronized. Existing unmanaged files were not replaced.'; } }
  catch (failure) { if (current === generation && state.unlocked) error.value = (failure as Error).message + ' Preview a fresh plan before trying again.'; }
  finally { if (current === generation) applying.value = false; }
}
onMounted(() => { void load(); }); onActivated(() => { active = true; void load(); });
onDeactivated(() => { active = false; generation++; loading.value = false; applying.value = false; });
watch(() => state.refreshRevision, () => { void load(); });
watch(() => state.unlocked, unlocked => { if (unlocked) void load(); else { generation++; report.value = null; reviewed.value = null; loading.value = false; applying.value = false; error.value = ''; readError.value = ''; notice.value = ''; } });
</script>
<template>
<section id="project-integrations" class="monitor-section" aria-labelledby="integrations-title">
 <div class="section-heading"><div><h2 id="integrations-title">Project integrations</h2><p class="page-note">Project instructions for Claude Code and Codex. Account sign-in is managed in Connections.</p></div><UButton v-if="report?.enabled" color="neutral" variant="outline" :loading="loading" :disabled="applying" @click="preview">Preview synchronization</UButton></div>
 <p v-if="readError" role="alert" class="error-text">{{ readError }} Last loaded information may be stale.</p><p v-if="error" role="alert" class="error-text">{{ error }} Previously loaded information may be stale.</p><p v-if="notice" role="status">{{ notice }}</p><p v-if="!report" class="page-note">{{ loading ? 'Reading project integration status…' : 'Integration status is unavailable.' }}</p>
 <template v-else-if="report.enabled"><p><strong>{{ readiness }}</strong></p><p class="break-anywhere">{{ report.projectDirectory }}</p><p class="page-note">Invoke <code>/werk-worker</code> in Claude Code or <code>$werk-worker</code> in Codex. These instructions use this project’s worker CLI; they do not sign in or start model work.</p><ul class="integration-files"><li v-for="file in report.files" :key="file.path"><code class="break-anywhere">{{ file.path }}</code><span>{{ file.state }}</span><p v-if="file.reason" class="page-note">{{ file.reason }}</p></li></ul>
 <details v-if="reviewed" class="integration-preview" open><summary>Reviewed synchronization plan</summary><p class="page-note">Generated instruction files only. Review each proposed change; custom files and provider settings remain protected.</p><details v-for="file in reviewed.files" :key="file.path"><summary class="break-anywhere">{{ file.action }} · {{ file.path }}</summary><pre>{{ file.content }}</pre></details><p v-if="!reviewed.canApply" class="page-note">This plan has protected conflicts or no changes to apply. Resolve conflicts in the project, then preview again.</p><UButton :disabled="!reviewed.canApply || loading" :loading="applying" @click="apply">Apply reviewed plan</UButton></details>
 </template><p v-else class="page-note">{{ report.reason || 'Initialize this worker in a project to install project instructions.' }}</p>
</section>
</template>
