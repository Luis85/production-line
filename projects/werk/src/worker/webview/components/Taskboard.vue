<script setup lang="ts">
import { computed, ref, watch, nextTick, onActivated, onDeactivated } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import USelect from '@nuxt/ui/components/Select.vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import { state, workspaceAction, request, date } from '../store';
import type { LocalTask } from '../../application/local-tasks';
const route = useRoute(), router = useRouter();
const capacity = ref(16), remoteQueue = ref(0), order = ref('fifo'), busy = ref(false), archived = ref(false), detail = ref<LocalTask | null>(null), removing = ref(false);
const search = ref(''), status = ref('all'), selectedId = ref(''), detailLoading = ref(false), detailError = ref(''), actionError = ref('');
let inspectTrigger: HTMLElement | null = null, detailRevision = 0;
const statusOptions = [{ label: 'All file tasks', value: 'all' }, { label: 'Waiting for answer', value: 'waiting_input' }, { label: 'Decision needed', value: 'escalated' }, { label: 'Needs review', value: 'review' }, { label: 'Failed', value: 'failed' }, { label: 'Queued', value: 'queued' }, { label: 'Running', value: 'running' }, { label: 'Cancelled', value: 'cancelled' }];
watch(() => route.query.fileState, value => { status.value = statusOptions.some(item => item.value === value) ? String(value) : 'all'; search.value = ''; archived.value = false; }, { immediate: true });
async function closeDetail() {
  detailRevision++; selectedId.value = ''; detail.value = null; detailLoading.value = false; detailError.value = ''; actionError.value = ''; removing.value = false;
  await nextTick(); (inspectTrigger?.isConnected ? inspectTrigger : document.getElementById('taskboard-title'))?.focus({ preventScroll: true });
}
async function focusFileTasks() { if (!['review', 'failed'].includes(String(route.query.fileState))) return; await nextTick(); const heading = document.getElementById('taskboard-title'); heading?.focus({ preventScroll: true }); heading?.scrollIntoView({ block: 'start' }); }
onActivated(() => { void focusFileTasks(); });
watch(() => route.query.fileState, () => { if (route.path === '/history') void focusFileTasks(); });
const columns = [{ id: 'queued', title: 'Queued' }, { id: 'running', title: 'Running' }, { id: 'finished', title: 'Review & finished' }];
const attentionColumn = { id: 'attention', title: 'Needs your input' };
const shownColumns = computed(() => {
  const available = allTasks.value.some(task => ['waiting_input', 'escalated'].includes(task.status)) ? [attentionColumn, ...columns] : columns;
  const target = ['waiting_input', 'escalated'].includes(status.value) ? 'attention' : ['queued', 'running'].includes(status.value) ? status.value : 'finished';
  return status.value === 'all' ? available : [...columns, attentionColumn].filter(column => column.id === target);
});
const allTasks = computed(() => state.board?.tasks ?? []);
const visible = computed(() => allTasks.value.filter(task => (archived.value || !task.archived) && (status.value === 'all' || task.status === status.value) && [task.title, task.id, task.provider].join(' ').toLowerCase().includes(search.value.trim().toLowerCase())));
const tasksFor = (column: string) => visible.value.filter(task => column === 'attention' ? ['waiting_input', 'escalated'].includes(task.status) : column === 'finished' ? !['queued', 'running', 'waiting_input', 'escalated'].includes(task.status) : task.status === column);
function clearFilters() { search.value = ''; status.value = 'all'; archived.value = true; }
watch(() => !!state.settings, value => { if (value && state.settings) { capacity.value = state.settings.board.queueCapacity; remoteQueue.value = state.settings.board.orchestratorQueue; order.value = state.settings.board.order; } }, { immediate: true });
async function readDetail(id: string, focus = false) {
  const revision = ++detailRevision;
  detailLoading.value = true; detailError.value = '';
  try {
    const result = await request('/api/taskboard/detail', 'POST', { id });
    if (revision !== detailRevision || !state.unlocked || selectedId.value !== id) return;
    detail.value = result;
    if (focus) { await nextTick(); if (revision === detailRevision) document.getElementById('local-task-detail')?.focus(); }
  } catch (error) {
    if (revision === detailRevision && state.unlocked && selectedId.value === id) detailError.value = error instanceof Error ? error.message : 'Task evidence could not be loaded. Retry to inspect this task.';
  } finally { if (revision === detailRevision) detailLoading.value = false; }
}
watch(() => [selectedId.value, state.board?.tasks.find(task => task.id === selectedId.value)?.status] as const, ([id, value], [previousId, previous]) => { if (id === previousId && value && previous && value !== previous) void readDetail(id); });
watch(() => state.unlocked, value => { if (!value) { detailRevision++; selectedId.value = ''; detail.value = null; detailLoading.value = false; detailError.value = ''; actionError.value = ''; } }, { flush: 'sync' });
onDeactivated(() => { detailRevision++; if (detailLoading.value && selectedId.value) detailError.value = 'Evidence loading was paused when you left History. Retry to load this task.'; detailLoading.value = false; });
async function action(body: { id: string; action: string; priority?: number }) {
  if (busy.value) return;
  busy.value = true; actionError.value = '';
  try {
    const result = await workspaceAction('/api/taskboard/action', body);
    if (!state.unlocked || selectedId.value !== body.id) return;
    if (!result) { actionError.value = state.actionError || 'The task could not be updated. Try again.'; return; }
    removing.value = false;
    if (body.action === 'delete') await closeDetail(); else await readDetail(body.id);
  } finally { busy.value = false; }
}
async function inspect(id: string, event: MouseEvent) {
  inspectTrigger = event.currentTarget as HTMLElement;
  selectedId.value = id; detail.value = null; removing.value = false; actionError.value = '';
  await readDetail(id, true);
}
async function openConversation() {
  if (busy.value || !detail.value) return;
  busy.value = true; actionError.value = '';
  try { if (await workspaceAction('/api/sessions', { action: 'select', id: detail.value.sessionId })) await router.push('/chat'); else actionError.value = state.actionError || 'The conversation could not be opened. Try again.'; }
  finally { busy.value = false; }
}
async function save() { busy.value = true; try { await workspaceAction('/api/settings', { board: { queueCapacity: capacity.value, orchestratorQueue: remoteQueue.value, order: order.value } }); } finally { busy.value = false; } }
function download() { if (!detail.value?.patch) return; const url = URL.createObjectURL(new Blob([detail.value.patch], { type: 'text/plain' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'werk-' + detail.value.id + '.patch'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
</script>
<template>
  <section v-if="state.unlocked" class="taskboard" aria-labelledby="taskboard-title">
    <div class="section-heading">
      <div>
        <h2 id="taskboard-title" tabindex="-1">File tasks</h2>
        <p class="page-note">
          Patch-producing tasks from Run task in Chat. Each owns a separate session and runs in this
          worker’s shared queue.
        </p>
      </div>
      <UButton
        color="neutral"
        variant="outline"
        :icon="state.settings?.board.paused ? 'i-lucide-play' : 'i-lucide-pause'"
        :disabled="busy"
        @click="
          workspaceAction('/api/settings', { board: { paused: !state.settings?.board.paused } })
        "
      >
        {{ state.settings?.board.paused ? 'Resume queue' : 'Pause queue' }}
      </UButton>
    </div>
    <p v-if="state.board?.persistenceError" role="alert" class="error-text">
      A task result could not be saved. Check free disk space and state-directory permissions before
      restarting.
    </p>
    <div v-if="state.settings?.board.paused" class="notice">
      Queue paused. The running task can finish; queued chat, file tasks and orchestrator
      assignments wait.
    </div>
    <div v-if="allTasks.length" class="history-filters file-task-filters">
      <div>
        <label for="file-task-search">Find a file task</label>
        <UInput
          id="file-task-search"
          v-model="search"
          icon="i-lucide-search"
          placeholder="Title, task ID or provider"
          class="w-full"
        />
      </div>
      <div>
        <label for="file-task-status">State</label>
        <USelect id="file-task-status" v-model="status" :items="statusOptions" class="w-full" />
      </div>
    </div>
    <p v-if="allTasks.length" class="page-note" role="status">
      {{ visible.length }} matching {{ visible.length === 1 ? 'file task' : 'file tasks' }}
    </p>
    <div v-if="!allTasks.length" class="compact-empty">
      <p>No file tasks yet. Prepare approved files in Chat to receive a patch for review.</p>
      <UButton to="/chat" color="neutral" variant="outline">Open Chat</UButton>
    </div>
    <div v-else-if="!visible.length" class="compact-empty">
      <p>No file tasks match these filters.</p>
      <UButton color="neutral" variant="outline" @click="clearFilters">Show all file tasks</UButton>
    </div>
    <div v-else class="board-columns" :class="{ filtered: status !== 'all', 'with-attention': shownColumns.length === 4 }">
      <section v-for="column in shownColumns" :key="column.id" class="board-column">
        <h3>
          {{ column.title }}
          <span>{{ tasksFor(column.id).length }}</span>
        </h3>
        <p v-if="!tasksFor(column.id).length" class="board-empty">
          {{
            column.id === 'queued'
              ? 'Ready for your next task'
              : column.id === 'running'
                ? 'No local task running'
                : 'Results appear here'
          }}
        </p>
        <article v-for="task in tasksFor(column.id)" :key="task.id" class="task-card">
          <div class="actions">
            <UBadge
              :color="
                task.status === 'failed'
                  ? 'error'
                  : task.status === 'review'
                    ? 'primary'
                    : 'neutral'
              "
              variant="subtle"
            >
              {{ task.status === 'review' ? 'Review patch' : task.status }}
            </UBadge>
            <span v-if="task.priority === 2" class="muted">High priority</span>
          </div>
          <h4>{{ task.title }}</h4>
          <p>
            {{ task.provider }} · {{ task.files.length }}
            {{ task.files.length === 1 ? 'file' : 'files' }}
          </p>
          <UButton
            color="neutral"
            variant="outline"
            :aria-label="'Inspect local task ' + task.title"
            :aria-expanded="selectedId === task.id"
            aria-controls="local-task-evidence"
            @click="inspect(task.id, $event)"
          >
            {{ task.status === 'review' ? 'Review patch' : 'Inspect task' }}
          </UButton>
        </article>
      </section>
    </div>
    <label v-if="allTasks.length" class="check-label">
      <input v-model="archived" type="checkbox" />
      Show archived tasks
    </label>
    <section
      v-if="selectedId"
      id="local-task-evidence"
      @keydown.esc.prevent="closeDetail"
      class="evidence-panel"
      :aria-busy="detailLoading"
    >
      <div class="section-heading">
        <h3 id="local-task-detail" tabindex="-1">{{ detail?.title ?? 'File task evidence' }}</h3>
        <UButton
          color="neutral"
          variant="ghost"
          aria-label="Close local task"
          icon="i-lucide-x"
          @click="closeDetail"
        />
      </div>
      <p v-if="detailLoading" role="status">Loading task evidence…</p>
      <div v-if="detailError" class="notice">
        <p role="alert" class="error-text">{{ detailError }}</p>
        <UButton
          color="neutral"
          variant="outline"
          :disabled="detailLoading"
          @click="readDetail(selectedId, true)"
        >
          Retry loading evidence
        </UButton>
      </div>
      <p v-if="actionError" role="alert" class="error-text">{{ actionError }}</p>
      <template v-if="detail">
        <p>{{ detail.status }} · {{ date(detail.createdAt) }} · {{ detail.provider }}</p>
        <p>{{ detail.instruction }}</p>
        <p v-if="detail.error" class="error-text">{{ detail.error }}</p>
        <p v-if="detail.summary">{{ detail.summary }}</p>
        <p class="break-anywhere">{{ detail.repository }}</p>
        <ul>
          <li v-for="file in detail.files" :key="file.path">{{ file.path }}</li>
        </ul>
        <div class="actions">
          <UButton
            color="neutral"
            variant="outline"
            :disabled="busy || state.workspaceBusy"
            @click="openConversation"
          >
            Open conversation
          </UButton>
          <UButton
            v-if="['queued', 'running'].includes(detail.status)"
            color="neutral"
            variant="outline"
            :disabled="busy"
            @click="action({ id: detail.id, action: 'cancel' })"
          >
            {{ detail.status === 'queued' ? 'Cancel queued task' : 'Stop task' }}
          </UButton>
          <UButton
            v-if="detail.status === 'queued'"
            color="neutral"
            variant="outline"
            :disabled="busy"
            @click="
              action({ id: detail.id, action: 'priority', priority: detail.priority === 2 ? 1 : 2 })
            "
          >
            {{ detail.priority === 2 ? 'Normal priority' : 'Raise priority' }}
          </UButton>
          <UButton
            v-if="['failed', 'cancelled'].includes(detail.status)"
            :disabled="busy"
            @click="action({ id: detail.id, action: 'retry' })"
          >
            Retry saved input
          </UButton>
          <UButton v-if="detail.patch" icon="i-lucide-download" @click="download">
            Download patch
          </UButton>
          <template v-if="!['queued', 'running'].includes(detail.status)">
            <UButton
              color="neutral"
              variant="outline"
              :disabled="busy"
              @click="action({ id: detail.id, action: detail.archived ? 'restore' : 'archive' })"
            >
              {{ detail.archived ? 'Restore' : 'Archive' }}
            </UButton>
            <UButton color="error" variant="ghost" @click="removing = !removing">Delete</UButton>
          </template>
        </div>
        <div v-if="removing" class="confirm-row">
          <p>Delete the saved task and its board evidence?</p>
          <UButton
            color="error"
            :disabled="busy"
            @click="action({ id: detail.id, action: 'delete' })"
          >
            Confirm deletion
          </UButton>
          <UButton color="neutral" variant="ghost" :disabled="busy" @click="removing = false">
            Keep task
          </UButton>
        </div>
        <p v-if="detail.patch" class="page-note">
          Inspect this patch before applying it. Tests have not run. In your repository, use
          <code>git apply --check path/to/download.patch</code>
          before applying with
          <code>git apply</code>. Inputs were captured when this task was queued.
        </p>
        <details v-if="detail.patch">
          <summary>Inspect patch</summary>
          <pre>{{ detail.patch }}</pre>
        </details>
      </template>
    </section>
    <details class="monitor-section">
      <summary>Configure worker queue</summary>
      <form class="settings-form" @submit.prevent="save">
        <div class="settings-grid">
          <div>
            <label for="local-capacity">Chat + file-task capacity · queued + running</label>
            <UInput
              id="local-capacity"
              v-model.number="capacity"
              type="number"
              min="1"
              max="64"
              required
              class="w-full"
            />
          </div>
          <div>
            <label for="remote-queue">Extra orchestrator queue places</label>
            <UInput
              id="remote-queue"
              v-model.number="remoteQueue"
              type="number"
              min="0"
              max="64"
              required
              class="w-full"
            />
          </div>
          <div>
            <label for="queue-order">File-task start order</label>
            <USelect
              id="queue-order"
              v-model="order"
              :items="[
                { label: 'First in, first out', value: 'fifo' },
                { label: 'High priority first', value: 'priority' },
              ]"
              class="w-full"
            />
          </div>
        </div>
        <p class="page-note">
          This worker executes one task at a time across chat, file tasks and orchestrator
          assignments. Add more workers to run tasks in parallel. Extra queue places hold
          orchestrator assignments while their leases are renewed; lowering capacity keeps accepted
          work.
        </p>
        <UButton type="submit" :loading="busy">Save queue settings</UButton>
      </form>
    </details>
    <section v-if="state.status?.queuedTasks?.length" class="monitor-section">
      <h3>Waiting from the orchestrator</h3>
      <ul class="profile-list">
        <li v-for="task in state.status.queuedTasks" :key="task.id">
          <div>
            <strong>{{ task.id }}</strong>
            <span>{{ task.profile }} · lease maintained</span>
          </div>
        </li>
      </ul>
    </section>
    <p v-if="state.actionError" role="alert" class="error-text">{{ state.actionError }}</p>
  </section>
</template>
