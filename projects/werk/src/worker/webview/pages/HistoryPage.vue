<script setup lang="ts">
import RunEvidencePanel from '../components/RunEvidencePanel.vue';
import FeatureRequestsPanel from '../components/FeatureRequestsPanel.vue';
import { useRoute, useRouter } from 'vue-router';
import Taskboard from '../components/Taskboard.vue';
import { computed, nextTick, ref, watch, onActivated } from 'vue';
import UInput from '@nuxt/ui/components/Input.vue';
import USelect from '@nuxt/ui/components/Select.vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import UAlert from '@nuxt/ui/components/Alert.vue';
import UIcon from '@nuxt/ui/components/Icon.vue';
import { state, bytes, date, duration, outcome, workspaceAction, taskStatus } from '../store';
const route = useRoute(), router = useRouter(), opening = ref('');
const chatSearch = ref(''), chatStatus = ref('all'), chatArchive = ref('active'), taskKind = ref('all');
const taskKindOptions = [{ label: 'All task types', value: 'all' }, { label: 'Chat tasks', value: 'chat' }, { label: 'File tasks', value: 'local' }, { label: 'Assigned tasks', value: 'orchestrator' }];
const kindLabel = (kind: string) => kind === 'local' ? 'File task' : kind === 'orchestrator' ? 'Assigned task' : 'Chat task';
watch(() => route.query.taskState, value => { chatStatus.value = value === 'failed' ? 'failed' : value === 'attention' ? 'attention' : 'all'; chatSearch.value = ''; taskKind.value = 'all'; chatArchive.value = 'active'; }, { immediate: true });
async function focusTaskConversations() {
  const shouldFocus = () => state.unlocked && route.path === '/history' && ['failed', 'attention'].includes(String(route.query.taskState)) && !['review', 'failed'].includes(String(route.query.fileState));
  if (!shouldFocus()) return;
  await nextTick();
  if (!shouldFocus()) return;
  const heading = document.getElementById('chat-history-title');
  heading?.focus({ preventScroll: true });
  heading?.scrollIntoView({ block: 'start' });
}
onActivated(() => { void focusTaskConversations(); });
watch(() => route.query.taskState, () => { void focusTaskConversations(); });
const chatStatusOptions = [{ label: 'All states', value: 'all' }, { label: 'Needs your input', value: 'attention' }, ...['draft', 'queued', 'running', 'waiting_input', 'escalated', 'completed', 'failed', 'cancelled', 'interrupted'].map(value => ({ label: taskStatus(value), value }))];
const chatArchiveOptions = [{ label: 'Active tasks', value: 'active' }, { label: 'Archived tasks', value: 'archived' }, { label: 'All tasks', value: 'all' }];
const allChatTasks = computed(() => state.sessions?.records ?? []);
const chatTasks = computed(() => allChatTasks.value.filter(item =>
  (taskKind.value === 'all' || item.kind === taskKind.value) &&
  (chatStatus.value === 'all' || chatStatus.value === 'attention' && ['waiting_input', 'escalated'].includes(item.status) || item.status === chatStatus.value) &&
  (chatArchive.value === 'all' || item.archived === (chatArchive.value === 'archived')) &&
  [item.title, item.taskId, item.provider].join(' ').toLowerCase().includes(chatSearch.value.trim().toLowerCase())
).slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
function clearChatFilters() { chatSearch.value = ''; chatStatus.value = 'all'; chatArchive.value = 'all'; taskKind.value = 'all'; }
async function openChat(id: string) { if (opening.value) return; opening.value = id; try { if (await workspaceAction('/api/sessions', { action: 'select', id })) await router.push('/chat'); } finally { opening.value = ''; } }
const search = ref(''), filter = ref('all'), page = ref(1), selectedId = ref('');
let inspectTrigger: HTMLElement | null = null;
async function closeEvidence() {
  selectedId.value = '';
  await nextTick();
  if (inspectTrigger?.isConnected) inspectTrigger.focus();
}
async function inspect(pairId: string, event: MouseEvent) {
  if (selectedId.value === pairId) { await closeEvidence(); return; }
  inspectTrigger = event.currentTarget as HTMLElement;
  selectedId.value = pairId;
  await nextTick();
  const heading = document.getElementById('evidence-title');
  heading?.focus({ preventScroll: true });
  heading?.scrollIntoView({ block: 'start' });
}
const options = [{ label: 'All outcomes', value: 'all' }, { label: 'Simulated', value: 'simulated' }, { label: 'Review required', value: 'change-set' }, { label: 'Failed', value: 'failed' }, { label: 'Interrupted', value: 'interrupted' }, { label: 'Running', value: 'running' }, { label: 'Incomplete evidence', value: 'incomplete' }];
const filtered = computed(() => (state.history?.rows ?? []).filter(row => (filter.value === 'all' || row.outcome === filter.value) && [row.title, row.taskId, row.project, row.profile, row.provenance.featureId].join(' ').toLowerCase().includes(search.value.toLowerCase())));
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 25)));
const visible = computed(() => filtered.value.slice((page.value - 1) * 25, page.value * 25));
const selected = computed(() => state.history?.rows.find(row => row.pairId === selectedId.value));
watch([search, filter], () => { page.value = 1; });
watch(pages, value => { page.value = Math.min(page.value, value); });
</script>
<template>
  <section>
    <div class="page-heading">
      <div>
        <h1 tabindex="-1">History</h1>
        <p>Your chat tasks, file-task results and orchestrator evidence.</p>
      </div>
      <UBadge color="neutral" variant="subtle">
        {{ state.history?.rows.length ?? 0 }} orchestrator attempts
      </UBadge>
    </div>
    <nav class="history-views actions" aria-label="History views">
      <UButton to="/history" color="neutral" :variant="!route.query.view ? 'solid' : 'outline'">Task history</UButton>
      <UButton to="/history?view=features" color="neutral" :variant="route.query.view === 'features' ? 'solid' : 'outline'">Project requests</UButton>
      <UButton to="/history?view=runs" color="neutral" :variant="route.query.view === 'runs' ? 'solid' : 'outline'">Execution evidence</UButton>
    </nav>
    <RunEvidencePanel v-if="state.unlocked && (route.query.view === 'runs' || route.query.runSession)" />
    <FeatureRequestsPanel v-if="state.unlocked && route.query.view === 'features'" />
    <div v-show="route.query.view !== 'runs' && route.query.view !== 'features'">
    <section v-if="state.unlocked" class="monitor-section" aria-labelledby="chat-history-title">
      <div class="section-heading">
        <h2 id="chat-history-title" tabindex="-1">Task conversations</h2>
        <UButton to="/chat" color="neutral" variant="outline">Open Chat</UButton>
      </div>
      <p class="page-note">
        Find conversations from chat, file tasks and orchestrator assignments. Open one to read its
        transcript or continue after execution finishes. Opening an archived task restores it to
        your task list.
      </p>
      <div class="history-filters history-task-filters">
        <div>
          <label for="chat-history-search">Find a task conversation</label>
          <UInput
            id="chat-history-search"
            v-model="chatSearch"
            icon="i-lucide-search"
            placeholder="Title, task ID or provider"
            class="w-full"
          />
        </div>
        <div>
          <label for="history-task-kind">Task type</label>
          <USelect
            id="history-task-kind"
            v-model="taskKind"
            :items="taskKindOptions"
            class="w-full"
          />
        </div>
        <div>
          <label for="chat-history-state">State</label>
          <USelect
            id="chat-history-state"
            v-model="chatStatus"
            :items="chatStatusOptions"
            class="w-full"
          />
        </div>
        <div>
          <label for="chat-history-archive">Archive</label>
          <USelect
            id="chat-history-archive"
            v-model="chatArchive"
            :items="chatArchiveOptions"
            class="w-full"
          />
        </div>
      </div>
      <p class="page-note" role="status">
        {{ chatTasks.length }} matching
        {{ chatTasks.length === 1 ? 'conversation' : 'conversations' }} · Newest first
      </p>
      <div v-if="!chatTasks.length" class="board-empty">
        <p>
          {{
            allChatTasks.length
              ? 'No conversations match these filters.'
              : 'No saved conversations yet. Start with New task in Chat.'
          }}
        </p>
        <UButton
          v-if="allChatTasks.length"
          color="neutral"
          variant="outline"
          @click="clearChatFilters"
        >
          Show all conversations
        </UButton>
      </div>
      <ul class="chat-task-history">
        <li v-for="task in chatTasks" :key="task.id">
          <div>
            <strong>{{ task.title }}</strong>
            <span class="muted">
              {{ kindLabel(task.kind) }} · {{ task.provider }} · {{ date(task.createdAt)
              }}{{ task.archived ? ' · archived' : '' }}
            </span>
          </div>
          <UBadge
            :color="
              task.status === 'failed' ? 'error' : task.status === 'running' ? 'primary' : 'neutral'
            "
            variant="subtle"
          >
            {{ taskStatus(task.status) }}
          </UBadge>
          <UButton
            color="neutral"
            variant="outline"
            :loading="opening === task.id"
            :disabled="!!opening || state.workspaceBusy"
            :aria-label="(task.archived ? 'Restore and open task ' : 'Open task ') + task.title"
            @click="openChat(task.id)"
          >
            {{ task.archived ? 'Restore and open' : 'Open task' }}
          </UButton>
        </li>
      </ul>
    </section>
    <Taskboard />
    <h2 class="monitor-section">Orchestrator attempt history</h2>
    <UAlert
      v-if="state.history?.limited || state.history?.unreadable"
      title="Some evidence is not shown"
      :description="`${state.history.limited ? 'The view inspected 1,000 snapshot directories. This is a sample, not the full history. ' : ''}${state.history.unreadable ? state.history.unreadable + ' snapshot pairs could not be read. Check the worker journal.' : ''}`"
      color="warning"
      variant="soft"
      class="notice"
    />
    <div v-if="state.history?.rows.length" class="history-filters">
      <div>
        <label for="history-search">Find an orchestrator attempt</label>
        <UInput
          id="history-search"
          v-model="search"
          icon="i-lucide-search"
          placeholder="Title, task ID, project, feature or profile"
          class="w-full"
        />
      </div>
      <div>
        <label for="history-outcome">Outcome</label>
        <USelect id="history-outcome" v-model="filter" :items="options" class="w-full" />
      </div>
    </div>
    <div v-if="!state.unlocked" class="empty-state">
      <UIcon name="i-lucide-lock-keyhole" />
      <h2>Task history is private</h2>
      <p>Unlock this worker to inspect retained attempts and their evidence.</p>
    </div>
    <div v-else-if="!state.history" class="empty-state" role="status">
      <p>Loading task history…</p>
    </div>
    <div v-else-if="!filtered.length" class="compact-empty">
      <UIcon name="i-lucide-history" />
      <h2>{{ state.history.rows.length ? 'No matching attempts' : 'No retained attempts yet' }}</h2>
      <p>
        {{
          state.history.rows.length
            ? 'Try another task ID or show all outcomes.'
            : 'Assigned tasks appear here when the worker records its first snapshot. Retained evidence survives worker restarts.'
        }}
      </p>
      <UButton
        v-if="state.history.rows.length"
        color="neutral"
        variant="outline"
        @click="
          search = '';
          filter = 'all';
        "
      >
        Clear filters
      </UButton>
    </div>
    <template v-else>
      <div
        class="table-scroll history-table"
        tabindex="0"
        role="region"
        aria-label="Task attempt history"
      >
        <table>
          <thead>
            <tr>
              <th>Task / attempt</th>
              <th>Outcome</th>
              <th>Profile</th>
              <th>Started</th>
              <th>Duration</th>
              <th><span class="sr-only">Evidence</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in visible"
              :key="row.pairId"
              :class="{ selected: selectedId === row.pairId }"
            >
              <td>
                <strong class="task-id">
                  {{ row.title || row.provenance.featureId || row.taskId }}
                </strong>
                <span class="muted">Attempt {{ row.attempt }} · {{ row.project }}</span>
              </td>
              <td>
                <UBadge
                  :color="
                    row.outcome === 'failed'
                      ? 'error'
                      : row.outcome === 'simulated'
                        ? 'warning'
                        : 'neutral'
                  "
                  variant="subtle"
                >
                  {{ outcome(row.outcome) }}
                </UBadge>
              </td>
              <td>
                {{ row.profile }}
                <span class="muted">{{ row.mode === 'mock' ? 'Simulation' : 'Live Codex' }}</span>
              </td>
              <td>{{ date(row.startedAt) }}</td>
              <td class="numeric">{{ duration(row.durationMs) }}</td>
              <td>
                <UButton
                  color="neutral"
                  variant="outline"
                  :aria-label="`Inspect task ${row.taskId}, attempt ${row.attempt}`"
                  :aria-expanded="selectedId === row.pairId"
                  :data-attempt="row.pairId"
                  aria-controls="attempt-evidence"
                  @click="inspect(row.pairId, $event)"
                >
                  Inspect
                </UButton>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="mobile-attempts">
        <article v-for="row in visible" :key="row.pairId" class="mobile-attempt">
          <strong>{{ row.title || row.provenance.featureId || row.taskId }}</strong>
          <p>
            Attempt {{ row.attempt }} · {{ row.profile }}
            <br />
            {{ date(row.startedAt) }} · {{ duration(row.durationMs) }}
          </p>
          <div class="actions">
            <UBadge
              :color="
                row.outcome === 'failed'
                  ? 'error'
                  : row.outcome === 'simulated'
                    ? 'warning'
                    : 'neutral'
              "
              variant="subtle"
            >
              {{ outcome(row.outcome) }}
            </UBadge>
            <UButton
              color="neutral"
              variant="outline"
              :aria-label="`Inspect task ${row.taskId}, attempt ${row.attempt}`"
              :aria-expanded="selectedId === row.pairId"
              :data-attempt="row.pairId"
              aria-controls="attempt-evidence"
              @click="inspect(row.pairId, $event)"
            >
              Inspect
            </UButton>
          </div>
        </article>
      </div>
      <div class="pagination">
        <span>
          {{ filtered.length }} matching {{ filtered.length === 1 ? 'attempt' : 'attempts' }} · Page
          {{ page }} of {{ pages }}
        </span>
        <div class="actions">
          <UButton color="neutral" variant="outline" :disabled="page === 1" @click="page--">
            Previous
          </UButton>
          <UButton color="neutral" variant="outline" :disabled="page >= pages" @click="page++">
            Next
          </UButton>
        </div>
      </div>
    </template>
    <section
      v-if="selected"
      id="attempt-evidence"
      class="evidence-panel"
      aria-labelledby="evidence-title"
    >
      <div class="section-heading">
        <h2 id="evidence-title" tabindex="-1">Attempt {{ selected.attempt }} evidence</h2>
        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-x"
          aria-label="Close attempt evidence"
          @click="closeEvidence()"
        />
      </div>
      <p class="break-anywhere">{{ selected.taskId }}</p>
      <div class="evidence-flow">
        <div>
          <UIcon name="i-lucide-file-input" />
          <strong>Before execution</strong>
          <span>{{ date(selected.startedAt) }}</span>
        </div>
        <UIcon name="i-lucide-arrow-right" class="flow-arrow" />
        <div>
          <UIcon name="i-lucide-cpu" />
          <strong>{{ outcome(selected.outcome) }}</strong>
          <span>{{ duration(selected.durationMs) }}</span>
        </div>
        <UIcon name="i-lucide-arrow-right" class="flow-arrow" />
        <div>
          <UIcon name="i-lucide-file-check" />
          <strong>{{ selected.completePair ? 'Pair recorded' : 'Pair incomplete' }}</strong>
          <span>{{ date(selected.finishedAt) }}</span>
        </div>
      </div>
      <p v-if="selected.error" class="error-text">{{ selected.error }}</p>
      <dl class="facts">
        <div>
          <dt>Worker-process RSS at snapshot</dt>
          <dd>{{ bytes(selected.resources.rssBytes) }}</dd>
        </div>
        <div>
          <dt>Quality gate</dt>
          <dd>{{ selected.quality.gate.replaceAll('_', ' ') }}</dd>
        </div>
        <div>
          <dt>Provider usage</dt>
          <dd>{{ selected.usage.reason }}</dd>
        </div>
        <div v-if="selected.review">
          <dt>Review artifact</dt>
          <dd>{{ selected.review.artifactPath }}</dd>
        </div>
      </dl>
      <p v-if="selected.mode === 'mock'" class="page-note">
        This attempt was simulated. It does not represent implemented code or a completed PR.
      </p>
      <details>
        <summary>Full recorded evidence</summary>
        <pre>{{ JSON.stringify(selected, null, 2) }}</pre>
      </details>
    </section>
    <p v-else-if="selectedId" class="page-note" role="status">
      The selected attempt is no longer in the retained history.
    </p>
    <p v-if="state.history?.rows.length" class="page-note">
      Orchestrator history is local to this worker and follows its journal retention policy ({{
        state.history?.retainedPairs ?? '…'
      }}
      acknowledged pairs). Older attempts may have been pruned. Snapshot measurements describe the
      worker process. This worker executes one task at a time.
    </p>
    </div>
  </section>
</template>
