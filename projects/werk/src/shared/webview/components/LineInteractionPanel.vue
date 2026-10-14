<script setup lang="ts">
import { onUnmounted, watch } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import UTextarea from "@nuxt/ui/components/Textarea.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import UModal from "@nuxt/ui/components/Modal.vue";
import {
  createLineInteraction,
  type InteractionRequest,
  type InteractionTask,
} from "../line-interaction";
const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    project?: string;
    canWrite: boolean;
    request: InteractionRequest;
    submit: (task: InteractionTask, key: string) => Promise<any>;
  }>(),
  { project: "" },
);
const emit = defineEmits<{ "update:open": [value: boolean] }>();
const interaction = createLineInteraction(
    (body) => props.request(body),
    (task, key) => props.submit(task, key),
    () => props.canWrite,
    props.project,
  ),
  s = interaction.state;
let timer: ReturnType<typeof setInterval> | undefined;
watch(
  () => props.open,
  (value) => {
    clearInterval(timer);
    if (value)
      timer = setInterval(() => {
        if (!document.hidden) void interaction.perform("read", true);
      }, 3000);
    else interaction.reset(true);
  },
  { immediate: true },
);
onUnmounted(() => {
  clearInterval(timer);
  interaction.reset(true);
});
const providers = [
    { label: "Automatic", value: "auto" },
    { label: "Codex", value: "codex" },
    { label: "Claude", value: "claude" },
  ],
  modes = [
    { label: "Simulation", value: "mock" },
    { label: "Live Codex · review required", value: "cli" },
  ];
</script>
<template>
  <UModal
    :open="open"
    :title="title"
    description="Worker task sessions and explicit line submission"
    :ui="{ content: 'max-w-3xl' }"
    @update:open="emit('update:open', $event)"
  >
    <template #body>
      <div class="actions">
        <UButton
          :variant="s.tab === 'chat' ? 'solid' : 'outline'"
          @click="s.tab = 'chat'"
          >Chat</UButton
        ><UButton
          :variant="s.tab === 'task' ? 'solid' : 'outline'"
          @click="s.tab = 'task'"
          >Submit task</UButton
        >
      </div>
      <section v-if="s.tab === 'chat'" class="interaction-chat">
        <p>
          The first message queues a worker task. Follow-ups continue the same
          task session. One LLM request runs at a time.
        </p>
        <form
          v-if="!s.connection"
          class="operation-form"
          @submit.prevent="interaction.connect"
        >
          <label for="interaction-worker-url">Worker webview address</label
          ><UInput
            id="interaction-worker-url"
            v-model="s.workerUrl"
            type="url"
            required
            placeholder="http://127.0.0.1:4100"
            :disabled="s.busy"
          />
          <label for="interaction-worker-token">Worker access token</label
          ><UInput
            id="interaction-worker-token"
            v-model="s.credential"
            type="password"
            autocomplete="off"
            required
            :disabled="s.busy"
          />
          <p>
            Use a worker registered with this line. Access stays in this panel’s
            memory. Its selected session is shared with the worker webview.
          </p>
          <UButton type="submit" :loading="s.busy"
            >Connect model session</UButton
          >
        </form>
        <template v-else>
          <h3>{{ interaction.title.value }}</h3>
          <p role="status">
            {{
              interaction.phase.value === "queued"
                ? "Queued · waiting for the worker’s current request."
                : interaction.phase.value === "running"
                  ? "Running · the worker is prompting the LLM."
                  : interaction.phase.value === "failed"
                    ? "The last reply failed. Inspect it before following up."
                    : interaction.phase.value === "cancelled"
                      ? "Reply stopped. You can continue this task."
                      : interaction.phase.value === "waiting_input"
                        ? "The worker needs input. Open its webview to answer with its current revision."
                        : interaction.phase.value === "escalated"
                          ? "The worker needs an operator decision. Open its webview to inspect the escalation."
                          : "Ready for a message in this task session."
            }}
          </p>
          <div class="interaction-transcript" aria-label="Task conversation">
            <article
              v-for="(message, index) in s.chat?.messages ?? []"
              :key="message.id ?? index"
            >
              <strong>{{ message.role === "user" ? "You" : "Model" }}</strong>
              <p>{{ message.text || "Reply in progress…" }}</p>
            </article>
            <p v-if="!s.chat?.messages.length">
              Describe the task in your first message.
            </p>
          </div>
          <form
            class="operation-form"
            @submit.prevent="interaction.perform('send')"
          >
            <label for="interaction-message">Message to the model</label
            ><UTextarea
              id="interaction-message"
              v-model="s.draft"
              :maxlength="8000"
              required
              :disabled="s.busy || !canWrite"
            />
            <div class="actions">
              <UButton
                type="submit"
                :disabled="!interaction.canSend.value"
                :loading="s.busy"
                >{{
                  s.chat?.messages.some((m) => m.role === "user")
                    ? "Send follow-up"
                    : "Queue task"
                }}</UButton
              ><UButton
                color="neutral"
                variant="outline"
                :disabled="s.busy || !canWrite || !s.chat?.busy"
                @click="interaction.perform('cancel')"
                >Stop reply</UButton
              ><UButton
                color="neutral"
                variant="outline"
                :disabled="s.busy || s.reading"
                @click="interaction.perform('read')"
                >Refresh conversation</UButton
              ><UButton
                color="neutral"
                variant="outline"
                :disabled="s.busy || !canWrite"
                @click="interaction.perform('new')"
                >New task</UButton
              ><UButton
                color="neutral"
                variant="ghost"
                @click="interaction.reset()"
                >Change worker / reconnect</UButton
              >
            </div>
          </form>
        </template>
        <p role="status" class="message">{{ s.message }}</p>
      </section>
      <form
        v-else
        class="operation-form"
        @submit.prevent="interaction.submitTask"
      >
        <fieldset :disabled="s.submitting || !canWrite">
          <label for="interaction-project">Project</label
          ><UInput
            id="interaction-project"
            v-model="s.input.project"
            required
          />
          <label for="interaction-reference">Requirement link (optional)</label
          ><UInput
            id="interaction-reference"
            v-model="s.input.reference"
            placeholder="[[requirements/my-feature]]"
          />
          <label for="interaction-title">Task title</label
          ><UInput
            id="interaction-title"
            v-model="s.input.title"
            :required="!s.input.reference.trim()"
            :maxlength="200"
          />
          <label for="interaction-criteria"
            >Acceptance criteria · one per line</label
          ><UTextarea
            id="interaction-criteria"
            v-model="s.input.criteria"
            :required="!s.input.reference.trim()"
            :maxlength="12000"
          />
          <label for="interaction-provider">Provider</label
          ><USelect
            id="interaction-provider"
            v-model="s.input.provider"
            :items="providers"
          />
          <label for="interaction-mode">Execution</label
          ><USelect
            id="interaction-mode"
            v-model="s.input.mode"
            :items="modes"
          />
          <p>
            A saved task enters the configured router. Live work requires a
            compatible Codex worker and pinned context; results require review.
          </p>
          <UButton type="submit" :loading="s.submitting"
            >Submit task to this line</UButton
          >
        </fieldset>
        <p role="status">{{ s.taskMessage }}</p>
      </form>
    </template>
  </UModal>
</template>
