<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import { state, workspaceAction, taskStatus } from '../store';
defineProps<{ disabled?: boolean }>();
defineEmits<{ newTask: [] }>();
const expanded = ref(false), mobile = ref(true);
let viewport: MediaQueryList | null = null;
function updateViewport() { mobile.value = viewport?.matches ?? true; expanded.value = !mobile.value; }
onMounted(() => { viewport = window.matchMedia('(max-width: 900px)'); updateViewport(); viewport.addEventListener('change', updateViewport); });
onUnmounted(() => viewport?.removeEventListener('change', updateViewport));
function toggleTasks(event: Event) { expanded.value = (event.target as HTMLDetailsElement).open; }
function closeTasks(event: KeyboardEvent) {
  if (!mobile.value || !expanded.value) return;
  event.preventDefault(); expanded.value = false;
  void nextTick(() => document.getElementById('saved-task-summary')?.focus());
}
const rename = ref(''), busy = ref(false), removing = ref(false), error = ref(''), filter = ref('');
const current = computed(() => state.sessions?.records.find(item => item.id === state.sessions?.selected));
const activeRecords = computed(() => state.sessions?.records.filter(item => !item.archived) ?? []);
const records = computed(() => activeRecords.value.filter(item => [item.title, item.taskId].join(' ').toLowerCase().includes(filter.value.trim().toLowerCase())).slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
const kindLabel = (kind: string) => kind === 'local' ? 'File task' : kind === 'orchestrator' ? 'Assigned' : 'Chat';
watch(() => [current.value?.id, current.value?.title].join('|'), () => { rename.value = current.value?.title ?? ''; removing.value = false; }, { immediate: true });
async function action(body: unknown) { busy.value = true; error.value = ''; try { if (await workspaceAction('/api/sessions', body)) { removing.value = false; if ((body as { action?: string }).action === 'select') { if (mobile.value) expanded.value = false; await nextTick(); document.getElementById('chat-task-title')?.focus(); } } else error.value = state.actionError || 'The task could not be updated. Your input is retained.'; } finally { busy.value = false; } }
</script>
<template>
  <aside class="session-panel" aria-label="Tasks and sessions">
    <div class="rail-heading">
      <h2>Your tasks</h2>
      <span class="muted">{{ activeRecords.length }}</span>
    </div>
    <UButton
      id="new-task-button"
      icon="i-lucide-plus"
      color="neutral"
      variant="outline"
      class="rail-new"
      :disabled="disabled || state.workspaceBusy"
      @click="$emit('newTask')"
      >New task</UButton
    >
    <details class="saved-task-disclosure" :open="expanded" @toggle="toggleTasks" @keydown.esc="closeTasks">
      <summary id="saved-task-summary" class="saved-task-summary">
        <span>
          <strong>{{ current?.title ?? "Saved tasks" }}</strong>
          <span class="muted"
            >{{ current ? taskStatus(current.status) + " · " : "" }}{{ activeRecords.length }} saved
            {{ activeRecords.length === 1 ? "task" : "tasks" }}</span
          >
        </span>
        <span class="saved-task-summary-action">Switch task</span>
      </summary>
      <div class="saved-task-content">
        <label class="sr-only" for="task-filter">Find a task</label>
        <UInput
          id="task-filter"
          v-model="filter"
          icon="i-lucide-search"
          placeholder="Find a task"
          class="w-full"
        />
        <nav class="task-rail-list" aria-label="Saved tasks">
          <button
            v-for="item in records"
            :key="item.id"
            class="task-rail-item"
            :class="{ selected: item.id === current?.id }"
            :aria-current="item.id === current?.id ? 'true' : undefined"
            :disabled="busy || disabled || state.workspaceBusy"
            @click="action({ action: 'select', id: item.id })"
          >
            <strong>{{ item.title }}</strong>
            <span>
              <span class="task-phase" :class="item.status">{{ taskStatus(item.status) }}</span> ·
              {{ kindLabel(item.kind) }} · {{ item.provider.replace("-cli", "").replace("-api", "") }}</span
            >
          </button>
          <p v-if="!records.length" class="page-note">
            {{
              activeRecords.length
                ? "No tasks match your search. Try another title or task ID."
                : "No active tasks yet. Start a new task or restore one from History."
            }}
          </p>
        </nav>
        <RouterLink class="rail-history" to="/history">View task history →</RouterLink>
        <details v-if="current" class="task-settings">
          <summary>Task settings</summary>
          <form
            class="settings-form"
            @submit.prevent="action({ action: 'rename', id: current?.id, title: rename })"
          >
            <h3>Current task</h3>
            <label for="rename-session">Name</label>
            <UInput id="rename-session" v-model="rename" maxlength="120" required class="w-full" />
            <UButton
              type="submit"
              color="neutral"
              variant="outline"
              :loading="busy"
              :disabled="disabled || state.workspaceBusy"
              >Rename</UButton
            >
            <div class="actions">
              <UButton
                color="neutral"
                variant="ghost"
                :disabled="busy || disabled || state.workspaceBusy || current.busy"
                @click="action({ action: 'archive', id: current?.id })"
                >Archive</UButton
              >
              <UButton
                color="error"
                variant="ghost"
                :disabled="busy || disabled || state.workspaceBusy || current.busy"
                @click="removing = !removing"
                >Delete</UButton
              >
            </div>
            <div v-if="removing" class="confirm-row">
              <p>Delete this task and all its saved messages?</p>
              <UButton
                color="error"
                :loading="busy"
                :disabled="disabled || state.workspaceBusy"
                @click="action({ action: 'delete', id: current?.id })"
                >Confirm deletion</UButton
              >
              <UButton variant="ghost" color="neutral" @click="removing = false">Keep task</UButton>
            </div>
          </form>
        </details>
      </div>
    </details>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
  </aside>
</template>
