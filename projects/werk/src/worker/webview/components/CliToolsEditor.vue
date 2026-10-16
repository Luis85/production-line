<script setup lang="ts">
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import UTextarea from '@nuxt/ui/components/Textarea.vue';
import type { ToolAccessEditor } from '../tool-access-editor';
const props = defineProps<{ editor: ToolAccessEditor }>();
const workerNode = () => props.editor.workerNode();
</script>
<template>
  <section aria-labelledby="cli-tools-title" class="cli-editor">
    <div class="section-heading"><h3 id="cli-tools-title">CLI tools</h3><UButton type="button" color="neutral" variant="outline" icon="i-lucide-plus" :disabled="editor.locked.value || editor.draft.cliTools.length >= 8" @click="editor.addCliTool">Add CLI tool</UButton></div>
    <p class="page-note">Let models call a project command-line tool with their own arguments, such as <code>node bin/tool.mjs backlog context ITEM</code>. You fix the executable and leading arguments; the model chooses an allowed command and adds options. CLI tools run only in a task worktree, without a shell.</p>
    <p class="authority-note">Commands run as the worker’s account, with its file and network permissions. Grant only trusted CLIs. For commands that can write, require a preview flag whose behavior you have verified.</p>
    <p v-if="!editor.draft.cliTools.length" class="empty-copy">No CLI tools configured.</p>
    <section v-for="(tool, index) in editor.draft.cliTools" :key="index" class="cli-tool" :aria-labelledby="`cli-title-${index}`">
      <div class="section-heading"><h4 :id="`cli-title-${index}`">{{ tool.name || 'New CLI tool' }}</h4><UButton type="button" color="neutral" variant="ghost" icon="i-lucide-trash-2" :aria-label="`Remove CLI tool ${tool.name || index + 1}`" :disabled="editor.locked.value" @click="editor.draft.cliTools.splice(index, 1)">Remove</UButton></div>
      <div class="cli-fields">
        <div><label :for="`cli-name-${index}`">Tool name</label><UInput :id="`cli-name-${index}`" v-model="tool.name" required maxlength="120" placeholder="Project harness" class="w-full" /></div>
        <div><label :for="`cli-id-${index}`">Tool ID · model sees werk_cli_{{ tool.id || 'id' }}</label><UInput :id="`cli-id-${index}`" v-model="tool.id" required maxlength="48" class="w-full" /></div>
      </div>
      <label :for="`cli-description-${index}`">What the tool does · shown to the model</label><UTextarea :id="`cli-description-${index}`" v-model="tool.description" :rows="2" maxlength="1000" placeholder="Reads the project backlog and runs project checks." class="w-full" />
      <label :for="`cli-executable-${index}`">Executable · absolute path</label>
      <div class="executable-row"><UInput :id="`cli-executable-${index}`" v-model="tool.executable" required placeholder="/absolute/path/to/node" class="w-full" /><UButton v-if="workerNode()" type="button" color="neutral" variant="outline" :aria-label="`Use the worker's Node.js for ${tool.name || 'this CLI tool'}`" @click="tool.executable = workerNode()">Use worker Node.js</UButton></div>
      <label :for="`cli-args-${index}`">Fixed leading arguments · JSON array, relative to the task worktree</label><UTextarea :id="`cli-args-${index}`" v-model="tool.arguments" :rows="1" placeholder='["bin/tool.mjs"]' class="w-full" />
      <label :for="`cli-commands-${index}`">Allowed commands · one per line</label>
      <UTextarea :id="`cli-commands-${index}`" v-model="tool.commands" :rows="6" :placeholder="'help\nbacklog context\nbacklog set requires --dry-run\neol refuses --fix --hook'" class="w-full mono" :aria-describedby="`cli-commands-help-${index}`" />
      <p :id="`cli-commands-help-${index}`" class="page-note">Start each line with one or two command words. Use <code>requires</code> or <code>refuses</code> at most once each, followed by one or more flags. <code>requires</code> accepts any one listed flag; <code>refuses</code> blocks every listed option.</p>
      <label :for="`cli-refused-${index}`">Refused options · all commands</label><UInput :id="`cli-refused-${index}`" v-model="tool.refusedOptions" placeholder="--root --config --out" class="w-full" />
      <details class="cli-limits"><summary>Limits and truncation hint</summary>
        <div class="cli-fields three">
          <div><label :for="`cli-max-args-${index}`">Maximum arguments</label><UInput :id="`cli-max-args-${index}`" v-model.number="tool.maxArgs" type="number" min="1" max="64" step="1" class="w-full" /></div>
          <div><label :for="`cli-max-length-${index}`">Maximum argument length</label><UInput :id="`cli-max-length-${index}`" v-model.number="tool.maxArgLength" type="number" min="1" max="2048" step="1" class="w-full" /></div>
          <div><label :for="`cli-output-${index}`">Output limit · KiB</label><UInput :id="`cli-output-${index}`" v-model.number="tool.outputKiB" type="number" min="1" max="64" step="1" class="w-full" /></div>
        </div>
        <label :for="`cli-hint-${index}`">Hint after truncated output</label><UInput :id="`cli-hint-${index}`" v-model="tool.truncationHint" maxlength="300" class="w-full" />
      </details>
      <label class="check-label"><input v-model="tool.enabled" type="checkbox"> Allow models to call this CLI tool</label>
    </section>
  </section>
</template>
<style scoped>
h3, h4 { margin: 0; color: var(--ui-text-highlighted); font-weight: 650; }
h3 { font-size: 1rem; } h4 { font-size: .9375rem; overflow-wrap: anywhere; }
.cli-editor { display: grid; gap: 10px; padding-block: 0 24px; border-bottom: 1px solid var(--ui-border); margin-bottom: 24px; }
.section-heading { flex-wrap: wrap; gap: 12px; }
.cli-tool { margin-top: 10px; padding: 20px; border: 1px solid var(--ui-border); border-radius: 10px; min-width: 0; display: grid; gap: 10px; }
.cli-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.cli-fields.three { grid-template-columns: repeat(3, minmax(0, 1fr)); margin-block: 12px; }
.cli-fields > div { display: grid; gap: 8px; min-width: 0; }
.executable-row { display: flex; gap: 12px; align-items: center; min-width: 0; }
label { font-size: .8125rem; font-weight: 600; color: var(--ui-text-highlighted); }
.check-label { min-height: 44px; font-weight: 500; gap: 10px; }
.authority-note { font-size: .8125rem; line-height: 1.6; padding: 14px; background: var(--ui-bg-elevated); border-left: 2px solid var(--ui-border-accented); overflow-wrap: anywhere; }
.cli-limits summary { cursor: pointer; font-size: .8125rem; font-weight: 600; min-height: 44px; display: flex; align-items: center; }
.empty-copy { color: var(--ui-text-muted); font-size: .875rem; margin: 10px 0; }
code { font-size: .8125rem; overflow-wrap: anywhere; }
.mono :deep(textarea) { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
input[type=checkbox] { width: 20px; height: 20px; min-height: 20px; flex: 0 0 20px; accent-color: var(--ui-primary); }
:deep(input:not([type=checkbox])), :deep(button) { min-height: 44px; }
@media (max-width: 620px) { .cli-fields, .cli-fields.three { grid-template-columns: minmax(0, 1fr); } .cli-tool { padding: 14px; } .executable-row { flex-direction: column; align-items: stretch; } }
</style>
