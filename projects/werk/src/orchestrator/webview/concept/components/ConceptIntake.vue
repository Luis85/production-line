<script setup lang="ts">
import { computed, ref } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import UTextarea from "@nuxt/ui/components/Textarea.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import UAlert from "@nuxt/ui/components/Alert.vue";
import { useConcept } from "../context";
const { state, engine, act, receipt, getDraft, navigate, openTask, openBoard } =
  useConcept();
const line = computed(
  () =>
    state.value.lines.find((item) => item.id === state.value.selectedLineId)!,
);
const draft = computed(() => getDraft(line.value.id));
const localError = ref(""),
  contextChecked = ref(false);
const resolution = computed(() =>
  engine.resolveContext(draft.value.links, line.value.projectId),
);
const imported = computed(
  () =>
    state.value.tasks.filter(
      (task) => task.lineId === line.value.id && task.sourceFeatureId,
    ).length,
);
function importIteration() {
  const count = act(() =>
    engine.importIterationFeatures(line.value.projectId, line.value.id),
  );
  if (count !== undefined) receipt.value = { lineId: line.value.id, count };
}
function submitReference() {
  localError.value = "";
  if (!draft.value.vaultRef.trim()) {
    localError.value = "Gib einen Wikilink ein.";
    return;
  }
  const task = act(() =>
    engine.addVaultTask(
      line.value.projectId,
      draft.value.vaultRef,
      line.value.id,
    ),
  );
  if (task) {
    draft.value.vaultRef = "";
    receipt.value = { lineId: line.value.id, taskId: task.id };
    openBoard();
    openTask(task.id);
  }
}
function submitManual() {
  localError.value = "";
  contextChecked.value = true;
  if (!resolution.value.ok) {
    localError.value = "Korrigiere fehlende oder mehrdeutige Kontextlinks.";
    return;
  }
  const task = act(() => {
    const manifest = engine.contextManifest({
      project: line.value.projectId,
      links: draft.value.links,
    });
    const task = engine.addTask({
      project: line.value.projectId,
      lineId: line.value.id,
      title: draft.value.title,
      criteria: draft.value.criteria,
      provider: draft.value.provider,
      priority: draft.value.priority,
    });
    task.context = manifest;
    task.intakeRevision = 1;
    engine.record(
      "FT-" +
        task.id +
        ": Kontextmanifest mit " +
        manifest.references.length +
        " Referenzen am Demo-Commit " +
        manifest.baseCommit.slice(0, 8) +
        " fixiert.",
      task,
    );
    return task;
  });
  if (task) {
    Object.assign(draft.value, { title: "", criteria: "", links: "" });
    receipt.value = { lineId: line.value.id, taskId: task.id };
    openBoard();
    openTask(task.id);
  }
}
function insertManualExample() {
  const note = engine.repoNotes(line.value.projectId)[0]!;
  Object.assign(draft.value, {
    title: note.path.split("/").at(-1)!.replace(/\.md$/, "") + " umsetzen",
    criteria:
      "Die Regeln aus der referenzierten Anforderung sind umgesetzt. Erfolgsfall, Grenzfälle und fehlende Berechtigung sind durch Tests belegt.",
    links:
      "[[" +
      note.path.replace(/\.md$/, "") +
      "#Regeln|Fachregeln]]\n[[architecture/System#Grenzen]]\n[[DoD#Checks]]",
  });
  contextChecked.value = false;
}
function appendNote(path: string) {
  draft.value.links +=
    (draft.value.links.trim() ? "\n" : "") +
    "[[" +
    path.replace(/\.md$/, "") +
    "]]";
  contextChecked.value = false;
}
function insertExample() {
  draft.value.vaultRef =
    "[[" +
    engine.repoNotes(line.value.projectId)[0]!.path.replace(/\.md$/, "") +
    "#Regeln]]";
}
</script>
<template>
  <div class="concept-intake">
    <section class="concept-section" aria-labelledby="iteration-title">
      <h2 id="iteration-title">Ready-Features aus der Wochenplanung</h2>
      <p>
        Projekt und Produktionslinie sind oben ausgewählt. Die Demo übernimmt
        zwei Ready-Features aus dem Iterationsbranch
        <code>iteration/2026-W42</code>, mit gepinntem Kontext und ohne
        Duplikate.
      </p>
      <div class="concept-inline">
        <UButton @click="importIteration">{{
          imported ? "Import erneut prüfen" : "2 Ready-Features importieren"
        }}</UButton
        ><span>{{ imported }} importierte Demo-Features in dieser Linie</span>
      </div>
      <div
        v-if="receipt?.lineId === line.id"
        class="concept-receipt"
        role="status"
      >
        <p>
          <strong>{{
            receipt.taskId
              ? "FT-" + receipt.taskId + " übernommen."
              : receipt.count
                ? receipt.count + " neue Features übernommen."
                : "Import geprüft. Keine neuen Features."
          }}</strong>
          Starte die simulierte Umsetzung im Taskboard mit „Nächster Takt“.
        </p>
        <UButton variant="outline" @click="openBoard()"
          >Zum Taskboard dieser Linie</UButton
        >
      </div>
      <details>
        <summary>Importvertrag und Beispielnotiz</summary>
        <p>
          Nur <code>factory_status: ready_for_implementation</code> wird
          übernommen. Projekt + Linie + Iteration + Feature-ID verhindern
          Duplikate. Eine geänderte Spezifikation braucht eine ausdrückliche
          Revision. Diese Demo liest ausschließlich Beispielnotizen.
        </p>
        <pre tabindex="0">
