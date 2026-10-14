<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import type { KanbanTask, KanbanColumn } from "../task-kanban";
import { groupKanbanTasks, kanbanTaskKey } from "../task-kanban";
const props = withDefaults(
  defineProps<{
    tasks: KanbanTask[];
    columns: KanbanColumn[];
    scopeLabel: string;
    loading?: boolean;
    emptyText?: string;
    selectable?: boolean;
    statusLabels?: Record<string, string>;
    copy?: Partial<{
      emptyColumn: string;
      refreshing: string;
      unknownGate: string;
      priority: string;
      other: string;
      scrollHint: string;
      jump: string;
      loadedTasks: string;
    }>;
  }>(),
  {
    loading: false,
    emptyText: "No loaded tasks in this scope.",
    selectable: true,
  },
);
const text = computed(() => ({
  emptyColumn: "No loaded tasks in this state.",
  refreshing: "Refreshing loaded tasks…",
  unknownGate: "Request not evaluated",
  priority: "Priority",
  other: "Other states",
  scrollHint: "Scroll across the board or choose a status column.",
  jump: "Jump to status column",
  loadedTasks: "loaded tasks",
  ...props.copy,
}));
const board = ref<HTMLElement | null>(null);
let positioned = false,
  userScrolled = false;
function markScroll() {
  userScrolled = true;
}
function jump(id: string, focus = true) {
  const target = board.value?.querySelector<HTMLElement>(
    '[data-kanban-column="' + CSS.escape(id) + '"]',
  );
  if (!target || !board.value) return;
  board.value.scrollTo({
    left: target.offsetLeft,
    behavior:
      focus && !matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "smooth"
        : "auto",
  });
  if (focus)
    target.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
}
async function initialPosition() {
  await nextTick();
  if (positioned || userScrolled || !matchMedia("(max-width:760px)").matches)
    return;
  const first = groups.value.find((column) => column.tasks.length);
  if (first) {
    positioned = true;
    jump(first.id, false);
  }
}
onMounted(() => {
  void initialPosition();
});
watch(
  () => props.tasks,
  () => {
    void initialPosition();
  },
);
watch(
  () => props.scopeLabel,
  () => {
    positioned = false;
    userScrolled = false;
    void initialPosition();
  },
);
const emit = defineEmits<{ open: [task: KanbanTask] }>();
const groups = computed(() => groupKanbanTasks(props.tasks, props.columns));
const count = computed(() =>
  groups.value.reduce((total, column) => total + column.tasks.length, 0),
);
const sourceIdentity = (task: KanbanTask) =>
  task.sourceLabel
    ? task.sourceLabel + (task.sourceId ? " (" + task.sourceId + ")" : "")
    : (task.sourceId ?? "");
const statusLabel = (task: KanbanTask) =>
  props.statusLabels?.[task.status] ?? task.status.replaceAll("_", " ");
const gateLabel = (task: KanbanTask) =>
  task.gate?.label ??
  (!task.gate || task.gate.phase === "not_evaluated"
    ? text.value.unknownGate
    : "Request · " + task.gate.phase.replaceAll("_", " "));
