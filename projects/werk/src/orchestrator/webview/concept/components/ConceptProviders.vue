<script setup lang="ts">
import { computed, reactive } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import UTextarea from "@nuxt/ui/components/Textarea.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import { type Worker } from "../engine.mjs";
import { useConcept } from "../context";
const { state, engine, act } = useConcept();
const workers = computed(() =>
  state.value.workers.filter(
    (worker) => worker.lineId === state.value.selectedLineId,
  ),
);
const configs = reactive<
  Record<
    string,
    {
      parallel: string;
      timeout: string;
      prompt: string;
      limits: Record<string, string>;
    }
  >
>({});
const providerChoice = reactive<Record<string, string>>({});
function config(worker: Worker) {
  return (configs[worker.id] ??= {
    parallel: String(worker.maxParallel ?? 1),
    timeout: String(worker.timeoutSeconds ?? 900),
    prompt:
      worker.systemPrompt ??
      "Implementiere das Feature anhand des versionierten Projektkontexts. Liefere prüfbare Nachweise.",
    limits: Object.fromEntries(
      worker.profiles.map((profile) => [
        profile.id,
        String(profile.maxParallel),
      ]),
    ),
  });
}
function configure(id: string) {
  const worker = engine.data.workers.find((item) => item.id === id)!,
    values = config(worker);
  act(() =>
    engine.applyWorkerConfiguration(worker, {
      maxParallel: Number(values.parallel),
      timeoutSeconds: Number(values.timeout),
      systemPrompt: values.prompt,
      profiles: worker.profiles.map((profile) => ({
        id: profile.id,
        maxParallel: Number(values.limits[profile.id] ?? profile.maxParallel),
      })),
    }),
  );
}
function addWorker() {
  const line = engine.selectedLine();
  act(() => engine.addWorker(line.projectId, line.id));
}
function addProfile(id: string) {
  act(() => engine.addProfile(id, providerChoice[id] ?? "claude"));
}
</script>
<template>
  <section aria-label="Worker und Provider">
    <div class="concept-section-heading">
      <div>
        <h2>Eine Maschine, getrennte lokale Provider-Profile</h2>
        <p>
          Alle Logins und Limits sind simuliert. Mehr Profile erhöhen die
          Maschinenkapazität nicht automatisch.
        </p>
      </div>
      <UButton @click="addWorker"
        >Demo-Worker für diese Linie registrieren</UButton
      >
    </div>
    <p v-if="!workers.length" class="concept-empty">
      Dieser Produktionslinie ist noch kein Worker zugewiesen. Registriere einen
      Demo-Worker oder weise einen freien Worker in Factories zu.
    </p>
    <article v-for="worker in workers" :key="worker.id" class="concept-worker">
      <div class="concept-section-heading">
        <div>
          <h2>{{ worker.id }}</h2>
          <p>
            {{ engine.workerStatus(worker) }} ·
            {{ engine.workerTasks(worker).length }} /
            {{ worker.maxParallel ?? 1 }} Maschinenslots
          </p>
        </div>
        <div class="concept-inline">
          <UButton
            variant="outline"
            @click="act(() => engine.updateWorker(worker.id, 'online'))"
            >{{
              worker.online ? "Ausfall simulieren" : "Online setzen"
            }}</UButton
          ><UButton
            variant="outline"
            @click="act(() => engine.updateWorker(worker.id, 'pause'))"
            >{{
              worker.paused ? "Zuweisung fortsetzen" : "Zuweisung pausieren"
            }}</UButton
          ><UButton
            variant="outline"
            @click="act(() => engine.updateWorker(worker.id, 'quota'))"
            >{{
              worker.quota
                ? "Maschinenlimit aufheben"
                : "Maschinenlimit simulieren"
            }}</UButton
          >
        </div>
      </div>
      <details>
        <summary>
          Worker konfigurieren · Version {{ worker.configVersion ?? 1 }}
        </summary>
        <form class="concept-form" @submit.prevent="configure(worker.id)">
          <div class="concept-form-columns">
            <div>
              <label :for="'parallel-' + worker.id">Parallele Tasks</label
              ><UInput
                :id="'parallel-' + worker.id"
                v-model="config(worker).parallel"
                type="number"
                min="1"
                max="8"
                required
              />
            </div>
            <div>
              <label :for="'timeout-' + worker.id"
                >Timeout pro Versuch (Sekunden)</label
              ><UInput
                :id="'timeout-' + worker.id"
                v-model="config(worker).timeout"
                type="number"
                min="60"
                max="3600"
                required
              />
            </div>
          </div>
          <label :for="'prompt-' + worker.id">Systemprompt</label
          ><UTextarea
            :id="'prompt-' + worker.id"
            v-model="config(worker).prompt"
            maxlength="20000"
            required
          />
          <div v-for="profile in worker.profiles" :key="profile.id">
            <label :for="'limit-' + profile.id"
              >{{ engine.profileName(profile.provider) }} · parallele
              Sessions</label
            ><UInput
              :id="'limit-' + profile.id"
              :model-value="
                config(worker).limits[profile.id] ?? String(profile.maxParallel)
              "
              type="number"
              min="1"
              max="8"
              @update:model-value="
                config(worker).limits[profile.id] = String($event)
              "
            />
          </div>
          <p>
            Nur freie Worker übernehmen eine neue Konfiguration. Laufende
            Versuche behalten ihre Version. Dies ist keine echte CLI-Ausführung.
          </p>
          <UButton
            type="submit"
            :disabled="engine.workerTasks(worker).length > 0"
            >Konfiguration übernehmen</UButton
          >
        </form>
      </details>
      <div
        v-for="profile in worker.profiles"
        :key="profile.id"
        class="concept-profile"
      >
        <div>
          <h3>{{ engine.profileName(profile.provider) }}</h3>
          <small
            >{{ profile.id }} · {{ profile.maxParallel }} Profil-Slot(s)</small
          >
        </div>
        <UBadge
          :color="
            engine.profileState(profile) === 'Bereit' ? 'success' : 'warning'
          "
          variant="subtle"
          >{{ engine.profileState(profile) }}</UBadge
        >
        <div class="concept-inline">
          <UButton
            size="sm"
            variant="outline"
            @click="
              act(() => engine.setProfileState(worker.id, profile.id, 'enable'))
            "
            >{{ profile.enabled ? "Deaktivieren" : "Aktivieren" }}</UButton
          ><UButton
            size="sm"
            variant="outline"
            @click="
              act(() => engine.setProfileState(worker.id, profile.id, 'limit'))
            "
            >{{
              profile.limited ? "Limit aufheben" : "Limit simulieren"
            }}</UButton
          ><UButton
            size="sm"
            variant="outline"
            @click="
              act(() => engine.setProfileState(worker.id, profile.id, 'auth'))
            "
            >{{
              profile.authenticated
                ? "Login-Verlust simulieren"
                : "Anmeldung simulieren"
            }}</UButton
          >
        </div>
      </div>
      <div class="concept-field-action">
        <label :for="'add-profile-' + worker.id"
          >Weiteres Subscription-Profil</label
        ><USelect
          :id="'add-profile-' + worker.id"
          :model-value="providerChoice[worker.id] ?? 'claude'"
          :items="[
            { value: 'claude', label: 'Claude Code' },
            { value: 'codex', label: 'Codex' },
          ]"
          @update:model-value="providerChoice[worker.id] = String($event)"
        /><UButton variant="outline" @click="addProfile(worker.id)"
          >Demo-Profil hinzufügen</UButton
        >
      </div>
    </article>
    <p class="concept-note">
      Cursor ist in diesem Modell nicht verfügbar. Providerspezifische Sessions
      wechseln nicht zwischen Adaptern; unbekannte Subscription-Restkontingente
      bleiben unbekannt.
    </p>
  </section>
</template>
