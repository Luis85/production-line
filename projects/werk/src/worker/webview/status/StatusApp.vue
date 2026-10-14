<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive } from "vue";
import UApp from "@nuxt/ui/components/App.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import { createDiagnosticStore, statusSummary } from "./store";
const props = defineProps<{ initial: unknown }>();
const model = createDiagnosticStore(props.initial, {
  reactive: (value) => reactive(value) as typeof value,
});
const state = model.state;
const summary = computed(() => statusSummary(state.snapshot));
const fields: Record<string, string> = {
  workerId: "Worker ID",
  project: "Project",
  state: "Process state",
  completedSimulations: "Acknowledged simulations (this process)",
  completedReviews: "Acknowledged change sets (this process)",
  lastContact: "Last orchestrator contact",
  lastError: "Latest error",
  updatedAt: "State recorded at",
  configurationHash: "Configuration hash",
  lastSnapshot: "Latest snapshot artifact",
  heartbeatErrors: "Heartbeat errors (this process)",
};
const timestamp = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString()
    : "Not recorded";
const freshness = computed(() =>
  state.offline
    ? "Exported " + timestamp(state.snapshot?.updatedAt)
    : state.failed
      ? "Live status unavailable · displayed values may be stale"
      : state.paused
        ? "Updates paused · last response " +
          (state.lastFetched === null
            ? "not received"
            : new Date(state.lastFetched).toLocaleTimeString())
        : state.lastFetched === null
          ? "Waiting for first response"
          : "Last response " + new Date(state.lastFetched).toLocaleTimeString(),
);
const contact = computed(() => {
  const value = state.snapshot?.lastContact;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    return "No orchestrator contact recorded";
  if (state.offline) return "Last orchestrator contact " + timestamp(value);
  const seconds = Math.max(
    0,
    ((state.lastFetched ?? Date.now()) - Date.parse(value)) / 1000,
  );
  return seconds > 60
    ? "Orchestrator contact older than 60 seconds"
    : `Orchestrator contacted ${Math.round(seconds)} seconds ago`;
});
let timer: ReturnType<typeof setInterval> | undefined;
function visible() {
  if (!document.hidden && !state.paused) void model.refresh();
}
onMounted(() => {
  if (!state.offline) {
    void model.refresh();
    timer = setInterval(visible, 3000);
    document.addEventListener("visibilitychange", visible);
  }
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
  document.removeEventListener("visibilitychange", visible);
  model.close();
});
</script>
<template>
  <UApp>
    <div class="diagnostic-page">
      <a class="skip-link" href="#main">Skip to content</a>
      <header class="diagnostic-header">
        <span class="wordmark">werk<span>.</span></span>
        <div v-if="!state.offline" class="actions">
          <a href="/status">JSON status</a>
          <UButton
            color="neutral"
            variant="outline"
            :loading="state.loading"
            @click="model.refresh()"
            >Refresh now</UButton
          >
          <UButton
            color="neutral"
            variant="outline"
            :aria-pressed="state.paused"
            @click="model.setPaused(!state.paused)"
            >{{ state.paused ? "Resume updates" : "Pause updates" }}</UButton
          >
        </div>
        <UBadge v-else color="neutral" variant="subtle">Static export</UBadge>
      </header>
      <main id="main" tabindex="-1">
        <div class="page-heading">
          <div>
            <h1>Worker status</h1>
            <p>Local process · read-only · {{ summary.execution }}</p>
          </div>
        </div>
        <p class="page-note">
          Provider profiles are configuration entries. This view does not verify
          subscription login or quota.
        </p>
        <p
          role="status"
          class="diagnostic-announcement"
          :class="{ 'error-text': state.failed }"
        >
          {{ state.announcement }}
        </p>
        <div class="diagnostic-summary">
          <strong>{{ summary.state }}</strong
          ><span>{{
            state.snapshot
              ? `${state.snapshot.activeTasks.length} / ${state.snapshot.maxParallel} task slots occupied`
              : "No capacity data"
          }}</span
          ><span>{{ freshness }}</span
          ><span>{{ contact }}</span>
        </div>
        <template v-if="state.snapshot">
          <section
            aria-label="Worker execution slots"
            class="diagnostic-section"
          >
            <div class="diagnostic-slots">
              <div
                v-for="slot in Math.min(state.snapshot.maxParallel, 24)"
                :key="slot"
                class="diagnostic-slot"
              >
                <strong
                  >Slot {{ slot }} ·
                  {{
                    state.snapshot.activeTasks[slot - 1]
                      ? "Occupied"
                      : "Unoccupied"
                  }}</strong
                ><span>{{
                  state.snapshot.activeTasks[slot - 1]
                    ? `${state.snapshot.activeTasks[slot - 1].id} · ${state.snapshot.activeTasks[slot - 1].profile ?? "Profile unknown"}`
                    : "No active attempt reported"
                }}</span>
              </div>
            </div>
            <p class="page-note">
              {{
                state.snapshot.maxParallel > 24
                  ? "First 24 configured slots shown. "
                  : ""
              }}Occupancy is observed locally. An unoccupied slot still needs an
              eligible profile and a healthy orchestrator connection.
            </p>
          </section>
          <section
            class="diagnostic-section"
            aria-labelledby="attempts-heading"
          >
            <h2 id="attempts-heading">Active attempts</h2>
            <div
              class="diagnostic-table"
              role="region"
              aria-label="Active attempts; scroll horizontally"
              tabindex="0"
            >
              <table>
                <caption>
                  Current process assignments
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Task</th>
                    <th scope="col">Attempt</th>
                    <th scope="col">Profile</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="task in state.snapshot.activeTasks"
                    :key="`${task.id}:${task.attempt}`"
                  >
                    <td>{{ task.id }}</td>
                    <td>{{ task.attempt }}</td>
                    <td>{{ task.profile ?? "Unknown" }}</td>
                  </tr>
                  <tr v-if="!state.snapshot.activeTasks.length">
                    <td colspan="3">No active attempts in this process.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
          <section class="diagnostic-section" aria-labelledby="health-heading">
            <h2 id="health-heading">Process &amp; health</h2>
            <dl>
              <template v-for="(label, key) in fields" :key="key"
                ><dt>{{ label }}</dt>
                <dd>
                  {{
                    ["lastContact", "updatedAt"].includes(String(key))
                      ? timestamp(state.snapshot[key])
                      : (state.snapshot[key] ?? "None")
                  }}
                </dd></template
              >
            </dl>
          </section>
          <section
            class="diagnostic-section"
            aria-labelledby="profiles-heading"
          >
            <h2 id="profiles-heading">Configured profiles</h2>
            <div
              class="diagnostic-table"
              role="region"
              aria-label="Configured profiles; scroll horizontally"
              tabindex="0"
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">Profile</th>
                    <th scope="col">Provider</th>
                    <th scope="col">Mode</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="profile in state.snapshot.profiles"
                    :key="profile.id"
                  >
                    <td>{{ profile.id }}</td>
                    <td>{{ profile.provider }}</td>
                    <td>{{ profile.mode }}</td>
                  </tr>
                  <tr v-if="!state.snapshot.profiles.length">
                    <td colspan="3">No profiles reported.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </template>
        <p class="page-note">
          {{ summary.result }} Simulation, change-set and heartbeat counters
          describe this process lifetime. The latest error is historical;
          current process state and last orchestrator contact show whether
          communication has recovered. Snapshot files contain attempt
          measurements; process resources overlap when tasks run in parallel.
        </p>
      </main>
      <footer class="workspace-footer">
        {{
          state.offline
            ? "Exported snapshot. Values do not update; this file does not contact the worker."
            : "Refreshes every 3 seconds while visible. A reachable status endpoint does not confirm a healthy orchestrator connection."
        }}
      </footer>
    </div>
  </UApp>
