<script setup lang="ts">
import TaskConversationHistory from '../components/TaskConversationHistory.vue';
import RunEvidencePanel from '../components/RunEvidencePanel.vue';
import FeatureRequestsPanel from '../components/FeatureRequestsPanel.vue';
import Taskboard from '../components/Taskboard.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import USelect from '@nuxt/ui/components/Select.vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import UAlert from '@nuxt/ui/components/Alert.vue';
import UIcon from '@nuxt/ui/components/Icon.vue';
import { useHistoryPage } from "./useHistoryPage";
const {
  bytes,
  closeEvidence,
  date,
  duration,
  filter,
  filtered,
  inspect,
  options,
  outcome,
  page,
  pages,
  route,
  search,
  selected,
  selectedId,
  state,
  visible,
} = useHistoryPage();
</script>
<template>
  <section>
    <div class="page-heading">
      <div>
        <h1 tabindex="-1">History</h1>
        <p>Your chat tasks, file-task results and orchestrator evidence.</p>
      </div>
      <UBadge color="neutral" variant="subtle">
        {{ state.history?.rows.length ?? 0 }} orchestrator attempts
      </UBadge>
    </div>
    <nav class="history-views actions" aria-label="History views">
      <UButton to="/history" color="neutral" :variant="!route.query.view ? 'solid' : 'outline'">Task history</UButton>
      <UButton to="/history?view=features" color="neutral" :variant="route.query.view === 'features' ? 'solid' : 'outline'">Project requests</UButton>
      <UButton to="/history?view=runs" color="neutral" :variant="route.query.view === 'runs' ? 'solid' : 'outline'">Execution evidence</UButton>
    </nav>
    <RunEvidencePanel v-if="state.unlocked && (route.query.view === 'runs' || route.query.runSession)" />
    <FeatureRequestsPanel v-if="state.unlocked && route.query.view === 'features'" />
    <div v-show="route.query.view !== 'runs' && route.query.view !== 'features'">
    <TaskConversationHistory />
    <Taskboard />
    <h2 class="monitor-section">Orchestrator attempt history</h2>
    <UAlert
      v-if="state.history?.limited || state.history?.unreadable"
      title="Some evidence is not shown"
      :description="`${state.history.limited ? 'The view inspected 1,000 snapshot directories. This is a sample, not the full history. ' : ''}${state.history.unreadable ? state.history.unreadable + ' snapshot pairs could not be read. Check the worker journal.' : ''}`"
      color="warning"
      variant="soft"
      class="notice"
    />
    <div v-if="state.history?.rows.length" class="history-filters">
      <div>
        <label for="history-search">Find an orchestrator attempt</label>
        <UInput
          id="history-search"
          v-model="search"
          icon="i-lucide-search"
          placeholder="Title, task ID, project, feature or profile"
          class="w-full"
        />
      </div>
      <div>
        <label for="history-outcome">Outcome</label>
        <USelect id="history-outcome" v-model="filter" :items="options" class="w-full" />
      </div>
    </div>
    <div v-if="!state.unlocked" class="empty-state">
      <UIcon name="i-lucide-lock-keyhole" />
      <h2>Task history is private</h2>
      <p>Unlock this worker to inspect retained attempts and their evidence.</p>
    </div>
    <div v-else-if="!state.history" class="empty-state" role="status">
      <p>Loading task history…</p>
    </div>
    <div v-else-if="!filtered.length" class="compact-empty">
      <UIcon name="i-lucide-history" />
      <h2>{{ state.history.rows.length ? 'No matching attempts' : 'No retained attempts yet' }}</h2>
      <p>
        {{
          state.history.rows.length
            ? 'Try another task ID or show all outcomes.'
            : 'Assigned tasks appear here when the worker records its first snapshot. Retained evidence survives worker restarts.'
        }}
      </p>
      <UButton
        v-if="state.history.rows.length"
        color="neutral"
        variant="outline"
        @click="
          search = '';
          filter = 'all';
        "
      >
        Clear filters
      </UButton>
    </div>
    <template v-else>
      <div
        class="table-scroll history-table"
        tabindex="0"
        role="region"
        aria-label="Task attempt history"
      >
        <table>
          <thead>
            <tr>
              <th>Task / attempt</th>
              <th>Outcome</th>
              <th>Profile</th>
              <th>Started</th>
              <th>Duration</th>
              <th><span class="sr-only">Evidence</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in visible"
              :key="row.pairId"
              :class="{ selected: selectedId === row.pairId }"
            >
              <td>
                <strong class="task-id">
                  {{ row.title || row.provenance.featureId || row.taskId }}
                </strong>
                <span class="muted">Attempt {{ row.attempt }} · {{ row.project }}</span>
              </td>
              <td>
                <UBadge
                  :color="
                    row.outcome === 'failed'
                      ? 'error'
                      : row.outcome === 'simulated'
                        ? 'warning'
                        : 'neutral'
                  "
                  variant="subtle"
                >
                  {{ outcome(row.outcome) }}
                </UBadge>
              </td>
              <td>
                {{ row.profile }}
                <span class="muted">{{ row.mode === 'mock' ? 'Simulation' : 'Live Codex' }}</span>
              </td>
              <td>{{ date(row.startedAt) }}</td>
              <td class="numeric">{{ duration(row.durationMs) }}</td>
              <td>
                <UButton
                  color="neutral"
                  variant="outline"
                  :aria-label="`Inspect task ${row.taskId}, attempt ${row.attempt}`"
                  :aria-expanded="selectedId === row.pairId"
                  :data-attempt="row.pairId"
                  aria-controls="attempt-evidence"
                  @click="inspect(row.pairId, $event)"
                >
                  Inspect
                </UButton>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="mobile-attempts">
        <article v-for="row in visible" :key="row.pairId" class="mobile-attempt">
          <strong>{{ row.title || row.provenance.featureId || row.taskId }}</strong>
          <p>
            Attempt {{ row.attempt }} · {{ row.profile }}
            <br />
            {{ date(row.startedAt) }} · {{ duration(row.durationMs) }}
          </p>
          <div class="actions">
            <UBadge
              :color="
                row.outcome === 'failed'
                  ? 'error'
                  : row.outcome === 'simulated'
                    ? 'warning'
                    : 'neutral'
              "
              variant="subtle"
            >
              {{ outcome(row.outcome) }}
            </UBadge>
            <UButton
              color="neutral"
              variant="outline"
              :aria-label="`Inspect task ${row.taskId}, attempt ${row.attempt}`"
              :aria-expanded="selectedId === row.pairId"
              :data-attempt="row.pairId"
              aria-controls="attempt-evidence"
              @click="inspect(row.pairId, $event)"
            >
              Inspect
            </UButton>
          </div>
        </article>
      </div>
      <div class="pagination">
        <span>
          {{ filtered.length }} matching {{ filtered.length === 1 ? 'attempt' : 'attempts' }} · Page
          {{ page }} of {{ pages }}
        </span>
        <div class="actions">
          <UButton color="neutral" variant="outline" :disabled="page === 1" @click="page--">
            Previous
          </UButton>
          <UButton color="neutral" variant="outline" :disabled="page >= pages" @click="page++">
            Next
          </UButton>
        </div>
      </div>
    </template>
    <section
      v-if="selected"
      id="attempt-evidence"
      class="evidence-panel"
      aria-labelledby="evidence-title"
    >
      <div class="section-heading">
        <h2 id="evidence-title" tabindex="-1">Attempt {{ selected.attempt }} evidence</h2>
        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-x"
          aria-label="Close attempt evidence"
          @click="closeEvidence()"
        />
      </div>
      <p class="break-anywhere">{{ selected.taskId }}</p>
      <div class="evidence-flow">
        <div>
          <UIcon name="i-lucide-file-input" />
          <strong>Before execution</strong>
          <span>{{ date(selected.startedAt) }}</span>
        </div>
        <UIcon name="i-lucide-arrow-right" class="flow-arrow" />
        <div>
          <UIcon name="i-lucide-cpu" />
          <strong>{{ outcome(selected.outcome) }}</strong>
          <span>{{ duration(selected.durationMs) }}</span>
        </div>
        <UIcon name="i-lucide-arrow-right" class="flow-arrow" />
        <div>
          <UIcon name="i-lucide-file-check" />
          <strong>{{ selected.completePair ? 'Pair recorded' : 'Pair incomplete' }}</strong>
          <span>{{ date(selected.finishedAt) }}</span>
        </div>
      </div>
      <p v-if="selected.error" class="error-text">{{ selected.error }}</p>
      <dl class="facts">
        <div>
          <dt>Worker-process RSS at snapshot</dt>
          <dd>{{ bytes(selected.resources.rssBytes) }}</dd>
        </div>
        <div>
          <dt>Quality gate</dt>
          <dd>{{ selected.quality.gate.replaceAll('_', ' ') }}</dd>
        </div>
        <div>
          <dt>Provider usage</dt>
          <dd>{{ selected.usage.reason }}</dd>
        </div>
        <div v-if="selected.review">
          <dt>Review artifact</dt>
          <dd>{{ selected.review.artifactPath }}</dd>
        </div>
      </dl>
      <p v-if="selected.mode === 'mock'" class="page-note">
        This attempt was simulated. It does not represent implemented code or a completed PR.
      </p>
      <details>
        <summary>Full recorded evidence</summary>
        <pre>{{ JSON.stringify(selected, null, 2) }}</pre>
      </details>
    </section>
    <p v-else-if="selectedId" class="page-note" role="status">
      The selected attempt is no longer in the retained history.
    </p>
    <p v-if="state.history?.rows.length" class="page-note">
      Orchestrator history is local to this worker and follows its journal retention policy ({{
        state.history?.retainedPairs ?? '…'
      }}
      acknowledged pairs). Older attempts may have been pruned. Snapshot measurements describe the
      worker process. This worker executes one task at a time.
    </p>
    </div>
  </section>
</template>
