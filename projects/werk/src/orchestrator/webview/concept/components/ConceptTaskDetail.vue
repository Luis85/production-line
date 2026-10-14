<script setup lang="ts">
import { computed, ref, watch } from "vue";
import USlideover from "@nuxt/ui/components/Slideover.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import { labels } from "../engine.mjs";
import { useConcept } from "../context";
const props = defineProps<{ taskId: number | null }>();
const emit = defineEmits<{ close: []; closeAutoFocus: [event: Event] }>();
const { state, engine, act } = useConcept();
const task = computed(() =>
  state.value.tasks.find((item) => item.id === props.taskId),
);
const correction = ref("");
watch(
  () => props.taskId,
  () => {
    correction.value = task.value?.requirementRef ?? "";
  },
);
function action(value: string) {
  if (task.value) act(() => engine.taskAction(task.value!.id, value));
}
function repair() {
  if (task.value)
    act(() => engine.reviseTaskRequirement(task.value!.id, correction.value));
}
</script>
<template>
  <USlideover
    :open="!!task"
    :content="{ onCloseAutoFocus: (event: Event) => emit('closeAutoFocus', event) }"
    :title="task ? 'FT-' + task.id + ' · ' + task.title : 'Feature'"
    description="Simulierter Versuch, Kontext und menschliche Review-Gates"
    @update:open="!$event && emit('close')"
  >
    <template #body>
      <div v-if="task" class="concept-task-detail">
        <div class="concept-inline">
          <UBadge variant="subtle">{{ labels[task.status] }}</UBadge
          ><span
            >{{ task.lineId }} · Versuch {{ task.attempt }} ·
            {{ engine.profileName(task.provider) }}</span
          >
        </div>
        <p v-if="task.criteria" class="concept-preserve">{{ task.criteria }}</p>
        <p v-else>
          Die referenzierte Requirement-Notiz bleibt die fachliche Quelle. Keine
          Akzeptanzkriterien erfunden.
        </p>
        <dl class="concept-facts">
          <div>
            <dt>Worker / Lease</dt>
            <dd>
              {{ task.worker ?? "Keiner" }} ·
              {{ task.lease ?? "Keine aktive Lease" }}
            </dd>
          </div>
          <div>
            <dt>Git-Ziel</dt>
            <dd>{{ task.iterationBranch }}</dd>
          </div>
          <div>
            <dt>Demo-PR</dt>
            <dd>{{ task.pr ? "#" + task.pr : "Noch keiner" }}</dd>
          </div>
          <div>
            <dt>Checks</dt>
            <dd>{{ task.check }} · simuliert</dd>
          </div>
        </dl>
        <p v-if="engine.waitReason(task)" class="concept-note">
          {{ engine.waitReason(task) }}
        </p>
        <div class="concept-inline">
          <UButton
            v-if="task.status === 'review' && !task.approved"
            @click="action('approve')"
            >Review freigeben</UButton
          >
          <UButton
            v-if="task.status === 'review'"
            :disabled="!task.approved || task.check !== 'passed'"
            @click="action('merge')"
            >Merge bestätigen</UButton
          >
          <UButton
            v-if="task.status === 'review'"
            variant="outline"
            @click="action('changes')"
            >Änderungen anfordern</UButton
          >
          <UButton
            v-if="task.status === 'review'"
            color="error"
            variant="outline"
            @click="action('closed')"
            >PR ohne Merge schließen</UButton
          >
          <UButton
            v-if="task.status === 'checks'"
            color="warning"
            variant="outline"
            @click="action('failed')"
            >Prüffehler simulieren</UButton
          >
          <UButton
            v-if="task.status === 'blocked'"
            :disabled="task.requirementResolution === 'unresolved'"
            @click="action('retry')"
            >Erneute Umsetzung freigeben</UButton
          >
        </div>
        <p v-if="task.status === 'review' && !task.approved">
          Merge benötigt deine Freigabe und erfolgreiche Checks am aktuellen
          Demo-Stand.
        </p>
        <form
          v-if="
            task.status === 'blocked' &&
            task.requirementResolution === 'unresolved' &&
            task.attempt === 0
          "
          class="concept-form"
          @submit.prevent="repair"
        >
          <label for="repairRequirementRef">Requirement-Pfad korrigieren</label
          ><UInput
            id="repairRequirementRef"
            v-model="correction"
            maxlength="1000"
            required
          />
          <p>
            Task und Linie bleiben erhalten. Beispiel: [[{{
              engine.repoNotes(task.project)[0]?.path.replace(/\.md$/, "")
            }}#Regeln]]
          </p>
          <UButton type="submit">Referenz prüfen und aktualisieren</UButton>
        </form>
        <section v-if="task.context" aria-label="Kontextmanifest">
          <h2>Versionierter Kontext</h2>
          <p>
            Git-Stand {{ task.context.baseCommit.slice(0, 8) }} ·
            {{ task.context.source }}
          </p>
          <details
            v-for="reference in task.context.references"
            :key="reference.raw"
          >
            <summary>{{ reference.raw }}</summary>
            <small
              >{{ reference.path
              }}{{ reference.anchor ? "#" + reference.anchor : "" }}</small
            >
            <pre tabindex="0">{{ reference.excerpt }}</pre>
          </details>
        </section>
        <section aria-label="Snapshots">
          <h2>Versuche und Snapshot-Paare</h2>
          <p v-if="!task.snapshots?.length">
            Noch keine Snapshots. Werte werden bei einem simulierten Versuch
            erfasst.
          </p>
          <details v-for="snapshot in task.snapshots ?? []" :key="snapshot.id">
            <summary>
              Versuch {{ snapshot.attempt }} ·
              {{ snapshot.phase === "before" ? "Vorher" : "Nachher" }} · Takt
              {{ snapshot.tick }}
            </summary>
            <p>{{ snapshot.artifactPath }} · {{ snapshot.source }}</p>
            <pre tabindex="0">{{ JSON.stringify(snapshot, null, 2) }}</pre>
          </details>
        </section>
        <section aria-label="Feature-Historie">
          <h2>Historie</h2>
          <ol class="concept-history">
            <li v-for="(entry, index) in task.history" :key="index">
              <small>Takt {{ entry.tick }}</small>
              <p>{{ entry.text }}</p>
            </li>
          </ol>
        </section>
      </div>
    </template>
  </USlideover>
</template>
