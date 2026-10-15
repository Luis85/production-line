<script setup lang="ts">
import { computed, watch } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import UTextarea from "@nuxt/ui/components/Textarea.vue";
import UCheckbox from "@nuxt/ui/components/Checkbox.vue";
import {
  handoff,
  emptySelection,
  selectionValue,
  selectionInput,
  type FactoryStore,
} from "../store";
const props = defineProps<{ store: FactoryStore }>(),
  s = props.store.state;
const factories = computed(() =>
    s.factories.map((f) => ({
      label: props.store.factoryPath(f.id),
      value: f.id,
    })),
  ),
  lines = computed(() => [
    { label: "Factory-Routing verwenden", value: emptySelection },
    ...s.lines
      .filter((l) => props.store.descendants(s.intakeFactory).has(l.factoryId))
      .map((l) => ({ label: l.name, value: l.id })),
  ]);
watch(
  () => s.intakeFactory,
  () => props.store.loadPolicy(),
);
watch(
  () => s.taskDraft.execution,
  (value) => {
    if (value === "cli") s.taskDraft.provider = "codex";
  },
  { immediate: true },
);
const providers = [
    { label: "Automatisch", value: "auto" },
    { label: "Codex", value: "codex" },
    { label: "Claude", value: "claude" },
  ],
  modes = [
    { label: "Simulation", value: "mock" },
    { label: "Live Codex · Review erforderlich", value: "cli" },
  ];
