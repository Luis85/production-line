<script lang="ts">
import { createToolAccessEditor } from '../tool-access-editor';
import { state as workerState, toolAccessAction, toolAccessDiscover, refresh } from '../store';
const editor = createToolAccessEditor({ view: () => workerState.toolAccess, unlocked: () => workerState.unlocked, epoch: () => workerState.draftEpoch, write: toolAccessAction, discover: toolAccessDiscover, refresh, repositories: () => workerState.settings?.repositories.items.map(item => item.id) ?? [], commandTimeoutMs: () => workerState.settings?.execution.commandTimeoutMs, executionBudgetMs: () => workerState.settings?.execution.maxRuntimeMs });
</script>
<script setup lang="ts">
import { computed, ref } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import UTextarea from '@nuxt/ui/components/Textarea.vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import USelect from '@nuxt/ui/components/Select.vue';
import McpConnectionsEditor from './McpConnectionsEditor.vue';
import CliToolsEditor from './CliToolsEditor.vue';
import { state, workspaceAction } from '../store';
import { toolLimitSeconds } from '../tool-access-editor';
const { draft, dirty, stale, locked, validation, canSave } = editor;
const view = computed(() => state.toolAccess), pausing = ref(false);
const effective = computed(() => {
  const value = view.value;
  if (!value) return 'Loading saved access';
  const count = (value.builtins.files ? 1 : 0) + value.builtins.commands.filter(item => item.enabled).length + (value.builtins.cliTools ?? []).filter(item => item.enabled).length + (value.builtins.webOrigins.length ? 1 : 0) + value.mcp.filter(item => item.enabled).reduce((total, item) => total + item.allowedTools.length, 0);
  return count ? 'Tool access configured' : 'All tools off';
});
async function pause() {
  if (pausing.value || !state.unlocked) return;
  const epoch = state.draftEpoch; pausing.value = true; draft.error = '';
  try { if (!await workspaceAction('/api/settings', { board: { paused: true } }) && state.unlocked && epoch === state.draftEpoch) draft.error = state.actionError || 'New starts could not be paused.'; }
  finally { pausing.value = false; }
}
</script>
<template>
  <section class="tool-access" aria-labelledby="tool-access-title">
    <div class="section-heading"><h2 id="tool-access-title">Tool access</h2><UBadge color="neutral" variant="subtle">{{ effective }}</UBadge></div>
    <p class="page-note">Choose the tools this worker may offer models. Grants are shared across provider connections. Saved changes apply to future model turns. Results from granted tools are sent to the task’s selected model provider.</p>
    <template v-if="view">
      <p class="access-scope">File and CLI tools require an approved task worktree. Command presets, CLI tools and MCP servers run with their own permissions; imported agent definitions never grant access.</p>
      <form :aria-busy="draft.busy" @submit.prevent="editor.save">
        <fieldset class="tool-fields" :disabled="locked">
          <legend class="sr-only">Edit model tool access</legend>
          <section class="builtins-section" aria-labelledby="builtin-tools-title">
            <h3 id="builtin-tools-title">Built-in tools</h3>
            <label class="check-label file-grant"><input v-model="draft.files" type="checkbox"><span><strong>Access files in the task worktree</strong><span>List, read and search files. New requests may edit only paths explicitly approved in the request, and only when a required feature check is enabled.</span></span></label>
            <label for="tool-web-origins">Allowed web origins · one per line</label>
            <UTextarea id="tool-web-origins" v-model="draft.webOrigins" :rows="3" placeholder="https://docs.example.com" class="w-full" aria-describedby="tool-web-help" />
            <p id="tool-web-help" class="page-note">An empty list disables web access. Granted origins allow bounded reads; redirects do not expand the allowed destinations.</p>
          </section>
          <p class="page-note">Set the overall attempt duration, total tool calls and command limit in <RouterLink to="/settings#queue">Queue &amp; duration</RouterLink>. Set individual tool timeouts below. Command and CLI deadlines stay within the worker command limit; remaining attempt time applies to every call.</p>
          <section class="commands-section" aria-labelledby="command-presets-title">
            <div class="section-heading"><h3 id="command-presets-title">Command presets</h3><UButton type="button" color="neutral" variant="outline" icon="i-lucide-plus" :disabled="draft.commands.length >= 16" @click="editor.addCommand">Add command</UButton></div>
            <p class="page-note">Grant exact executable paths and fixed arguments. The model chooses a preset; it cannot supply a new command or extra arguments. Use a CLI tool below when the model needs to pass arguments.</p>
            <p class="authority-note">Enabled commands run as the worker’s account. They can change files or use the network according to that account’s permissions.</p>
            <p v-if="!draft.commands.length" class="page-note">No fixed command presets configured.</p>
            <div v-for="(command, index) in draft.commands" :key="index" class="command-preset">
              <div class="section-heading"><strong>{{ command.name || 'New command preset' }}</strong><UButton type="button" color="neutral" variant="ghost" icon="i-lucide-trash-2" :aria-label="`Remove command ${command.name || index + 1}`" @click="draft.commands.splice(index, 1)">Remove</UButton></div>
              <div class="command-fields"><div><label :for="`tool-command-name-${index}`">Command name</label><UInput :id="`tool-command-name-${index}`" v-model="command.name" required maxlength="100" class="w-full" /></div><div><label :for="`tool-command-id-${index}`">Command ID</label><UInput :id="`tool-command-id-${index}`" v-model="command.id" required maxlength="64" class="w-full" /></div></div>
              <label :for="`tool-command-path-${index}`">Executable · absolute path</label><UInput :id="`tool-command-path-${index}`" v-model="command.executable" required placeholder="/absolute/path/to/executable" class="w-full" />
              <label :for="`tool-command-args-${index}`">Fixed arguments · JSON array</label><UTextarea :id="`tool-command-args-${index}`" v-model="command.arguments" :rows="2" placeholder='["--version"]' class="w-full" />
              <label :for="`tool-command-timeout-${index}`">Timeout override · seconds, optional</label><UInput :id="`tool-command-timeout-${index}`" v-model.number="command.timeoutSeconds" type="number" min="1" :max="toolLimitSeconds.commandMax" step="0.001" placeholder="Inherit worker limit" class="w-full timeout-input" :aria-describedby="`tool-command-timeout-help-${index}`" />
              <p :id="`tool-command-timeout-help-${index}`" class="page-note">{{ editor.timeoutNote(command.timeoutSeconds, 'command') }}</p>
              <label :for="`tool-command-chat-${index}`">Working directory in chat</label><USelect :id="`tool-command-chat-${index}`" v-model="command.chatDirectory" :items="editor.chatDirectories(command.chatDirectory)" class="w-full" :aria-describedby="`tool-command-chat-help-${index}`" />
              <p :id="`tool-command-chat-help-${index}`" :class="command.chatDirectory === 'workspace' ? 'page-note' : 'authority-note'">{{ command.chatDirectory === 'workspace' ? 'Chat has no task worktree, so this command starts in an empty private folder without project files. Tasks always use their task worktree.' : 'Chat runs this command in the live repository checkout, not an isolated worktree. A writing command can change your working tree. Tasks still use their task worktree.' }}</p>
              <label class="check-label"><input v-model="command.enabled" type="checkbox"> Allow models to run this command</label>
              <label class="check-label"><input v-model="command.verification" type="checkbox" :aria-describedby="`tool-command-check-help-${index}`"> Required feature check</label>
              <p :id="`tool-command-check-help-${index}`" class="page-note">When enabled, this check must pass on the current changes before a new implementation request is ready for review. Use a test, lint or build command that exits when finished. Disabling the command excludes it from new requests.</p>
            </div>
          </section>
          <CliToolsEditor :editor="editor" />
          <McpConnectionsEditor :editor="editor" />
          <div class="tool-save-actions"><UButton type="submit" :loading="draft.busy && !draft.discovering" :disabled="!canSave">Save tool access</UButton><UButton v-if="dirty || stale" type="button" color="neutral" variant="ghost" @click="editor.reload">Discard edits and reload</UButton></div>
        </fieldset>
      </form>
      <p v-if="validation" role="status" class="error-text">{{ validation }}</p>
      <p v-if="stale" role="status" class="access-notice">Saved access changed while you were editing. Your draft is kept. Discard edits and reload before saving again.</p>
      <div v-if="!view.canEdit" class="tool-guidance"><p>{{ view.saveBlockedReason || 'Pause new starts and finish or stop queued and running work before changing tool access.' }}</p><UButton v-if="state.settings && !state.settings.board.paused" type="button" color="neutral" variant="outline" icon="i-lucide-pause" :loading="pausing" :disabled="locked" @click="pause">Pause new starts</UButton><p v-else class="page-note">Open Taskboard to finish or stop waiting work. Tool changes, including revocation, take effect after the worker is drained and you save.</p></div>
      <p v-else class="page-note">New starts are paused. Save your access changes, then resume when you are ready.</p>
    </template>
    <p v-else class="page-note">Tool access is not available yet. Refresh to load this worker’s saved grants.</p>
    <p v-if="draft.error" role="alert" class="error-text">{{ draft.error }}</p>
    <p v-if="draft.notice" role="status" class="page-note">{{ draft.notice }}</p>
    <div v-if="draft.uncertain" class="access-notice" role="status"><p>The save acknowledgement is uncertain. Check saved access, then load it to review or retry the exact save.</p><div class="tool-save-actions"><UButton type="button" color="neutral" variant="outline" :disabled="draft.busy || draft.checking || !state.unlocked" @click="editor.retry">Retry same save</UButton><UButton type="button" color="neutral" variant="outline" :disabled="draft.busy || draft.checking || !state.unlocked" @click="editor.resolveUncertain">Load saved access</UButton></div></div>
    <UButton v-if="!view || draft.uncertain" type="button" color="neutral" variant="outline" :loading="draft.checking" :disabled="draft.busy || !state.unlocked" @click="editor.check">Check saved access</UButton>
  </section>
