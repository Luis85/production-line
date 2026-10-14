<script setup lang="ts">
import { computed, nextTick, watch } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import {
  emptySelection,
  selectionValue,
  selectionInput,
  type FactoryStore,
} from "../store";
const props = defineProps<{ store: FactoryStore }>(),
  s = props.store.state;
const options = computed(() => [
  {
    label:
      s.editor?.type === "factory"
        ? "Keine · oberste Ebene"
        : "Fabrik auswählen",
    value: emptySelection,
  },
  ...s.factories
    .filter(
      (f) =>
        s.editor?.type !== "factory" ||
        !s.editor.id ||
        !props.store.descendants(s.editor.id).has(f.id),
    )
    .map((f) => ({ label: props.store.factoryPath(f.id), value: f.id })),
]);
watch(
  () => s.editor,
  async (editor) => {
    if (editor) {
      await nextTick();
      document.getElementById(editor.type + "-name")?.focus();
    }
  },
);
watch(
  () => s.invalidField,
  async (id) => {
    if (id) {
      await nextTick();
      document.getElementById(id)?.focus();
    }
  },
);
</script>
<template>
  <section v-if="s.editor" class="editor" aria-labelledby="editor-title">
    <h2 id="editor-title">
      {{
        s.editor.type === "factory"
          ? s.editor.id
            ? "Fabrik bearbeiten oder verschieben"
            : "Fabrik anlegen"
          : s.editor.id
            ? "Produktionslinie bearbeiten oder verschieben"
            : "Produktionslinie registrieren"
      }}
    </h2>
    <p>
      {{
        store.factoryPath(
          s.editor.type === "factory" ? s.editor.parentId : s.editor.factoryId,
        ) || "Oberste Ebene"
      }}
      → {{ s.editor.name || "Neuer Eintrag"
      }}{{ s.editor.type === "line" ? " → bestehender Orchestrator" : "" }}
    </p>
    <p>
      {{
        s.editor.type === "factory"
          ? "Eine Fabrik gruppiert Linien und weitere Fabriken. Beim Verschieben bleiben Linien und Unterfabriken zugeordnet."
          : "Die Registrierung verbindet einen bestehenden Orchestrator. Sie startet keinen Server und überträgt keine laufenden Aufträge."
      }}
    </p>
    <form class="operation-form" @submit.prevent="store.saveEditor">
      <fieldset :disabled="s.saving">
        <label :for="s.editor.type + '-name'">Name</label
        ><UInput
          :id="s.editor.type + '-name'"
          :aria-invalid="
            s.invalidField === s.editor.type + '-name' ? 'true' : undefined
          "
          v-model="s.editor.name"
          required
          :maxlength="120"
        />
        <template v-if="s.editor.type === 'factory'"
          ><label for="factory-parent">Übergeordnete Fabrik</label
          ><USelect
            id="factory-parent"
            :model-value="selectionValue(s.editor.parentId)"
            @update:model-value="s.editor.parentId = selectionInput($event)"
            :items="options"
          /><small
            >Die eigene Fabrik und ihre Unterfabriken stehen beim Verschieben
            nicht zur Auswahl.</small
          ></template
        >
        <template v-else
          ><label for="line-factory">Fabrik</label
          ><USelect
            id="line-factory"
            :model-value="selectionValue(s.editor.factoryId)"
            @update:model-value="s.editor.factoryId = selectionInput($event)"
            :items="options"
            required
          /><label for="line-api">Orchestrator-URL für den Fabrikserver</label
          ><UInput
            id="line-api"
            :aria-invalid="s.invalidField === 'line-api' ? 'true' : undefined"
            v-model="s.editor.orchestratorUrl"
            type="url"
            required
            placeholder="http://orchestrator:4000"
          /><small>Interne, vom Fabrikserver erreichbare HTTP(S)-Adresse.</small
          ><label for="line-web">Webview-URL für deinen Browser</label
          ><UInput
            id="line-web"
            :aria-invalid="s.invalidField === 'line-web' ? 'true' : undefined"
            v-model="s.editor.webviewUrl"
            type="url"
            required
            placeholder="http://localhost:4000"
          /><label for="line-token-env"
            >Umgebungsvariable mit dem Linien-Zugangstoken</label
          ><UInput
            id="line-token-env"
            :aria-invalid="
              s.invalidField === 'line-token-env' ? 'true' : undefined
            "
            v-model="s.editor.tokenEnv"
            required
            pattern="WERK_LINE_[A-Z0-9_]+_TOKEN"
            placeholder="WERK_LINE_DEMO_TOKEN"
          /><small
            >Nur den Variablennamen eingeben. Den Tokenwert auf dem Fabrikserver
            hinterlegen.</small
          ></template
        >
        <p v-if="s.editorError" role="alert" class="error-text">
          {{ s.editorError }}
        </p>
        <div class="actions">
          <UButton type="submit" :loading="s.saving">{{
            s.editor.type === "factory" ? "Fabrik speichern" : "Linie speichern"
          }}</UButton
          ><UButton color="neutral" variant="outline" @click="s.editor = null"
            >Abbrechen</UButton
          >
        </div>
      </fieldset>
    </form>
  </section>
  <section
    v-if="s.deletion"
    class="confirmation"
    aria-labelledby="confirmation-title"
  >
    <h2 id="confirmation-title">
      {{
        s.deletion.type === "line" ? "Linie abmelden" : "Leere Fabrik löschen"
      }}
      · {{ s.deletion.name }}
    </h2>
    <p>
      {{
        s.deletion.type === "line"
          ? "Dies entfernt nur die Registrierung. Orchestrator, Worker und laufende Aufträge werden nicht gestoppt oder gelöscht."
          : "Nur leere Fabriken können gelöscht werden. Verschiebe oder entferne zuvor zugeordnete Linien und Unterfabriken. Die Server anderer Fabriken bleiben unverändert."
      }}
    </p>
    <p v-if="s.editorError" role="alert" class="error-text">
      {{ s.editorError }}
    </p>
    <div class="actions">
      <UButton color="error" :loading="s.saving" @click="store.removeConfirmed"
        >Bestätigen</UButton
      ><UButton
        color="neutral"
        variant="outline"
        :disabled="s.saving"
        @click="s.deletion = null"
        >Abbrechen</UButton
      >
    </div>
  </section>
</template>
