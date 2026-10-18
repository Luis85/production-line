<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import { parsePatchPreview, type PatchFile } from '../patch-review';
const props = defineProps<{ patch: string; taskId?: string }>();
const preview = computed(() => parsePatchPreview(props.patch));
const selectedId = ref(''), heading = ref<HTMLElement | null>(null), titleId = useId();
const selected = computed(() => preview.value.files.find(file => file.id === selectedId.value) ?? preview.value.files[0]);
watch(() => props.patch, () => { selectedId.value = ''; });
// Control characters in filenames stay explicit instead of changing the visual path.
const visiblePath = (path: string) => path.replace(/[\x00-\x1f\x7f]/g, value => '\\' + ({ '\n': 'n', '\r': 'r', '\t': 't' }[value] ?? 'u' + value.charCodeAt(0).toString(16).padStart(4, '0')));
const changes = (file: PatchFile) => `${file.additions} added, ${file.deletions} removed${preview.value.truncated || file.malformed ? ' in parsed preview' : ''}`;
async function choose(file: PatchFile) {
  selectedId.value = file.id;
  await nextTick();
  heading.value?.focus({ preventScroll: true });
  if (matchMedia('(max-width: 700px)').matches) heading.value?.scrollIntoView({ block: 'start' });
}
function download() {
  const url = URL.createObjectURL(new Blob([props.patch], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url;
  anchor.download = 'werk-' + (props.taskId?.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100) || 'changes') + '.patch';
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>
<template>
  <section class="patch-review" aria-label="Saved changes">
    <div class="patch-toolbar">
      <p v-if="preview.unrecognized">Saved patch text</p>
      <p v-else-if="preview.files.length">{{ preview.files.length }} {{ preview.files.length === 1 ? 'file' : 'files' }}{{ preview.truncated ? ' in this preview' : '' }}</p>
      <p v-else>No patch content is available to display.</p>
      <UButton v-if="patch.length" color="neutral" variant="outline" icon="i-lucide-download" @click="download">Download full patch</UButton>
    </div>
    <p v-if="preview.truncated" class="patch-notice" role="status">This preview is limited for readability. Some files, lines, long paths or ends of long lines may be omitted. Counts describe the parsed preview. Download the full patch to inspect all changes; the download is unchanged.</p>
    <p v-if="preview.unrecognized" class="patch-notice">This text is not a recognized unified patch. It remains available below and in the full download; no successful application or verification is implied.</p>
    <div v-if="selected" class="patch-layout">
      <nav class="patch-files" aria-label="Changed files">
        <button v-for="file in preview.files" :key="file.id" type="button" :aria-pressed="selected.id === file.id" @click="choose(file)">
          <span class="patch-file-path">{{ visiblePath(file.path) }}</span>
          <span class="patch-file-meta">{{ file.change }} · {{ changes(file) }}</span>
        </button>
      </nav>
      <div class="patch-content">
        <h3 :id="titleId" ref="heading" tabindex="-1">{{ visiblePath(selected.path) }}</h3>
        <p v-if="selected.previousPath" class="patch-previous">From <code>{{ visiblePath(selected.previousPath) }}</code></p>
        <p class="patch-description">{{ selected.change }} · {{ changes(selected) }}</p>
        <p v-if="selected.malformed" class="patch-notice">Some lines could not be interpreted as a complete unified diff. Unrecognized lines are shown as saved text; use the full patch to inspect them.</p>
        <p v-if="selected.change === 'Binary'" class="patch-notice">Binary file changes cannot be reviewed as text. The saved patch metadata is shown below.</p>
        <div class="patch-lines" tabindex="0" role="region" :aria-labelledby="titleId">
          <table>
            <caption class="sr-only">Saved diff for {{ visiblePath(selected.path) }}. Added and removed lines include a text label and sign.</caption>
            <colgroup><col class="line-number" /><col class="line-number" /><col class="change-marker" /><col /></colgroup>
            <thead><tr><th scope="col">Old</th><th scope="col">New</th><th scope="col"><span class="sr-only">Change</span></th><th scope="col">Content</th></tr></thead>
            <tbody>
              <tr v-for="(line, index) in selected.lines" :key="index" :class="'diff-' + line.kind">
                <template v-if="line.kind === 'hunk' || line.kind === 'meta'"><td colspan="4"><code>{{ line.text }}</code><span v-if="line.shortened" class="shortened"> [line shortened; full text in download]</span></td></template>
                <template v-else>
                  <td class="line-position">{{ line.oldLine ?? '—' }}</td><td class="line-position">{{ line.newLine ?? '—' }}</td>
                  <td class="diff-marker"><span class="sr-only">{{ line.kind === 'added' ? 'Added' : line.kind === 'removed' ? 'Removed' : 'Unchanged' }}</span><span aria-hidden="true">{{ line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' ' }}</span></td>
                  <td class="diff-text"><code>{{ line.text || ' ' }}</code><span v-if="line.shortened" class="shortened"> [line shortened; full text in download]</span></td>
                </template>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
</template>
<style scoped>
.patch-review { min-width: 0; font-size: .875rem; }
.patch-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-3); margin-bottom: var(--space-4); }
.patch-toolbar p { margin: 0; color: var(--ui-text-muted); }
.patch-toolbar :deep(button) { min-height: 44px; }
.patch-notice { margin: var(--space-3) 0 var(--space-4); max-width: 75ch; color: var(--ui-text-muted); line-height: 1.65; }
.patch-layout { display: grid; grid-template-columns: minmax(170px, 26%) minmax(0, 1fr); gap: var(--space-6); align-items: start; }
.patch-files { display: grid; gap: var(--space-2); min-width: 0; max-height: 520px; overflow: auto; padding: 2px; }
.patch-files button { display: grid; gap: var(--space-2); min-height: 44px; width: 100%; padding: var(--space-3); border: 1px solid var(--ui-border); border-radius: 8px; text-align: left; cursor: pointer; }
.patch-files button:hover { background: var(--ui-bg-elevated); }
.patch-files button[aria-pressed='true'] { border-color: var(--ui-primary); background: var(--ui-bg-elevated); }
.patch-file-path { color: var(--ui-text-highlighted); overflow-wrap: anywhere; line-height: 1.5; }
.patch-file-meta { color: var(--ui-text-muted); font-size: .75rem; line-height: 1.5; }
.patch-content { min-width: 0; }
.patch-content h3 { margin: 0 0 var(--space-2); font-size: 1rem; line-height: 1.5; overflow-wrap: anywhere; scroll-margin-top: var(--space-4); }
.patch-previous, .patch-description { margin: var(--space-2) 0; overflow-wrap: anywhere; color: var(--ui-text-muted); line-height: 1.6; }
.patch-lines { max-height: 600px; max-width: 100%; overflow: auto; border: 1px solid var(--ui-border); border-radius: 8px; margin-top: var(--space-4); }
.patch-lines table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: .75rem; }
.line-number { width: 5ch; } .change-marker { width: 3ch; }
.patch-lines th { padding: var(--space-2) 4px; text-align: left; color: var(--ui-text-muted); border-bottom: 1px solid var(--ui-border); font-weight: 600; }
.patch-lines td { padding: 3px 4px; vertical-align: top; }
.patch-lines code { white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-mono, ui-monospace, monospace); line-height: 1.65; }
.line-position { color: var(--ui-text-muted); text-align: right; font-variant-numeric: tabular-nums; font-size: .6875rem; overflow-wrap: anywhere; }
.diff-marker { text-align: center; font-weight: 700; }
.diff-added { background: #183c2f; color: #c3f4d8; } .diff-removed { background: #45272e; color: #ffd4da; }
.diff-hunk { background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); }
.diff-meta, .shortened { color: var(--ui-text-muted); }
.diff-meta td, .diff-hunk td { padding: var(--space-2); }
.patch-files button:focus-visible, .patch-lines:focus-visible, .patch-content h3:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 2px; }
@media (max-width: 700px) { .patch-layout { grid-template-columns: minmax(0, 1fr); gap: var(--space-4); } .patch-files { max-height: 240px; } .patch-lines { max-height: 500px; } }
</style>