</script>
<template>
  <details
    id="factory-intake"
    class="factory-intake"
    :open="s.intakeOpen"
    @toggle="s.intakeOpen = ($event.target as HTMLDetailsElement).open"
  >
    <summary>Factory-Intake & Auftragsrouter</summary>
    <p>
      Aufträge bleiben hier gespeichert, bis eine passende Produktionslinie sie
      bestätigt. Fehlende Kapazität oder Verbindungen lassen Arbeit sichtbar
      warten.
    </p>
    <form
      class="operation-form factory-task-form"
      @submit.prevent="store.submitIntake"
    >
      <fieldset :disabled="s.intakeBusy || !s.canWrite">
        <label for="intake-factory">Factory</label
        ><USelect
          id="intake-factory"
          v-model="s.intakeFactory"
          :items="factories"
          :disabled="s.policyBusy"
          required
        />
        <label for="intake-line">Ziel-Produktionslinie</label
        ><USelect
          id="intake-line"
          :model-value="selectionValue(s.taskDraft.lineId)"
          @update:model-value="s.taskDraft.lineId = selectionInput($event)"
          :items="lines"
        />
        <label for="factory-task-project">Projekt</label
        ><UInput
          id="factory-task-project"
          v-model="s.taskDraft.project"
          pattern="[a-zA-Z0-9_\-]{1,100}"
          :maxlength="100"
          required
        />
        <label for="factory-task-repository">Repository-Zuweisung (optional)</label
        ><UInput
          id="factory-task-repository"
          v-model="s.taskDraft.repository"
          pattern="[a-zA-Z0-9_\-]{1,100}"
          :maxlength="100"
          aria-describedby="factory-repository-hint"
          placeholder="z. B. portal-ui"
        />
        <p id="factory-repository-hint" class="muted">
          Zuweisungs-ID aus dem Worker-Dashboard, kein Pfad oder Git-URL.
          Leer nutzt die Projekt-ID. Das Projekt bestimmt weiterhin die passende Linie.
        </p>
        <label for="factory-task-reference"
          >Requirement-Verweis (optional)</label
        ><UInput
          id="factory-task-reference"
          v-model="s.taskDraft.reference"
          placeholder="[[requirements/my-feature]]"
        />
        <label for="factory-task-title">Titel</label
        ><UInput
          id="factory-task-title"
          v-model="s.taskDraft.title"
          :required="!s.taskDraft.reference.trim()"
          :maxlength="200"
        />
        <label for="factory-task-criteria"
          >Akzeptanzkriterien · eine pro Zeile</label
        ><UTextarea
          id="factory-task-criteria"
          v-model="s.taskDraft.criteria"
          :required="!s.taskDraft.reference.trim()"
          :maxlength="12000"
        />
        <div class="form-row">
          <div>
            <label for="factory-task-provider">Provider</label
            ><USelect
              id="factory-task-provider"
              v-model="s.taskDraft.provider"
              :items="providers"
              :disabled="s.taskDraft.execution === 'cli'"
            />
          </div>
          <div>
            <label for="factory-task-execution">Ausführung</label
            ><USelect
              id="factory-task-execution"
              v-model="s.taskDraft.execution"
              :items="modes"
            />
          </div>
        </div>
        <p v-if="s.taskDraft.execution === 'cli'" class="muted">
          Live-Aufträge verwenden Codex und brauchen einen passenden Worker.
          Lokale Änderungen bleiben zum menschlichen Review; kein automatischer Push oder Merge.
        </p>
        <UButton
          type="submit"
          :loading="s.intakeBusy"
          :disabled="!s.intakeFactory"
          >Auftrag im Factory-Intake speichern</UButton
        >
      </fieldset>
      <p role="status" class="message">{{ s.intakeMessage }}</p>
    </form>
    <details class="routing-form">
      <summary>Routing-Methode konfigurieren</summary>
      <form class="operation-form" @submit.prevent="store.savePolicy">
        <fieldset :disabled="s.policyBusy || s.policyLoading || !s.canWrite">
          <label for="factory-routing-mode">Methode</label
          ><USelect
            id="factory-routing-mode"
            v-model="s.policy.mode"
            :items="[
              {
                label: 'Automatisch · Fähigkeiten und Kapazität',
                value: 'auto',
              },
              { label: 'Manuell · ausgewählte Linie', value: 'manual' },
            ]"
            @update:model-value="store.editPolicy"
          />
          <label for="factory-routing-line">Manuelles Standardziel</label
          ><USelect
            id="factory-routing-line"
            :model-value="selectionValue(s.policy.lineId)"
            :items="lines"
            :disabled="s.policy.mode === 'auto'"
            @update:model-value="
              s.policy.lineId = selectionInput($event) || null;
              store.editPolicy();
            "
          />
          <UCheckbox
            v-model="s.policy.paused"
            label="Neue Lieferungen pausieren"
            @update:model-value="store.editPolicy"
          /><UButton
            type="submit"
            :loading="s.policyBusy"
            :disabled="!s.intakeFactory"
            >Factory-Routing speichern</UButton
          >
        </fieldset>
        <p v-if="s.policyLoading" role="status">Routing wird geladen…</p>
        <p v-if="s.policyError" role="alert" class="error-text">
          {{ s.policyError }}
        </p>
      </form>
    </details>
    <section class="intake-queue" aria-labelledby="queue-title">
      <h3 id="queue-title">Factory-Aufträge</h3>
      <p v-if="s.queue">
        {{ s.queue.queued }} wartet · {{ s.queue.delivering }} in Übergabe ·
        {{ s.queue.delivered }} bestätigt. Neueste
        {{ s.queue.tasks.length }} von {{ s.queue.total }}.
      </p>
      <p v-if="s.queueError" role="alert" class="error-text">
        {{ s.queueError }} · Angezeigte Aufträge können veraltet sein.
      </p>
      <article
        v-for="item in s.queue?.tasks ?? []"
        :key="item.id"
        class="intake-task"
      >
        <strong>{{ item.task.title || item.id }}</strong>
        <p>
          {{
            {
              queued: "Wartet",
              delivering: "In Übergabe",
              delivered: "Bestätigt",
            }[item.status as "queued"] || item.status
          }}
          · {{ item.reason }}
        </p>
        <small
          >{{ item.task.project }} ·
          {{ item.destination?.name || "Ziel noch offen" }}</small
        >
        <p v-if="item.task.repository" class="muted">
          Repository-Zuweisung: {{ item.task.repository }}
        </p>
        <UButton
          v-if="
            item.remoteTaskId &&
            item.destination &&
            handoff(
              item.destination.webviewUrl,
              'tasks?task=' + encodeURIComponent(item.remoteTaskId),
            )
          "
          :href="
            handoff(
              item.destination.webviewUrl,
              'tasks?task=' + encodeURIComponent(item.remoteTaskId),
            )
          "
          target="_blank"
          rel="noopener noreferrer"
          color="neutral"
          variant="outline"
          >Linienauftrag öffnen</UButton
        >
        <div
          v-if="item.status === 'queued' && !item.destination && s.canWrite"
          class="actions"
        >
          <USelect
            :model-value="
              selectionValue(s.queueTargets.get(item.id) ?? item.lineId)
            "
            :items="[
              { label: 'Routing-Standard', value: emptySelection },
              ...s.lines
                .filter((l) =>
                  store.descendants(item.factoryId).has(l.factoryId),
                )
                .map((l) => ({ label: l.name, value: l.id })),
            ]"
            :aria-label="'Ziel für ' + (item.task.title || item.id)"
            @update:model-value="
              s.queueTargets.set(item.id, selectionInput($event))
            "
          /><UButton
            :loading="s.routingBusy.has(item.id)"
            @click="store.assignTarget(item)"
            >Ziel setzen</UButton
          >
        </div>
      </article>
      <p v-if="s.queue && !s.queue.total">
        Noch keine Factory-Aufträge. Erstelle einen Auftrag, um seine Lieferung
        hier zu verfolgen.
      </p>
    </section>
  </details>
</template>
