<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import RequestGatePanel from "./RequestGatePanel.vue";
import CandidateEvidence from "./CandidateEvidence.vue";
import MessageContent from "./MessageContent.vue";
import PatchReview from "./PatchReview.vue";
import TaskKanban from "../../../shared/webview/components/TaskKanban.vue";
import { useTaskboard } from "./useTaskboard";
const {
  action,
  actionError,
  allTasks,
  archived,
  beginRemoval,
  busy,
  clearFilters,
  canRetry,
  canManage,
  closeDetail,
  columns,
  date,
  detail,
  detailError,
  detailLoading,
  dismissPreparation,
  inspect,
  kanbanTasks,
  openConversation,
  preparations,
  readDetail,
  removeWorktree,
  removing,
  search,
  selectedId,
  state,
  status,
  statusOptions,
  visible,
  workspaceAction,
  worktreeNotice,
} = useTaskboard();
</script>
<template>
  <section
    v-if="state.unlocked"
    class="taskboard"
    aria-labelledby="taskboard-title"
  >
    <div class="section-heading">
      <div>
        <h2 id="taskboard-title" tabindex="-1">File tasks</h2>
        <p class="page-note">
          Requests with permission to change approved repository files. Each request keeps a Markdown
          record of its progress and results.
        </p>
      </div>
      <UButton
        color="neutral"
        variant="outline"
        :icon="
          state.settings?.board.paused ? 'i-lucide-play' : 'i-lucide-pause'
        "
        :disabled="busy"
        @click="
          workspaceAction('/api/settings', {
            board: { paused: !state.settings?.board.paused },
          })
        "
      >
        {{ state.settings?.board.paused ? "Resume queue" : "Pause queue" }}
      </UButton>
    </div>
    <p v-if="state.board?.persistenceError" role="alert" class="error-text">
      A task result could not be saved. Check free disk space and
      state-directory permissions before restarting.
    </p>
    <p v-if="worktreeNotice" role="status" class="notice">{{ worktreeNotice }}</p>
    <ul v-if="preparations.length" class="file-task-preparations" aria-label="File tasks being prepared">
      <li v-for="item in preparations" :key="item.id">
        <strong>{{ item.title }}</strong>
        <span v-if="item.state === 'preparing'" role="status" class="muted">
          {{ item.phase === "waiting" ? "Waiting for an earlier task to be admitted…" : item.phase === "worktree" ? "Preparing its Git worktree…" : "Saving approved file snapshots…" }}
        </span>
        <template v-else>
          <span role="alert" class="error-text">Not created: {{ item.error }}</span>
          <UButton color="neutral" variant="ghost" size="xs" :disabled="busy" @click="dismissPreparation(item.id)">Dismiss</UButton>
        </template>
      </li>
    </ul>
    <div v-if="state.settings?.board.paused" class="notice">
      Queue paused. The running task can finish; queued chat, file tasks and
      orchestrator assignments wait.
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
        <USelect
          id="file-task-status"
          v-model="status"
          :items="statusOptions"
          class="w-full"
        />
      </div>
    </div>
    <p v-if="allTasks.length" class="page-note" role="status">
      {{ visible.length }} matching
      {{ visible.length === 1 ? "file task" : "file tasks" }}
    </p>
    <div v-if="!allTasks.length" class="compact-empty">
      <p>
        No file changes requested yet. Choose New request on the taskboard, then open Repository files
        to allow changes and receive a patch for review.
      </p>
      <UButton to="/taskboard" color="neutral" variant="outline">Open taskboard</UButton>
    </div>
    <div v-else-if="!visible.length" class="compact-empty">
      <p>No file tasks match these filters.</p>
      <UButton color="neutral" variant="outline" @click="clearFilters"
        >Show all file tasks</UButton
      >
    </div>
    <TaskKanban
      v-else
      :tasks="kanbanTasks"
      :columns="columns"
      scope-label="Worker file tasks"
      @open="(task) => inspect(task.id)"
    />
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
        <h3 id="local-task-detail" tabindex="-1">
          {{ detail?.title ?? "File task evidence" }}
        </h3>
        <UButton
          color="neutral"
          variant="ghost"
          aria-label="Close local task"
          class="min-w-11 min-h-11"
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
      <p v-if="actionError" role="alert" class="error-text">
        {{ actionError }}
      </p>
      <template v-if="detail">
        <p>
          {{ detail.status }} · {{ date(detail.createdAt) }} ·
          {{ detail.provider }}
        </p>
        <UButton :to="{ path: '/review', query: { session: detail.sessionId, fileId: detail.id } }" icon="i-lucide-git-pull-request">Open Feature Request review</UButton>
        <details class="accepted-instructions"><summary>Accepted instructions</summary><MessageContent :text="detail.instruction" /></details>

        <p v-if="detail.error" class="error-text">{{ detail.error }}</p>
        <div v-if="detail.admissionFailure" class="notice" role="status">
          <p>This request stopped before approved file snapshots were saved. Inspect the preserved worktree, then use New request on the taskboard to continue.</p>
          <p v-if="detail.worktree" class="break-anywhere">Preserved worktree: <code>{{ detail.worktree }}</code></p>
        </div>
        <MessageContent v-if="detail.summary" :text="detail.summary" />
        <CandidateEvidence v-if="!detail.admissionFailure" :key="detail.id" :task="detail" />
        <PatchReview v-if="detail.patch" :patch="detail.patch" :task-id="detail.id" />
        <RequestGatePanel
          v-if="detail.requestId && !detail.admissionFailure"
          :request-id="detail.requestId"
          :session-id="detail.sessionId"
          :feature-source="detail.feature?.source"
        />
        <p class="break-anywhere">{{ detail.repository }}</p>
        <ul>
          <li v-for="file in detail.files" :key="file.path" class="break-anywhere">{{ file.path }}</li>
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
            {{
              detail.status === "queued" ? "Cancel queued task" : "Stop task"
            }}
          </UButton>
          <UButton
            v-if="detail.status === 'queued'"
            color="neutral"
            variant="outline"
            :disabled="busy"
            @click="
              action({
                id: detail.id,
                action: 'priority',
                priority: detail.priority === 2 ? 1 : 2,
              })
            "
          >
            {{ detail.priority === 2 ? "Normal priority" : "Raise priority" }}
          </UButton>
          <UButton
            v-if="canRetry"
            :disabled="busy"
            @click="action({ id: detail.id, action: 'retry' })"
          >
            Retry saved input
          </UButton>
          <template v-if="canManage">
            <UButton
              color="neutral"
              variant="outline"
              :disabled="busy"
              @click="
                action({
                  id: detail.id,
                  action: detail.archived ? 'restore' : 'archive',
                })
              "
            >
              {{ detail.archived ? "Restore" : "Archive" }}
            </UButton>
            <UButton color="error" variant="ghost" @click="removing ? removing = false : beginRemoval()"
              >Delete</UButton
            >
          </template>
        </div>
        <div v-if="removing" class="confirm-row">
          <p>Delete the saved task and its board evidence?</p>
          <label v-if="detail.worktree" class="check-label">
            <input v-model="removeWorktree" type="checkbox" />
            Also remove its Git worktree. Deletion stops if it has changes or cannot be safely removed.
          </label>
          <UButton
            color="error"
            :disabled="busy"
            @click="action({ id: detail.id, action: 'delete', ...(detail.worktree ? { removeWorktree } : {}) })"
          >
            Confirm deletion
          </UButton>
          <UButton
            color="neutral"
            variant="ghost"
            :disabled="busy"
            @click="removing = false"
          >
            Keep task
          </UButton>
        </div>
        <p v-if="detail.patch" class="page-note">
          Inspect this patch before applying it. <template v-if="!detail.implementation">This proposal has not been automatically applied or verified.</template> In your
          repository, use
          <code>git apply --check path/to/download.patch</code>
          before applying with
          <code>git apply</code>. Inputs were captured when this task was
          queued.
        </p>

      </template>
    </section>
    <p class="page-note">Queue capacity and task duration are managed in <RouterLink to="/settings#queue">Settings</RouterLink>.</p>
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
    <p v-if="state.actionError" role="alert" class="error-text">
      {{ state.actionError }}
    </p>
  </section>
</template>