</template>
<style scoped>
.diagnostic-page {
  max-width: 1100px;
  margin: auto;
  padding: 32px;
}
.diagnostic-header,
.diagnostic-summary {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.diagnostic-header {
  justify-content: space-between;
  border-bottom: 1px solid var(--ui-border);
  padding-bottom: 24px;
}
.diagnostic-summary {
  border-block: 1px solid var(--ui-border);
  padding-block: 16px;
  color: var(--ui-text-muted);
}
.diagnostic-summary strong {
  color: var(--ui-text);
}
.diagnostic-section {
  margin-block: 32px;
}
.diagnostic-section h2 {
  margin-bottom: 16px;
}
.diagnostic-announcement {
  margin-block: 24px;
}
.diagnostic-slots {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
.diagnostic-slot {
  display: grid;
  gap: 8px;
  padding: 16px;
  background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  overflow-wrap: anywhere;
}
.diagnostic-slot span {
  color: var(--ui-text-muted);
}
.diagnostic-table {
  max-width: 100%;
  overflow: auto;
}
.diagnostic-table table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
}
.diagnostic-table td,
.diagnostic-table th {
  padding: 12px;
  border-bottom: 1px solid var(--ui-border);
  overflow-wrap: anywhere;
}
.diagnostic-table caption {
  text-align: left;
  color: var(--ui-text-muted);
  padding-bottom: 12px;
}
dl {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) 2fr;
  gap: 12px 24px;
}
dt {
  color: var(--ui-text-muted);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  .diagnostic-page {
    padding: 16px;
  }
  dl {
    grid-template-columns: 1fr;
    gap: 4px;
  }
  dd {
    margin-bottom: 12px;
  }
  .diagnostic-table th,
  .diagnostic-table td {
    min-width: 100px;
  }
}
</style>