</script>
<template>
  <section
    class="task-kanban-scope"
    :aria-label="scopeLabel"
    :aria-busy="loading"
  >
    <p v-if="!count && !loading" class="task-kanban-empty" role="status">
      {{ emptyText }}
    </p>
    <p v-if="loading" class="task-kanban-empty" role="status">
      {{ text.refreshing }}
    </p>
    <div
      v-if="groups.length"
      class="task-kanban-jumps"
      role="group"
      :aria-label="text.jump"
    >
      <UButton
        v-for="column in groups"
        :key="column.id"
        color="neutral"
        variant="outline"
        size="sm"
        @click="jump(column.id)"
        >{{ column.id === "__unmapped__" ? text.other : column.label }} ·
        {{ column.tasks.length }}</UButton
      >
    </div>
    <p v-if="groups.length > 1" class="task-kanban-hint">
      {{ text.scrollHint }}
    </p>
    <div
      ref="board"
      class="task-kanban"
      @scroll="markScroll"
      tabindex="0"
      role="region"
      :aria-label="scopeLabel + ' · ' + text.scrollHint"
    >
      <div class="task-kanban-columns">
        <section
          v-for="column in groups"
          :key="column.id"
          class="task-kanban-column"
          :aria-label="column.id === '__unmapped__' ? text.other : column.label"
          :data-kanban-column="column.id"
        >
          <header class="task-kanban-column-heading">
            <h3 tabindex="-1">
              {{ column.id === "__unmapped__" ? text.other : column.label }}
            </h3>
            <UBadge
              color="neutral"
              variant="subtle"
              :aria-label="column.tasks.length + ' ' + text.loadedTasks"
              >{{ column.tasks.length }}</UBadge
            >
          </header>
          <ul class="task-kanban-list">
            <li
              v-for="task in column.tasks"
              :key="kanbanTaskKey(task)"
              class="task-kanban-card"
            >
              <component
                :is="selectable ? UButton : 'div'"
                :class="
                  selectable ? 'task-kanban-open' : 'task-kanban-readonly'
                "
                v-bind="
                  selectable
                    ? {
                        color: 'neutral',
                        variant: 'outline',
                        disabled: loading,
                      }
                    : {}
                "
                :data-task-id="selectable ? task.id : undefined"
                :data-source-id="selectable ? task.sourceId : undefined"
                @click="selectable && emit('open', task)"
              >
                <span class="task-kanban-copy"
                  ><small
                    v-if="
                      task.sourceLabel || task.sourceId || task.contextLabel
                    "
                    >{{ sourceIdentity(task)
                    }}{{
                      (task.sourceLabel || task.sourceId) && task.contextLabel
                        ? " · "
                        : ""
                    }}{{ task.contextLabel }}</small
                  ><strong>{{ task.title }}</strong
                  ><span class="task-kanban-id">{{ task.id }}</span
                  ><span class="task-kanban-metadata"
                    ><UBadge color="neutral" variant="subtle">{{
                      statusLabel(task)
                    }}</UBadge
                    ><UBadge
                      :color="
                        task.gate?.phase === 'done' ? 'success' : 'warning'
                      "
                      variant="subtle"
                      >{{ gateLabel(task) }}</UBadge
                    ></span
                  ><span
                    v-if="task.project || task.workerLabel"
                    class="task-kanban-context"
                    >{{ task.project
                    }}{{ task.project && task.workerLabel ? " · " : ""
                    }}{{ task.workerLabel }}</span
                  ><span
                    v-if="task.priority !== undefined"
                    class="task-kanban-context"
                    >{{ text.priority }} · {{ task.priority }}</span
                  ><slot name="details" :task="task"
                /></span>
              </component>
              <div v-if="$slots.actions" class="task-kanban-actions">
                <slot name="actions" :task="task" />
              </div>
            </li>
          </ul>
          <p v-if="!column.tasks.length" class="task-kanban-column-empty">
            {{ text.emptyColumn }}
          </p>
          <slot name="column-footer" :column="column" :tasks="column.tasks" />
        </section>
      </div>
    </div>
  </section>
</template>
<style scoped>
.task-kanban-scope {
  min-width: 0;
  max-width: 100%;
}
.task-kanban-empty {
  margin: 0 0 16px;
  color: var(--muted, #b5c4cd);
  line-height: 1.6;
}
.task-kanban {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  overflow-x: auto;
  padding-bottom: 16px;
  scrollbar-color: #667a88 #111b22;
}
.task-kanban-columns {
  position: relative;
  display: flex;
  gap: 16px;
  align-items: flex-start;
  min-width: min-content;
}
.task-kanban-column {
  flex: 1 0 250px;
  width: 250px;
  min-width: 250px;
  max-width: 360px;
  min-height: 160px;
}
.task-kanban-column-heading {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--line, #3b4b56);
  padding-block: 12px;
  margin-bottom: 16px;
}
.task-kanban-column-heading h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text, #edf4f7);
}
.task-kanban-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 12px;
}
.task-kanban-card {
  min-width: 0;
  display: grid;
  gap: 8px;
}
.task-kanban-open {
  width: 100%;
  min-height: 44px;
  text-align: left;
  justify-content: flex-start;
  align-items: flex-start;
  white-space: normal;
  padding: 16px;
}
.task-kanban-copy {
  display: grid;
  gap: 10px;
  min-width: 0;
  width: 100%;
}
.task-kanban-copy strong,
.task-kanban-readonly strong {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.task-kanban-copy small,
.task-kanban-context,
.task-kanban-id {
  color: var(--muted, #b5c4cd);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.task-kanban-metadata {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  max-width: 100%;
}
.task-kanban-metadata :deep(span) {
  white-space: normal;
  overflow-wrap: anywhere;
  max-width: 100%;
  text-align: left;
}
.task-kanban-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding-inline: 8px;
}
.task-kanban-readonly {
  display: grid;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--line, #3b4b56);
  border-radius: 12px;
}
.task-kanban-column-empty {
  font-size: 13px;
  color: var(--muted, #b5c4cd);
  padding-block: 12px;
  margin: 0;
}
</style>

<style scoped>
.task-kanban-jumps {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.task-kanban-hint {
  font-size: 13px;
  line-height: 1.5;
  color: var(--muted, #b5c4cd);
  margin: 0 0 16px;
}
.task-kanban-column-heading h3:focus {
  outline: 2px solid var(--primary, #8be0b8);
  outline-offset: 4px;
}
</style>
