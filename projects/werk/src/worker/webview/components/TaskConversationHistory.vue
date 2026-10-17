<script setup lang="ts">
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import USelect from '@nuxt/ui/components/Select.vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import { useTaskConversationHistory } from './useTaskConversationHistory';
const {
  allChatTasks,
  chatArchive,
  chatArchiveOptions,
  chatSearch,
  chatStatus,
  chatStatusOptions,
  chatTasks,
  clearChatFilters,
  date,
  kindLabel,
  openChat,
  opening,
  state,
  taskKind,
  taskKindOptions,
  taskStatus,
} = useTaskConversationHistory();
</script>
<template>
    <section v-if="state.unlocked" class="monitor-section" aria-labelledby="chat-history-title">
      <div class="section-heading">
        <h2 id="chat-history-title" tabindex="-1">Task conversations</h2>
        <UButton to="/taskboard" color="neutral" variant="outline">Open taskboard</UButton>
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
              : 'No saved conversations yet. Start with New task on the Taskboard.'
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
</template>