</template>
<style scoped>
.tool-access { min-width: 0; }
h2, h3 { margin: 0; color: var(--ui-text-highlighted); } h3 { font-size: 1rem; font-weight: 650; }
.section-heading { flex-wrap: wrap; gap: 12px; }
.tool-fields { border: 0; margin: 0; padding: 0; min-width: 0; }
.builtins-section, .commands-section { display: grid; gap: 10px; padding-block: 24px; border-bottom: 1px solid var(--ui-border); margin-bottom: 24px; }
.access-scope, .authority-note, .access-notice { padding: 14px; background: var(--ui-bg-elevated); border-left: 2px solid var(--ui-border-accented); font-size: .8125rem; line-height: 1.6; }
.file-grant { align-items: start; gap: 12px; padding-block: 14px; }
.timeout-input { max-width: 16rem; }
.file-grant input { margin-top: 4px; }
.file-grant span { display: grid; gap: 4px; }
.file-grant span span { font-weight: 400; color: var(--ui-text-muted); line-height: 1.5; }
label { font-size: .8125rem; font-weight: 600; color: var(--ui-text-highlighted); }
.check-label { min-height: 44px; gap: 10px; }
.command-preset { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; padding: 20px; border: 1px solid var(--ui-border); border-radius: 10px; min-width: 0; }
.command-preset strong { overflow-wrap: anywhere; }
.command-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.command-fields > div { display: grid; gap: 8px; min-width: 0; }
.tool-save-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 24px; }
.tool-guidance { margin-top: 20px; font-size: .875rem; line-height: 1.6; }
input[type=checkbox] { width: 20px; height: 20px; min-height: 20px; flex: 0 0 20px; accent-color: var(--ui-primary); }
:deep(input:not([type=checkbox])), :deep(button) { min-height: 44px; }
@media (max-width: 620px) { .command-fields { grid-template-columns: minmax(0, 1fr); } .command-preset { padding: 14px; } .tool-save-actions { flex-direction: column; } .tool-save-actions :deep(button) { justify-content: center; } }
</style>