factory_id: REQ-241
factory_iteration: 2026-W42
factory_status: ready_for_implementation
factory_provider: auto</pre
        >
      </details>
    </section>
    <section class="concept-section" aria-labelledby="vault-title">
      <h2 id="vault-title">Requirement aus dem Vault einreichen</h2>
      <p>
        Ein Wikilink genügt. Die Notiz bleibt die fachliche Quelle; unbekannte
        Referenzen werden zur Klärung gespeichert. Akzeptanzkriterien werden
        nicht erfunden.
      </p>
      <form @submit.prevent="submitReference">
        <label for="requirementRef">Pfad im Projekt-Vault</label>
        <div class="concept-field-action">
          <UInput
            id="requirementRef"
            v-model="draft.vaultRef"
            placeholder="[[Features/Customer portal]]"
            maxlength="1000"
            required
          /><UButton type="submit">Requirement übernehmen</UButton>
        </div>
        <UButton variant="ghost" @click="insertExample"
          >Beispiel aus dem Demo-Vault einsetzen</UButton
        >
      </form>
    </section>
    <details
      class="concept-section"
      :open="draft.manualOpen"
      @toggle="draft.manualOpen = ($event.target as HTMLDetailsElement).open"
    >
      <summary>
        Einzelnes Feature mit eigenen Kriterien und Kontextlinks
      </summary>
      <div class="concept-inline">
        <UButton variant="outline" @click="insertManualExample"
          >Demo-Feature mit Kontext einsetzen</UButton
        >
      </div>
      <details>
        <summary>Notizen dieses Demo-Vaults</summary>
        <p>
          Füge nur ausdrücklich benötigte Notizen hinzu; identische Referenzen
          werden dedupliziert.
        </p>
        <div class="concept-inline">
          <UButton
            v-for="note in engine.repoNotes(line.projectId)"
            :key="note.path"
            variant="outline"
            @click="appendNote(note.path)"
            >{{ note.path }}</UButton
          >
        </div>
      </details>
      <form class="concept-form" @submit.prevent="submitManual">
        <label for="manualTitle">Feature-Titel</label
        ><UInput
          id="manualTitle"
          v-model="draft.title"
          maxlength="120"
          required
        />
        <label for="manualCriteria">Akzeptanzkriterien</label
        ><UTextarea
          id="manualCriteria"
          v-model="draft.criteria"
          maxlength="3000"
          :rows="4"
          required
        />
        <label for="manualLinks">Wikilinks · einer pro Zeile</label
        ><UTextarea
          id="manualLinks"
          v-model="draft.links"
          :rows="3"
          maxlength="12000"
          placeholder="[[requirements/Bestellfreigabe#Regeln]]"
        />
        <div class="concept-form-columns">
          <div>
            <label for="manualProvider">Provider</label
            ><USelect
              id="manualProvider"
              v-model="draft.provider"
              :items="[
                { value: 'auto', label: 'Automatisch' },
                { value: 'claude', label: 'Claude Code' },
                { value: 'codex', label: 'Codex' },
              ]"
            />
          </div>
          <div>
            <label for="manualPriority">Priorität</label
            ><USelect
              id="manualPriority"
              :model-value="String(draft.priority)"
              :items="[
                { value: '1', label: 'Normal' },
                { value: '2', label: 'Hoch' },
              ]"
              @update:model-value="draft.priority = Number($event)"
            />
          </div>
        </div>
        <div class="concept-inline">
          <UButton
            type="button"
            variant="outline"
            @click="contextChecked = true"
            >Kontext prüfen</UButton
          ><UButton type="submit">Feature einreichen</UButton>
        </div>
        <section
          v-if="contextChecked"
          aria-label="Kontextprüfung"
          aria-live="polite"
        >
          <p>
            {{
              resolution.ok
                ? "Kontext eindeutig aufgelöst · " +
                  resolution.entries.length +
                  " Referenzen"
                : "Kontext benötigt Korrektur"
            }}
          </p>
          <article
            v-for="entry in resolution.entries"
            :key="entry.raw"
            class="concept-reference"
          >
            <strong>{{ entry.raw }}</strong>
            <p v-if="entry.error">{{ entry.error }}</p>
            <pre v-else tabindex="0">{{ entry.excerpt }}</pre>
          </article>
        </section>
      </form>
    </details>
    <UAlert v-if="localError" color="error" :description="localError" />
    <ol class="concept-journey">
      <li>
        <h3>Iteration übernehmen</h3>
        <p>Ready-Features pinnen die Spezifikation am geplanten Git-Stand.</p>
      </li>
      <li>
        <h3>Umsetzung verfolgen</h3>
        <p>Demo-Worker liefern simulierte Checks und Snapshot-Paare.</p>
        <UButton variant="outline" @click="openBoard()"
          >Taskboard öffnen</UButton
        >
      </li>
      <li>
        <h3>Review und Merge</h3>
        <p>
          Erst die ausdrückliche menschliche Merge-Bestätigung schließt den
          Demo-Task.
        </p>
        <UButton variant="outline" @click="openBoard('review')"
          >Reviews öffnen</UButton
        >
      </li>
    </ol>
  </div>
</template>
