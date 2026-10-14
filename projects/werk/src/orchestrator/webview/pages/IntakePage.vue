<script setup lang="ts">
import { computed, watch } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UAlert from "@nuxt/ui/components/Alert.vue";
import type { OrchestratorStore } from "../store";
const { store } = defineProps<{ store: OrchestratorStore }>();
const s = store.state;
const manual = computed(
  () => s.intake.mode === "manual" || s.intake.executionMode === "cli",
);
watch(
  () => s.intake.executionMode,
  (value) => {
    if (value === "cli") {
      s.intake.mode = "manual";
      s.intake.provider = "codex";
    }
  },
);
const importCommand = computed(() =>
  /^[a-zA-Z0-9_-]{1,100}$/.test(s.intake.project) &&
  /^https?:\/\/[a-zA-Z0-9.:[\]-]+$/.test(location.origin)
    ? `node src/orchestrator/dist/orchestrator/cli.js iteration import --repo /path/to/project --branch iteration/2026-W42 --project ${s.intake.project} --iteration 2026-W42 --iteration-pr https://git.example/project/pull/10 --url ${location.origin}`
    : "Gültige Projekt-ID und HTTP(S)-Linienadresse erforderlich. Im Release-Ordner zeigt --help den Importvertrag.",
);
</script>
<template>
  <section id="intake" class="page-section">
    <UAlert
      v-if="!s.canWrite"
      title="Nur Lesezugriff"
      description="Für neue Aufträge mit einem Operator- oder Administrationstoken verbinden."
      color="neutral"
    />
    <div v-else class="intake-layout">
      <form
        id="task-form"
        class="form-stack"
        @submit.prevent="store.submitTask()"
      >
        <h2>Auftrag vorbereiten</h2>
        <p>Vault-Verweis oder Feature mit Akzeptanzkriterien übergeben.</p>
        <fieldset :disabled="s.submitting">
          <legend>Aufnahmeart</legend>
          <div class="actions">
            <UButton
              type="button"
              :variant="manual ? 'outline' : 'solid'"
              :disabled="s.intake.executionMode === 'cli'"
              :aria-pressed="!manual"
              @click="s.intake.mode = 'vault'"
              >Vault-Verweis</UButton
            ><UButton
              type="button"
              :variant="manual ? 'solid' : 'outline'"
              :aria-pressed="manual"
              @click="s.intake.mode = 'manual'"
              >Feature beschreiben</UButton
            >
          </div>
          <label for="project">Projekt-ID</label
          ><input
            id="project"
            v-model="s.intake.project"
            pattern="[a-zA-Z0-9_-]{1,100}"
            maxlength="100"
            required
            @input="s.intake.projectEdited = true"
          />
          <p class="muted">
            Projekt dieser Linie: {{ s.overview?.project || "Nicht gemeldet" }}.
            Eigene Eingaben bleiben erhalten.
          </p>
          <template v-if="!manual"
            ><label for="requirement-ref">Anforderung als Wikilink</label
            ><input
              id="requirement-ref"
              v-model="s.intake.requirementRef"
              maxlength="500"
              placeholder="[[Features/Customer portal]]"
              required
            />
            <p class="muted">
              Überschriften, Blockreferenzen und Aliase bleiben erhalten. Der
              Orchestrator fixiert den gelesenen Kontext am Commit.
            </p></template
          >
          <template v-else
            ><label for="title">Feature</label
            ><input
              id="title"
              v-model="s.intake.title"
              maxlength="200"
              required
              placeholder="Was soll sich ändern?"
            /><label for="criteria">Akzeptanzkriterien · eines pro Zeile</label
            ><textarea
              id="criteria"
              v-model="s.intake.criteria"
              rows="5"
              required
              placeholder="Woran erkennst du ein brauchbares Ergebnis?"
            ></textarea
            ><label for="wikilinks">Weitere Wikilinks · optional</label
            ><textarea
              id="wikilinks"
              v-model="s.intake.wikilinks"
              rows="2"
              placeholder="[[Kontext/Architektur]]"
            ></textarea>
          </template>
          <details>
            <summary>Ausführung und Priorität</summary>
            <label for="execution-mode">Ausführung</label
            ><select id="execution-mode" v-model="s.intake.executionMode">
              <option value="mock">Simulation · Standard</option>
              <option value="cli">Codex CLI · echte lokale Änderungen</option>
            </select>
            <p>
              CLI-Aufträge brauchen einen passenden Worker. Ergebnis ist ein
              lokaler Änderungssatz zum menschlichen Review. Kein automatischer
              Push, Pull Request oder Merge.
            </p>
            <label for="provider">Provider</label
            ><select
              id="provider"
              v-model="s.intake.provider"
              :disabled="s.intake.executionMode === 'cli'"
            >
              <option value="auto">Automatisch</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option></select
            ><label for="priority">Priorität</label
            ><select id="priority" v-model="s.intake.priority">
              <option value="1">Normal</option>
              <option value="2">Hoch</option>
            </select>
          </details>
          <UButton
            type="submit"
            :loading="s.submitting"
            :disabled="s.submitting"
            >Auftrag speichern</UButton
          >
        </fieldset>
      </form>
      <aside class="preview">
        <h2>Dein geplanter Auftrag</h2>
        <p class="preview-title">
          {{
            manual
              ? s.intake.title || "Noch kein Feature benannt"
              : s.intake.requirementRef || "Noch kein Vault-Verweis"
          }}
        </p>
        <p>Projekt: {{ s.intake.project }}</p>
        <ol>
          <li>Speichern im Orchestrator</li>
          <li>Reservierung durch passenden Worker</li>
          <li>
            {{
              s.intake.executionMode === "cli"
                ? "Lokalen Änderungssatz prüfen"
                : "Simulation und Snapshots prüfen"
            }}
          </li>
        </ol>
        <p v-if="manual">
          {{
            s.intake.criteria.split("\n").filter((v) => v.trim()).length
          }}
          Akzeptanzkriterien
        </p>
        <p>
          {{
            s.intake.executionMode === "cli"
              ? "Echte Ausführung ausgewählt. Tests und Abnahme bleiben zu prüfen."
              : "Simulation erstellt keinen Code oder Pull Request."
          }}
        </p>
      </aside>
    </div>
    <details>
      <summary>Bereitschaft der Linie prüfen</summary>
      <p v-if="s.readinessError" role="alert">{{ s.readinessError }}</p>
      <p>
        {{ s.overview?.workers?.online ?? "Unbekannt" }} Worker online ·
        {{
          s.readinessAt
            ? "Beobachteter Stand; passende Profile und freie Slots bleiben Voraussetzung."
            : "Noch nicht geprüft."
        }}
      </p>
      <div class="actions">
        <UButton
          color="neutral"
          :loading="s.readinessBusy"
          @click="store.checkReadiness()"
          >Bereitschaft prüfen</UButton
        ><UButton color="neutral" variant="outline" to="/workers"
          >Worker prüfen</UButton
        >
      </div>
    </details>
    <details>
      <summary>Ready-Features einer Iteration importieren</summary>
      <p>
        Der CLI-Import liest freigegebene Features aus dem Projekt. Gib die
        Adresse dieser Linie explizit an; Zugangsdaten gehören nicht in den
        Befehl.
      </p>
      <pre tabindex="0">{{ importCommand }}</pre>
      <p v-if="s.intakeSample">
        {{ s.intakeSample.imported }} importierte Features in der jüngsten
        geladenen Seite ({{ s.intakeSample.count }} Aufträge, maximal 50).
        {{
          s.intakeSample.hasMore
            ? "Weitere Aufträge sind nicht geladen; dies ist keine Gesamtzahl."
            : "Keine weitere Seite in diesem Lesestand."
        }}
      </p>
      <UButton color="neutral" variant="outline" to="/tasks"
        >Taskboard öffnen</UButton
      >
    </details>
  </section>
</template>
